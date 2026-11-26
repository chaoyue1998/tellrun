import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { z } from "zod";
import type {
  Agent,
  AgentAttachment,
  AgentMessage,
  AgentModel,
  AgentOption,
  AgentResult,
  AgentSessionHistory,
  AgentUsage,
  AgentUsageGroup,
  AgentUsageWindow,
  InteractionAnswer,
} from "../core/types.js";
import { AgentError, listPageSize } from "../core/types.js";
import { type AgyContentBlock, createAgyInput } from "./agy-input.js";
import { type AgyApprovalResponse, parseAgyInteraction } from "./agy-interaction.js";
import { type AgyRpc, type AgyRpcMessage, createAgyRpc } from "./agy-rpc.js";
import { loadAgentEnv } from "./env.js";

/** Antigravity ACP 支持的执行模式；与 session/new 返回的 availableModes 对应。 */
const permissionModes = [
  { id: "default", label: "Default (Ask for approval)" },
  { id: "accept-edits", label: "Accept edits" },
  { id: "auto", label: "Auto" },
  { id: "plan", label: "Plan" },
] as const;

const defaultSessionName = "New session";

/** 推理档位按常见梯度排序；用于将 flat modelId 拆分为模型与推理档位两级菜单。 */
const knownEfforts = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra" },
  { id: "max", label: "Max" },
] as const;

const knownEffortIds = new Set<string>(knownEfforts.map((item) => item.id));

const sessionListSchema = z.object({
  sessions: z
    .array(
      z.object({
        sessionId: z.string().min(1),
        cwd: z.string(),
        title: z.string().nullish(),
        updatedAt: z.string().nullish(),
      }),
    )
    .default([]),
  nextCursor: z.string().nullish(),
});

const configSelectOptionSchema = z.object({
  value: z.string().min(1),
  name: z.string().nullish(),
});

const sessionCatalogMetaSchema = z.object({
  models: z
    .object({
      availableModels: z
        .array(z.object({ modelId: z.string().min(1), name: z.string().nullish() }))
        .nullish()
        .transform((value) =>
          (value ?? []).map((item) => ({
            modelId: item.modelId,
            name: item.name ?? item.modelId,
          })),
        ),
      currentModelId: z.string().min(1).nullish(),
    })
    .nullish(),
  configOptions: z
    .array(
      z.object({
        id: z.string().min(1),
        currentValue: z.string().nullish(),
        options: z.unknown().optional(),
      }),
    )
    .nullish(),
  _meta: z
    .object({
      antigravity: z
        .object({
          tier: z.object({ name: z.string().min(1) }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const sessionNewSchema = sessionCatalogMetaSchema.extend({
  sessionId: z.string().min(1),
});

const sessionResumeSchema = sessionCatalogMetaSchema.extend({
  sessionId: z.string().min(1).nullish(),
});

/** agy --output-format json --print=/usage 的结构化配额输出。 */
const agyUsageOutputSchema = z.object({
  status: z.string(),
  command: z
    .object({
      name: z.string(),
      data: z.object({
        groups: z.array(
          z.object({
            name: z.string(),
            buckets: z.array(
              z.object({
                id: z.string().nullish(),
                name: z.string(),
                window: z.string().nullish(),
                remaining_fraction: z.number(),
                reset_time: z.string().nullish(),
              }),
            ),
          }),
        ),
      }),
    })
    .nullish(),
});

const sessionUpdateSchema = z.object({
  sessionId: z.string().min(1),
  update: z.object({
    sessionUpdate: z.string(),
    content: z
      .object({
        type: z.string(),
        text: z.string().optional(),
      })
      .optional(),
  }),
});

const promptResponseSchema = z.object({
  stopReason: z.string().optional(),
});

interface ModelCatalog {
  models: AgentModel[];
  availableModels: { modelId: string; name: string }[];
  currentModelId: string | null;
  tierName: string | null;
  fetchedAt: number;
}

interface SessionSubscriber {
  onUpdate: (update: z.infer<typeof sessionUpdateSchema>["update"]) => void;
  onRequest?: (message: AgyRpcMessage & { id: string | number; method: string }) => void;
  onDisconnect?: (reason: string) => void;
}

interface TaskRuntime {
  sessionId?: string;
  promptDispatched: boolean;
  activePrompt?: string;
  controller: AbortController;
  steer?: (prompt: string, attachments?: AgentAttachment[]) => Promise<void>;
  respond?: (id: string, answer: InteractionAnswer) => Promise<boolean>;
}

/** 兼容平铺与分组结构的 ACP configOption 选项提取，避免非 select 配置项导致解析失败。 */
function extractSelectOptions(raw: unknown): { value: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const extracted: { value: string; name: string }[] = [];
  for (const item of raw) {
    const direct = configSelectOptionSchema.safeParse(item);
    if (direct.success) {
      extracted.push({
        value: direct.data.value,
        name: direct.data.name || direct.data.value,
      });
      continue;
    }
    if (
      typeof item === "object" &&
      item !== null &&
      "options" in item &&
      Array.isArray(item.options)
    ) {
      extracted.push(...extractSelectOptions(item.options));
    }
  }
  return extracted;
}

/** 从 ACP session/new 或 session/resume 返回的 models 与 configOptions 构建模型目录。 */
function parseModelCatalog(meta: z.infer<typeof sessionCatalogMetaSchema>): ModelCatalog {
  const availableModels = meta.models?.availableModels ?? [];
  const currentModelId = meta.models?.currentModelId ?? null;
  const modelOption = meta.configOptions?.find((item) => item.id === "model");
  const thoughtOption = meta.configOptions?.find((item) => item.id === "thought_level");
  const modelOptions = extractSelectOptions(modelOption?.options);
  const thoughtOptions = extractSelectOptions(thoughtOption?.options);
  const effortLabels = new Map<string, string>(knownEfforts.map((item) => [item.id, item.label]));
  for (const item of thoughtOptions) {
    effortLabels.set(item.value, item.name || item.value);
  }

  const models: AgentModel[] = [];
  if (modelOptions.length) {
    for (const base of modelOptions) {
      const matchedEfforts: AgentOption[] = [];
      for (const variant of availableModels) {
        if (!variant.modelId.startsWith(`${base.value}-`)) continue;
        const suffix = variant.modelId.slice(base.value.length + 1);
        if (!knownEffortIds.has(suffix)) continue;
        if (!matchedEfforts.some((item) => item.id === suffix)) {
          matchedEfforts.push({ id: suffix, label: effortLabels.get(suffix) ?? suffix });
        }
      }
      const orderedEfforts = matchedEfforts.sort((a, b) => {
        const ai = knownEfforts.findIndex((item) => item.id === a.id);
        const bi = knownEfforts.findIndex((item) => item.id === b.id);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });
      const currentEffort = currentModelId?.startsWith(`${base.value}-`)
        ? currentModelId.slice(base.value.length + 1)
        : undefined;
      const defaultEffort =
        (currentEffort && orderedEfforts.some((item) => item.id === currentEffort)
          ? currentEffort
          : undefined) ??
        (orderedEfforts.some((item) => item.id === "high") ? "high" : undefined) ??
        orderedEfforts[0]?.id ??
        "";
      models.push({
        id: base.value,
        label: base.name || base.value,
        reasoningEfforts: orderedEfforts,
        defaultReasoningEffort: defaultEffort,
      });
    }
  } else {
    for (const item of availableModels) {
      models.push({
        id: item.modelId,
        label: item.name || item.modelId,
        reasoningEfforts: [],
        defaultReasoningEffort: "",
      });
    }
  }

  return {
    models,
    availableModels,
    currentModelId,
    tierName: meta._meta?.antigravity?.tier?.name ?? null,
    fetchedAt: Date.now(),
  };
}

/** 格式化 agy 配额窗口标签，与 Codex 保持一致的阅读体验。 */
function formatAgyWindowLabel(window: string | null | undefined, fallback: string) {
  if (window === "5h") return "5-hour limit";
  if (window === "weekly") return "Weekly limit";
  if (window === "daily") return "Daily limit";
  return fallback;
}

/** 解析 agy --print=/usage 输出中的 JSON 负载，兼容前置/尾部日志行与多行格式化 JSON。 */
function parseAgyUsageJson(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Empty usage output.");
  try {
    return agyUsageOutputSchema.parse(JSON.parse(trimmed));
  } catch {
    const lines = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line?.startsWith("{")) continue;
      try {
        return agyUsageOutputSchema.parse(JSON.parse(line));
      } catch {
        /** 忽略非配额 JSON 诊断行，继续向前查找。 */
      }
    }
    for (let end = trimmed.lastIndexOf("}"); end > 0; end = trimmed.lastIndexOf("}", end - 1)) {
      if (end < trimmed.length - 1 && trimmed[end + 1] !== "\n" && trimmed[end + 1] !== "\r") {
        continue;
      }
      for (
        let pos = trimmed.lastIndexOf("{", end);
        pos >= 0;
        pos = trimmed.lastIndexOf("{", pos - 1)
      ) {
        if (pos > 0 && trimmed[pos - 1] !== "\n") continue;
        try {
          return agyUsageOutputSchema.parse(JSON.parse(trimmed.slice(pos, end + 1)));
        } catch {
          /** 当前块非完整配额 JSON，继续向前尝试。 */
        }
      }
    }
    throw new Error("Invalid usage JSON.");
  }
}

/** 将用户选择的模型与推理档位映射为 ACP modelId 或配置项。 */
function resolveModelConfig(
  selection: { model: string | null; reasoningEffort: string | null },
  catalog?: ModelCatalog,
): { modelId?: string; configModel?: string; configEffort?: string } {
  const { model, reasoningEffort } = selection;
  if (!model && !reasoningEffort) return {};
  const availableIds = new Set(catalog?.availableModels.map((item) => item.modelId) ?? []);
  if (model && reasoningEffort) {
    const combined = `${model}-${reasoningEffort}`;
    if (availableIds.has(combined)) return { modelId: combined };
    return { configModel: model, configEffort: reasoningEffort };
  }
  if (model) {
    if (availableIds.has(model)) return { modelId: model };
    const matched = catalog?.models.find((item) => item.id === model);
    if (matched?.defaultReasoningEffort) {
      const combined = `${model}-${matched.defaultReasoningEffort}`;
      if (availableIds.has(combined)) return { modelId: combined };
    }
    return { configModel: model };
  }
  return reasoningEffort ? { configEffort: reasoningEffort } : {};
}

/** 规范化单行会话标题，避免换行撑乱 Telegram 按钮。 */
function formatSessionLabel(title: string | null | undefined, fallback = "Untitled session") {
  const value = title?.trim() || fallback;
  return value.replace(/\s+/gu, " ").slice(0, 120);
}

/** 通过 Antigravity CLI 的 ACP stdio 服务器接入 Agent 能力。 */
export async function createAgyAgent(command = "agy"): Promise<Agent> {
  const { env, unavailableReason } = await loadAgentEnv("Antigravity");
  const { stdout } = unavailableReason
    ? { stdout: "" }
    : await promisify(execFile)(command, ["--version"], {
        timeout: 5_000,
        maxBuffer: 4_096,
        env,
      });
  const firstLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const versionText = (firstLine ?? "")
    .replace(/^agy(?:-cli)?\s+/i, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    !unavailableReason &&
    (!versionText || versionText.length > 128 || /\p{Cc}/u.test(versionText))
  ) {
    throw new Error("Unrecognized Antigravity CLI version.");
  }

  const maxOpenSessions = 100;
  const maxCreatedSessions = 50;

  let sharedRpc: AgyRpc | undefined;
  let pendingInitRpc: AgyRpc | undefined;
  let startingRpc: Promise<AgyRpc> | undefined;
  let rpcGeneration = 0;
  const activeIsolatedRpcs = new Set<AgyRpc>();
  let cachedCatalog: ModelCatalog | undefined;
  const pendingCatalogs = new Map<string, Promise<ModelCatalog>>();
  const tasks = new Map<number, TaskRuntime>();
  const subscribers = new Map<string, Set<SessionSubscriber>>();
  /** 记录本进程中已加载到共享 ACP 服务的会话，避免重复 resume。 */
  const openSessions = new Set<string>();
  /** 尚未发送首条消息的 /new 会话不会出现在 session/list 中，在内存中保留元数据。 */
  const createdSessions = new Map<string, { cwd: string; label: string }>();

  /** 将任意 Promise 与 AbortSignal 竞争，不改变底层请求生命周期。 */
  function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled."));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("Request cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /** 仅在返回有效模型目录时覆盖缓存，避免空元数据响应清空可用目录或丢失套餐名。 */
  function updateCachedCatalog(
    meta: z.infer<typeof sessionCatalogMetaSchema>,
  ): ModelCatalog | undefined {
    const parsed = parseModelCatalog(meta);
    const hasModels = parsed.models.length > 0 || parsed.availableModels.length > 0;
    if (hasModels) {
      cachedCatalog = {
        ...parsed,
        tierName: parsed.tierName ?? cachedCatalog?.tierName ?? null,
      };
      return cachedCatalog;
    }
    if (parsed.tierName && cachedCatalog) {
      cachedCatalog = {
        ...cachedCatalog,
        tierName: parsed.tierName,
      };
    }
    return cachedCatalog;
  }

  function activeTaskSessionIds() {
    const active = new Set<string>();
    for (const task of tasks.values()) {
      if (task.sessionId) active.add(task.sessionId);
    }
    return active;
  }

  /** 记录已打开会话并限制上限，按最久未使用顺序淘汰非活动会话。 */
  function trackOpenSession(rpc: AgyRpc, sessionId: string) {
    openSessions.delete(sessionId);
    openSessions.add(sessionId);
    if (openSessions.size <= maxOpenSessions) return;
    const active = activeTaskSessionIds();
    for (const candidate of openSessions) {
      if (openSessions.size <= maxOpenSessions) break;
      if (candidate === sessionId || active.has(candidate)) continue;
      openSessions.delete(candidate);
      createdSessions.delete(candidate);
      if (rpc.alive) {
        void rpc.request("session/close", { sessionId: candidate }, 10_000).catch(() => {});
      }
    }
  }

  /** 记录尚未发消息的新建会话并限制上限，避免反复 /new 无限堆积内存与服务端句柄。 */
  function trackCreatedSession(
    rpc: AgyRpc,
    sessionId: string,
    entry: { cwd: string; label: string },
  ) {
    createdSessions.delete(sessionId);
    createdSessions.set(sessionId, entry);
    if (createdSessions.size <= maxCreatedSessions) return;
    const active = activeTaskSessionIds();
    for (const candidate of createdSessions.keys()) {
      if (createdSessions.size <= maxCreatedSessions) break;
      if (candidate === sessionId || active.has(candidate)) continue;
      createdSessions.delete(candidate);
      if (openSessions.delete(candidate) && rpc.alive) {
        void rpc.request("session/close", { sessionId: candidate }, 10_000).catch(() => {});
      }
    }
  }

  function subscribeSession(sessionId: string, subscriber: SessionSubscriber) {
    let set = subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      subscribers.set(sessionId, set);
    }
    set.add(subscriber);
    return () => {
      set.delete(subscriber);
      if (!set.size) subscribers.delete(sessionId);
    };
  }

  /** 将 ACP 通知和服务端请求按 sessionId 分发给对应任务。 */
  function createInitializedRpc(generation: number): Promise<AgyRpc> {
    return new Promise((resolve, reject) => {
      if (generation !== rpcGeneration) {
        reject(new Error("Antigravity ACP disconnected."));
        return;
      }
      let rpc: AgyRpc;
      try {
        rpc = createAgyRpc(command, env, {
          onNotification: (message) => {
            if (message.method !== "session/update") return;
            const parsed = sessionUpdateSchema.safeParse(message.params);
            if (!parsed.success) return;
            const targets = subscribers.get(parsed.data.sessionId);
            if (!targets) return;
            for (const target of [...targets]) {
              try {
                target.onUpdate(parsed.data.update);
              } catch {
                /** 隔离单订阅者异常，防止中断其他会话推送。 */
              }
            }
          },
          onRequest: (message) => {
            const sessionId =
              typeof message.params === "object" &&
              message.params !== null &&
              "sessionId" in message.params &&
              typeof message.params.sessionId === "string"
                ? message.params.sessionId
                : undefined;
            const targets = sessionId ? subscribers.get(sessionId) : undefined;
            const handler = targets
              ? [...targets].find((item) => item.onRequest)?.onRequest
              : undefined;
            if (handler) {
              handler(message);
              return;
            }
            /** 无活动任务接收的审批必须明确取消，避免服务端无限等待。 */
            if (message.method === "session/request_permission") {
              rpc.respond(message.id, { outcome: { outcome: "cancelled" } });
            } else {
              rpc.respondError(message.id, -32601, "Unsupported request.");
            }
          },
          onClose: (reason) => {
            if (pendingInitRpc === rpc) pendingInitRpc = undefined;
            if (sharedRpc === rpc) {
              sharedRpc = undefined;
              openSessions.clear();
              for (const set of [...subscribers.values()]) {
                for (const target of [...set]) {
                  try {
                    target.onDisconnect?.(reason);
                  } catch {
                    /** 隔离单任务断连回调异常，确保所有任务收到通知。 */
                  }
                }
              }
            }
          },
        });
      } catch (error) {
        reject(error);
        return;
      }
      pendingInitRpc = rpc;
      rpc
        .initialize()
        .then(() => {
          if (pendingInitRpc === rpc) pendingInitRpc = undefined;
          if (generation !== rpcGeneration || !rpc.alive) {
            rpc.close("Antigravity ACP disconnected during startup.");
            reject(new Error("Antigravity ACP disconnected during startup."));
            return;
          }
          resolve(rpc);
        })
        .catch((error) => {
          if (pendingInitRpc === rpc) pendingInitRpc = undefined;
          rpc.close("Antigravity ACP initialization failed.");
          reject(error);
        });
    });
  }

  /** 复用长连接 ACP 子进程；进程异常退出后按需自动拉起，并隔离启动中途的 disconnect。 */
  async function ensureRpc(signal?: AbortSignal): Promise<AgyRpc> {
    signal?.throwIfAborted();
    if (unavailableReason) throw new AgentError(unavailableReason);
    if (sharedRpc?.alive) return sharedRpc;
    if (!startingRpc) {
      const generation = rpcGeneration;
      const attempt = createInitializedRpc(generation)
        .then((rpc) => {
          if (generation !== rpcGeneration || !rpc.alive) {
            rpc.close("Antigravity ACP disconnected during startup.");
            throw new Error("Antigravity ACP disconnected during startup.");
          }
          sharedRpc = rpc;
          return rpc;
        })
        .finally(() => {
          if (startingRpc === attempt) startingRpc = undefined;
        });
      /** 防止所有调用方提前中止后出现未处理拒绝。 */
      void attempt.catch(() => {});
      startingRpc = attempt;
    }
    const current = startingRpc;
    if (!signal) return current;
    return await raceWithSignal(current, signal);
  }

  /** 将 AbortSignal 与指定超时绑定到单次控制请求。 */
  async function controlRequest<T>(
    rpc: AgyRpc,
    method: string,
    params: unknown,
    signal: AbortSignal,
    timeoutMs = 45_000,
  ): Promise<T> {
    return await raceWithSignal(rpc.request(method, params, timeoutMs) as Promise<T>, signal);
  }

  /** 创建 ACP 会话；若调用方提前中止或校验失败，服务端迟到返回的会话也会自动关闭。 */
  async function createSessionOnRpc(
    rpc: AgyRpc,
    cwd: string,
    signal: AbortSignal,
    timeoutMs = 45_000,
  ): Promise<z.infer<typeof sessionNewSchema>> {
    signal.throwIfAborted();
    let callerDropped = false;
    const rawPromise = rpc.request("session/new", { cwd, mcpServers: [] }, timeoutMs);
    void rawPromise
      .then((raw) => {
        if (!callerDropped) return;
        const lateId =
          typeof raw === "object" &&
          raw !== null &&
          "sessionId" in raw &&
          typeof raw.sessionId === "string"
            ? raw.sessionId
            : undefined;
        if (lateId && rpc.alive) {
          void rpc.request("session/close", { sessionId: lateId }, 10_000).catch(() => {});
        }
      })
      .catch(() => {});
    let raw: unknown;
    try {
      raw = await raceWithSignal(rawPromise, signal);
    } catch (error) {
      callerDropped = true;
      throw error;
    }
    const rawSessionId =
      typeof raw === "object" &&
      raw !== null &&
      "sessionId" in raw &&
      typeof raw.sessionId === "string"
        ? raw.sessionId
        : undefined;
    try {
      return sessionNewSchema.parse(raw);
    } catch (error) {
      if (rawSessionId && rpc.alive) {
        void rpc.request("session/close", { sessionId: rawSessionId }, 10_000).catch(() => {});
      }
      throw error;
    }
  }

  /** 将模型与推理档位应用到指定 ACP 会话。 */
  async function applyModelSelection(
    rpc: AgyRpc,
    sessionId: string,
    selection: { model: string | null; reasoningEffort: string | null },
    signal: AbortSignal,
    catalog?: ModelCatalog,
  ) {
    const resolved = resolveModelConfig(selection, catalog);
    if (resolved.modelId) {
      await controlRequest(
        rpc,
        "session/set_model",
        { sessionId, modelId: resolved.modelId },
        signal,
      );
      return;
    }
    if (resolved.configModel) {
      await controlRequest(
        rpc,
        "session/set_config_option",
        { sessionId, configId: "model", value: resolved.configModel },
        signal,
      );
    }
    if (resolved.configEffort) {
      await controlRequest(
        rpc,
        "session/set_config_option",
        { sessionId, configId: "thought_level", value: resolved.configEffort },
        signal,
      );
    }
  }

  /** 通过临时空会话查询最新模型列表与默认配置；同目录并发去重，且读取或中止后均关闭临时会话。 */
  async function readModelCatalog(
    cwd: string,
    signal: AbortSignal,
    allowCache: boolean,
  ): Promise<ModelCatalog> {
    signal.throwIfAborted();
    if (allowCache && cachedCatalog && Date.now() - cachedCatalog.fetchedAt < 300_000) {
      return cachedCatalog;
    }
    let pending = pendingCatalogs.get(cwd);
    if (!pending) {
      const fetchPromise = (async () => {
        const rpc = await ensureRpc();
        const raw = await rpc.request("session/new", { cwd, mcpServers: [] }, 30_000);
        const rawSessionId =
          typeof raw === "object" &&
          raw !== null &&
          "sessionId" in raw &&
          typeof raw.sessionId === "string"
            ? raw.sessionId
            : undefined;
        try {
          const created = sessionNewSchema.parse(raw);
          const parsed = parseModelCatalog(created);
          return updateCachedCatalog(created) ?? parsed;
        } finally {
          if (rawSessionId && rpc.alive) {
            await rpc.request("session/close", { sessionId: rawSessionId }, 10_000).catch(() => {});
          }
        }
      })().finally(() => {
        if (pendingCatalogs.get(cwd) === fetchPromise) pendingCatalogs.delete(cwd);
      });
      void fetchPromise.catch(() => {});
      pendingCatalogs.set(cwd, fetchPromise);
      pending = fetchPromise;
    }
    return await raceWithSignal(pending, signal);
  }

  /** 拉取全部会话列表，便于按目录过滤、提取项目目录和校验会话归属。 */
  async function fetchAllSessions(signal: AbortSignal) {
    const rpc = await ensureRpc(signal);
    const all: z.infer<typeof sessionListSchema>["sessions"] = [];
    const seen = new Set<string>();
    let cursor: string | null | undefined;
    do {
      const page = sessionListSchema.parse(
        await controlRequest(rpc, "session/list", cursor ? { cursor } : {}, signal, 45_000),
      );
      for (const session of page.sessions) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        all.push(session);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  /** 单次拉取会话列表并校验归属，同时区分服务端持久化会话与内存新建占位会话。 */
  async function lookupSession(
    cwd: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ session: AgentOption; persisted: boolean }> {
    try {
      const all = await fetchAllSessions(signal);
      const found = all.find((item) => item.sessionId === sessionId);
      if (found) {
        if (found.cwd !== cwd) {
          throw new AgentError(
            "Antigravity session is not in the current directory. Choose one from /list.",
          );
        }
        const label = formatSessionLabel(
          found.title,
          createdSessions.get(sessionId)?.label ?? "Untitled session",
        );
        return { session: { id: found.sessionId, label }, persisted: true };
      }
      const pending = createdSessions.get(sessionId);
      if (pending) {
        if (pending.cwd !== cwd) {
          throw new AgentError(
            "Antigravity session is not in the current directory. Choose one from /list.",
          );
        }
        return { session: { id: sessionId, label: pending.label }, persisted: false };
      }
      throw new AgentError(
        "Antigravity session unavailable. Open /list and choose a session again.",
      );
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        unavailableReason ??
          "Antigravity session unavailable. Open /list and choose a session again.",
      );
    }
  }

  /** 按目录校验并返回会话摘要，同时兼容尚未持久化的新建空会话。 */
  async function readSession(
    cwd: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<AgentOption> {
    return (await lookupSession(cwd, sessionId, signal)).session;
  }

  return {
    name: "Antigravity",
    version: unavailableReason ? "Unavailable" : versionText,
    ...(unavailableReason ? { unavailableReason } : {}),
    permissionModes: permissionModes.map(({ id, label }) => ({ id, label })),

    async listSessions(cwd, signal, cursor = null) {
      try {
        const all = await fetchAllSessions(signal);
        const sessions: AgentOption[] = [];
        const seen = new Set<string>();
        for (const [id, entry] of createdSessions) {
          if (entry.cwd !== cwd || seen.has(id)) continue;
          seen.add(id);
          sessions.push({ id, label: entry.label });
        }
        for (const session of all) {
          if (session.cwd !== cwd || seen.has(session.sessionId)) continue;
          seen.add(session.sessionId);
          sessions.push({
            id: session.sessionId,
            label: formatSessionLabel(session.title),
          });
        }
        const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
        const page = sessions.slice(offset, offset + listPageSize);
        const nextCursor =
          offset + listPageSize < sessions.length ? String(offset + listPageSize) : null;
        return { sessions: page, nextCursor };
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError(
          unavailableReason ?? "Antigravity session list unavailable. Try /list again.",
        );
      }
    },

    async listDirectories(_cwd, signal) {
      try {
        const all = await fetchAllSessions(signal);
        const directories = new Set<string>();
        for (const entry of createdSessions.values()) {
          if (isAbsolute(entry.cwd)) directories.add(entry.cwd);
        }
        for (const session of all) {
          if (isAbsolute(session.cwd)) directories.add(session.cwd);
        }
        return [...directories];
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError(
          unavailableReason ?? "Antigravity directory list unavailable. Try /cwd again.",
        );
      }
    },

    async createSession(input, signal) {
      try {
        const rpc = await ensureRpc(signal);
        const modeId = input.permissionMode ?? "default";
        if (!permissionModes.some((mode) => mode.id === modeId)) {
          throw new AgentError(
            "Antigravity permission mode unavailable. Choose another mode with /permissions.",
          );
        }
        const created = await createSessionOnRpc(rpc, input.cwd, signal);
        const catalog = updateCachedCatalog(created);
        try {
          if (modeId !== "default") {
            await controlRequest(
              rpc,
              "session/set_mode",
              { sessionId: created.sessionId, modeId },
              signal,
            );
          }
          if (input.model) {
            await applyModelSelection(
              rpc,
              created.sessionId,
              { model: input.model, reasoningEffort: null },
              signal,
              catalog,
            );
          }
        } catch (error) {
          if (rpc.alive) {
            void rpc
              .request("session/close", { sessionId: created.sessionId }, 10_000)
              .catch(() => {});
          }
          throw error;
        }
        const label = formatSessionLabel(input.name, defaultSessionName);
        trackOpenSession(rpc, created.sessionId);
        trackCreatedSession(rpc, created.sessionId, { cwd: input.cwd, label });
        return { id: created.sessionId, label };
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError(
          unavailableReason ??
            "Antigravity session creation unconfirmed. Current session unchanged. Check /list before retrying /new.",
        );
      }
    },

    readSession,

    async readLastResult(cwd, sessionId, signal, count) {
      try {
        const { session, persisted } = await lookupSession(cwd, sessionId, signal);
        const initialRunningTask = [...tasks.values()].find(
          (task) => task.sessionId === sessionId && task.promptDispatched,
        );
        if (!persisted) {
          return { session, running: Boolean(initialRunningTask), results: [] };
        }

        const turns: { prompt: string; output: string[] }[] = [];
        let lastEventKind: "user" | "agent" | undefined;
        const collectUpdate = (update: z.infer<typeof sessionUpdateSchema>["update"]) => {
          const text = update.content?.type === "text" ? update.content.text : undefined;
          if (!text) return;
          if (update.sessionUpdate === "user_message_chunk") {
            if (lastEventKind === "user" && turns.length) {
              const current = turns.at(-1);
              if (current) current.prompt += text;
            } else {
              turns.push({ prompt: text, output: [] });
            }
            lastEventKind = "user";
          } else if (update.sessionUpdate === "agent_message_chunk") {
            if (!turns.length) turns.push({ prompt: "", output: [] });
            const current = turns.at(-1);
            if (current) {
              if (lastEventKind === "agent" && current.output.length) {
                current.output[current.output.length - 1] += text;
              } else {
                current.output.push(text);
              }
            }
            lastEventKind = "agent";
          }
        };

        /** 统一使用独立只读子进程回放历史，彻底隔离并发 /last、活动任务流式输出与会话关闭。 */
        signal.throwIfAborted();
        let isolatedRpc: AgyRpc | undefined;
        const onAbort = () => {
          isolatedRpc?.close("Antigravity history query cancelled.");
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          isolatedRpc = createAgyRpc(command, env, {
            onNotification: (message) => {
              if (message.method !== "session/update") return;
              const parsed = sessionUpdateSchema.safeParse(message.params);
              if (parsed.success && parsed.data.sessionId === sessionId) {
                collectUpdate(parsed.data.update);
              }
            },
            onRequest: (message) => {
              isolatedRpc?.respondError(message.id, -32601, "Unsupported in history query.");
            },
            onClose: () => {
              if (isolatedRpc) activeIsolatedRpcs.delete(isolatedRpc);
            },
          });
          activeIsolatedRpcs.add(isolatedRpc);
          signal.throwIfAborted();
          await isolatedRpc.initialize();
          signal.throwIfAborted();
          await controlRequest(
            isolatedRpc,
            "session/load",
            { sessionId, cwd, mcpServers: [] },
            signal,
            45_000,
          );
        } finally {
          signal.removeEventListener("abort", onAbort);
          if (isolatedRpc) {
            activeIsolatedRpcs.delete(isolatedRpc);
            isolatedRpc.close();
          }
        }

        const runningTask =
          initialRunningTask ??
          [...tasks.values()].find((task) => task.sessionId === sessionId && task.promptDispatched);
        const running = Boolean(runningTask);
        /** 仅当末尾轮次尚未产生回复或与当前运行中提示匹配时剔除，避免新轮次未落盘时误删历史。 */
        const lastTurn = turns.at(-1);
        const activePrompt = runningTask?.activePrompt?.trim();
        const shouldDropLast = Boolean(
          runningTask &&
            lastTurn &&
            (lastTurn.output.length === 0 ||
              (activePrompt && lastTurn.prompt.trim() === activePrompt)),
        );
        const completedTurns = shouldDropLast ? turns.slice(0, -1) : turns;
        const results: AgentSessionHistory["results"] = completedTurns
          .slice(-count)
          .toReversed()
          .map((turn, index) => ({
            id: `${sessionId}:${completedTurns.length - index}`,
            status: "completed" as const,
            prompt: turn.prompt.trim(),
            text: turn.output.join("\n\n").trim() || "Antigravity finished with no text output.",
          }));
        return { session, running, results };
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError(
          unavailableReason ??
            "Antigravity session history unavailable. Try /last again or choose a session from /list.",
        );
      }
    },

    async listModels(cwd, signal) {
      try {
        return (await readModelCatalog(cwd, signal, false)).models;
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError(
          "Antigravity model query failed. Check local authentication and network.",
        );
      }
    },

    async describeModel(cwd, selection, signal) {
      try {
        const catalog = await readModelCatalog(cwd, signal, true);
        if (selection.model) {
          const matchedModel = catalog.models.find((item) => item.id === selection.model);
          if (matchedModel) {
            return {
              id: matchedModel.id,
              label: matchedModel.label,
              reasoningEffort:
                selection.reasoningEffort ?? (matchedModel.defaultReasoningEffort || null),
            };
          }
          const matchedVariant = catalog.availableModels.find(
            (item) => item.modelId === selection.model,
          );
          return {
            id: selection.model,
            label: matchedVariant?.name ?? selection.model,
            reasoningEffort: selection.reasoningEffort,
          };
        }
        const currentId = catalog.currentModelId;
        if (!currentId) throw new AgentError("Antigravity model settings unavailable.");
        for (const model of catalog.models) {
          if (currentId === model.id) {
            return { id: model.id, label: model.label, reasoningEffort: null };
          }
          if (currentId.startsWith(`${model.id}-`)) {
            const effort = currentId.slice(model.id.length + 1);
            if (knownEffortIds.has(effort)) {
              return { id: model.id, label: model.label, reasoningEffort: effort };
            }
          }
        }
        const variant = catalog.availableModels.find((item) => item.modelId === currentId);
        return {
          id: currentId,
          label: variant?.name ?? currentId,
          reasoningEffort: selection.reasoningEffort,
        };
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError("Antigravity model settings unavailable.");
      }
    },

    async readUsage(cwd, signal): Promise<AgentUsage> {
      if (unavailableReason) throw new AgentError(unavailableReason);
      try {
        const [{ stdout }, tierName] = await Promise.all([
          promisify(execFile)(command, ["--output-format", "json", "--print=/usage"], {
            cwd,
            env,
            timeout: 45_000,
            maxBuffer: 1_048_576,
            signal,
          }),
          cachedCatalog?.tierName
            ? Promise.resolve(cachedCatalog.tierName)
            : readModelCatalog(cwd, signal, true)
                .then((catalog) => catalog.tierName)
                .catch(() => null),
        ]);
        const payload = parseAgyUsageJson(stdout);
        const rawGroups = payload.command?.data.groups;
        if (!rawGroups) throw new Error("Missing usage groups.");
        const groups: AgentUsageGroup[] = rawGroups
          .map((group) => {
            const windows: AgentUsageWindow[] = group.buckets.map((bucket) => {
              const remainingPercent = Math.max(
                0,
                Math.min(100, Math.round(bucket.remaining_fraction * 100)),
              );
              const parsedReset = bucket.reset_time ? Date.parse(bucket.reset_time) : Number.NaN;
              return {
                label: formatAgyWindowLabel(bucket.window, bucket.name),
                remainingPercent,
                usedPercent: 100 - remainingPercent,
                resetsAt: Number.isFinite(parsedReset) && parsedReset > 0 ? parsedReset : null,
              };
            });
            return { name: group.name, windows };
          })
          .filter((group) => group.windows.length > 0);
        return {
          ...(tierName ? { plan: tierName } : {}),
          groups,
        };
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError(
          unavailableReason ??
            "Antigravity usage unavailable. Check local agy CLI login and network.",
        );
      }
    },

    async run(input) {
      if (tasks.has(input.taskId)) throw new AgentError("Antigravity task is already running.");
      /** ACP 服务随 Tellrun 进程退出；重启后的旧轮次不自动重跑，提示查看 /last。 */
      if (input.runId) {
        return {
          status: "interrupted",
          text: "Service restarted while Antigravity task was running. Check /last before sending a new message.",
        };
      }

      const controller = new AbortController();
      const runtime: TaskRuntime = { controller, promptDispatched: false };
      tasks.set(input.taskId, runtime);

      const modeId = input.permissionMode ?? "default";
      if (!permissionModes.some((mode) => mode.id === modeId)) {
        tasks.delete(input.taskId);
        return {
          status: "failed",
          text: "Antigravity permission mode unavailable. Choose another mode with /permissions.",
        };
      }

      const completed = Promise.withResolvers<AgentResult | undefined>();
      const segments: { id: string; text: string }[] = [{ id: randomUUID(), text: "" }];
      const interactions = new Map<
        string,
        {
          requestId: string | number;
          approvals: Map<string, AgyApprovalResponse>;
        }
      >();
      let previewTimer: ReturnType<typeof setTimeout> | undefined;
      let interruptTimer: ReturnType<typeof setTimeout> | undefined;
      let nextPreviewAt = 0;
      let settled = false;
      let rpc: AgyRpc | undefined;
      let sessionId = input.sessionId ?? undefined;
      let createdInRun = false;
      let unsubscribe: (() => void) | undefined;
      let dispatched = false;
      const queuedPrompts: { blocks: AgyContentBlock[]; text: string }[] = [];
      let disconnectedReason: string | undefined;

      /** 输出按用户输入分段，与 Telegram 原地预览更新对齐。 */
      function formatOutput(): AgentMessage[] {
        return segments
          .filter((segment) => segment.text.trim())
          .map((segment) => ({ id: segment.id, text: segment.text }));
      }

      /** 构造终态结果；带通知时附加到最后一段正文之前。 */
      function buildResult(status: AgentResult["status"], notice: string): AgentResult {
        const output = formatOutput();
        return {
          status,
          text:
            [notice, ...output.map((item) => item.text)].filter(Boolean).join("\n\n") ||
            "Antigravity finished with no text output.",
          ...(output.length
            ? {
                messages: output.map((item, index) =>
                  notice && index === output.length - 1
                    ? { ...item, text: `${notice}\n\n${item.text}` }
                    : item,
                ),
              }
            : notice
              ? { messages: [{ text: notice }] }
              : {}),
        };
      }

      /** 只接受第一个终态，避免迟到事件或定时器覆盖已确认结果。 */
      function finish(result?: AgentResult) {
        if (settled) return;
        settled = true;
        clearTimeout(previewTimer);
        previewTimer = undefined;
        clearTimeout(interruptTimer);
        interruptTimer = undefined;
        completed.resolve(result);
      }

      /** 回调写盘或运行时故障转为受控中断终态，交由核心层优雅收尾。 */
      function fail(notice: string) {
        if (settled) return;
        finish(buildResult("interrupted", notice));
      }

      /** 首段即时发送，后续增量按 1 秒窗口节流合并。 */
      function publishPreview() {
        if (settled || controller.signal.aborted || previewTimer) return;
        if (Date.now() < nextPreviewAt) {
          previewTimer = setTimeout(() => {
            previewTimer = undefined;
            try {
              publishPreview();
            } catch {
              fail("Cannot update Antigravity preview. Task status unknown.");
            }
          }, nextPreviewAt - Date.now());
          return;
        }
        const output = formatOutput();
        if (!nextPreviewAt && !output.length) return;
        nextPreviewAt = Date.now() + 1_000;
        input.onText(output);
      }

      /** 释放未应答权限请求；disconnect 路径不写状态盘，避免存储故障打断服务关停。 */
      function cancelPendingInteractions(reason: string, notifyState: boolean) {
        for (const [id, pending] of [...interactions]) {
          interactions.delete(id);
          if (rpc?.alive) {
            try {
              rpc.respond(pending.requestId, { outcome: { outcome: "cancelled" } });
            } catch {
              /** 连接已断开时忽略写入异常。 */
            }
          }
          if (notifyState) {
            try {
              input.onInteractionClosed(id, reason);
            } catch {
              /** 存储不可用时不阻断任务清理或服务关停。 */
            }
          }
        }
      }

      /** 主提示异常或中断时通知尚未发出的排队追加输入，避免静默丢失。 */
      function notifyUnsentQueuedPrompts(reason: string) {
        if (!queuedPrompts.length) return;
        const count = queuedPrompts.length;
        queuedPrompts.length = 0;
        try {
          input.onNotice(
            count === 1
              ? `1 follow-up message was not sent (${reason}). Resend it if still needed.`
              : `${count} follow-up messages were not sent (${reason}). Resend them if still needed.`,
          );
        } catch {
          /** 存储不可用时不阻断任务收尾。 */
        }
      }

      /** 恢复已有 ACP 会话并做响应校验与目录合并缓存。 */
      async function resumeExistingSession(activeRpc: AgyRpc, targetSessionId: string) {
        const resumed = sessionResumeSchema.parse(
          await controlRequest(
            activeRpc,
            "session/resume",
            { sessionId: targetSessionId, cwd: input.cwd, mcpServers: [] },
            controller.signal,
          ),
        );
        if (resumed.sessionId && resumed.sessionId !== targetSessionId) {
          throw new AgentError(
            "Antigravity resumed a different session. Check /list before retrying.",
          );
        }
        updateCachedCatalog(resumed);
        trackOpenSession(activeRpc, targetSessionId);
      }

      const onAbort = () => {
        clearTimeout(previewTimer);
        previewTimer = undefined;
        if (settled) return;
        if (controller.signal.reason === "disconnect") {
          /** 断连只清内存和取消服务端等待，不写状态盘并立刻释放 run()。 */
          cancelPendingInteractions("Service stopping.", false);
          queuedPrompts.length = 0;
          finish();
          return;
        }
        cancelPendingInteractions("Stopping. Request closed.", true);
        if (!dispatched) {
          finish({ status: "cancelled", text: "Stopped before starting." });
          return;
        }
        if (rpc?.alive && sessionId) {
          try {
            rpc.notify("session/cancel", { sessionId });
          } catch {
            /** 忽略取消时的管道异常。 */
          }
          const activeRpc = rpc;
          const activeSessionId = sessionId;
          interruptTimer = setTimeout(() => {
            if (settled) return;
            openSessions.delete(activeSessionId);
            if (activeRpc.alive) {
              void activeRpc
                .request("session/close", { sessionId: activeSessionId }, 10_000)
                .catch(() => {});
            }
            notifyUnsentQueuedPrompts("interruption timed out");
            finish(
              buildResult(
                "interrupted",
                "Interruption unconfirmed; Antigravity did not respond to cancel. Check /status and /last before sending a new message.",
              ),
            );
          }, 5_000);
        } else {
          notifyUnsentQueuedPrompts("Antigravity disconnected");
          finish(
            buildResult(
              "interrupted",
              "Antigravity disconnected. Check /status and /last before sending a new message.",
            ),
          );
        }
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });

      try {
        rpc = await ensureRpc(controller.signal);
        let wasAlreadyOpen = false;
        if (sessionId) {
          wasAlreadyOpen = openSessions.has(sessionId);
          if (!wasAlreadyOpen) {
            await resumeExistingSession(rpc, sessionId);
          }
        } else {
          const created = await createSessionOnRpc(rpc, input.cwd, controller.signal);
          sessionId = created.sessionId;
          createdInRun = true;
          updateCachedCatalog(created);
        }
        runtime.sessionId = sessionId;

        try {
          await controlRequest(rpc, "session/set_mode", { sessionId, modeId }, controller.signal);
        } catch (error) {
          /** 若服务端已回收旧会话，移除过期缓存后自动补做一次 session/resume 自愈。 */
          if (
            input.sessionId &&
            wasAlreadyOpen &&
            error instanceof JSONRPCErrorException &&
            error.data === "agy"
          ) {
            openSessions.delete(sessionId);
            await resumeExistingSession(rpc, sessionId);
            await controlRequest(rpc, "session/set_mode", { sessionId, modeId }, controller.signal);
          } else {
            throw error;
          }
        }

        if (input.model || input.reasoningEffort) {
          await applyModelSelection(
            rpc,
            sessionId,
            {
              model: input.model ?? null,
              reasoningEffort: input.reasoningEffort ?? null,
            },
            controller.signal,
            cachedCatalog,
          );
        }

        if (settled || controller.signal.aborted) {
          if (createdInRun && rpc.alive) {
            createdInRun = false;
            void rpc.request("session/close", { sessionId }, 10_000).catch(() => {});
          }
          if (!settled) {
            finish(
              controller.signal.reason === "disconnect"
                ? undefined
                : { status: "cancelled", text: "Stopped before starting." },
            );
          }
          return await completed.promise;
        }

        if (createdInRun) {
          trackOpenSession(rpc, sessionId);
          trackCreatedSession(rpc, sessionId, { cwd: input.cwd, label: defaultSessionName });
          createdInRun = false;
        }

        input.onSession(sessionId);
        if (settled || controller.signal.aborted) {
          if (!settled) {
            finish(
              controller.signal.reason === "disconnect"
                ? undefined
                : { status: "cancelled", text: "Stopped before starting." },
            );
          }
          return await completed.promise;
        }

        unsubscribe = subscribeSession(sessionId, {
          onUpdate: (update) => {
            if (settled || controller.signal.aborted) return;
            if (update.sessionUpdate !== "agent_message_chunk") return;
            const text = update.content?.type === "text" ? update.content.text : undefined;
            if (!text) return;
            try {
              const current = segments.at(-1);
              if (current) current.text += text;
              publishPreview();
            } catch {
              fail("Antigravity preview update failed. Task interrupted.");
            }
          },
          onRequest: (message) => {
            if (settled || controller.signal.aborted) {
              if (message.method === "session/request_permission") {
                rpc?.respond(message.id, { outcome: { outcome: "cancelled" } });
              } else {
                rpc?.respondError(message.id, -32601, "Task already ended.");
              }
              return;
            }
            try {
              const parsed = parseAgyInteraction(message.method, message.params, input.cwd);
              if ("error" in parsed) {
                if (parsed.unsupported) {
                  rpc?.respondError(message.id, -32601, "Unsupported interactive request.");
                } else {
                  rpc?.respond(message.id, { outcome: { outcome: "cancelled" } });
                }
                input.onNotice(parsed.error);
                return;
              }
              interactions.set(parsed.request.id, {
                requestId: message.id,
                approvals: parsed.approvals,
              });
              input.onInteraction(parsed.request);
            } catch {
              if (message.method === "session/request_permission") {
                try {
                  rpc?.respond(message.id, { outcome: { outcome: "cancelled" } });
                } catch {
                  /** 忽略断连时的写入异常。 */
                }
              } else {
                try {
                  rpc?.respondError(message.id, -32603, "Internal client error.");
                } catch {
                  /** 忽略断连时的写入异常。 */
                }
              }
              fail(
                "Antigravity response or state save failed. Task interrupted; check CLI version and storage.",
              );
            }
          },
          onDisconnect: (reason) => {
            disconnectedReason = reason;
          },
        });

        runtime.steer = async (prompt, attachments) => {
          if (settled || controller.signal.aborted || !rpc?.alive || !sessionId) {
            throw new AgentError(
              "Antigravity turn is not running. Input not sent; try again later.",
            );
          }
          const blocks = await createAgyInput(prompt, attachments);
          if (settled || controller.signal.aborted || !rpc?.alive || !sessionId) {
            throw new AgentError(
              "Antigravity turn is not running. Input not sent; try again later.",
            );
          }
          const text = blocks[0]?.type === "text" ? blocks[0].text : prompt;
          queuedPrompts.push({ blocks, text });
        };

        runtime.respond = async (id, answer) => {
          const pending = interactions.get(id);
          if (!pending || settled || controller.signal.aborted || !rpc?.alive) return false;
          if (!("decision" in answer)) return false;
          const approval = pending.approvals.get(answer.decision);
          if (!approval) return false;
          interactions.delete(id);
          try {
            rpc.respond(pending.requestId, approval.result);
            return true;
          } catch {
            return false;
          }
        };

        input.onStarted(randomUUID());
        if (settled || controller.signal.aborted) {
          if (!settled) {
            finish(
              controller.signal.reason === "disconnect"
                ? undefined
                : { status: "cancelled", text: "Stopped before starting." },
            );
          }
          return await completed.promise;
        }

        const initialBlocks = await createAgyInput(input.prompt, input.attachments);
        if (settled || controller.signal.aborted) {
          if (!settled) {
            finish(
              controller.signal.reason === "disconnect"
                ? undefined
                : { status: "cancelled", text: "Stopped before starting." },
            );
          }
          return await completed.promise;
        }

        const initialText =
          initialBlocks[0]?.type === "text" ? initialBlocks[0].text : input.prompt;
        dispatched = true;
        runtime.promptDispatched = true;
        runtime.activePrompt = initialText;
        /** 发送首条提示后移除未持久化占位记录，由服务端会话列表接管。 */
        createdSessions.delete(sessionId);

        const activeRpc = rpc;
        const activeSessionId = sessionId;
        /** 同一会话串行驱动主提示与排队补充提示，彻底避免并发 session/prompt 与分段错乱。 */
        void (async () => {
          let current:
            | { blocks: AgyContentBlock[]; text: string; isFollowUp: boolean }
            | undefined = { blocks: initialBlocks, text: initialText, isFollowUp: false };
          while (current && !settled && !controller.signal.aborted) {
            runtime.activePrompt = current.text;
            if (current.isFollowUp && segments.at(-1)?.text.trim()) {
              segments.push({ id: randomUUID(), text: "" });
            }
            try {
              const result = await activeRpc.request(
                "session/prompt",
                { sessionId: activeSessionId, prompt: current.blocks },
                0,
              );
              if (settled) return;
              const parsed = promptResponseSchema.safeParse(result);
              const stopReason =
                parsed.success && parsed.data.stopReason ? parsed.data.stopReason : "end_turn";
              if (stopReason === "cancelled" || controller.signal.aborted) {
                notifyUnsentQueuedPrompts("task stopped");
                finish(
                  buildResult(
                    "cancelled",
                    "Antigravity session interrupted. Existing file changes were not reverted.",
                  ),
                );
                return;
              }
              if (stopReason === "refusal") {
                if (current.isFollowUp) {
                  try {
                    input.onNotice("Antigravity refused a follow-up message.");
                  } catch {
                    /** 存储不可用时交由终态保存触发受控关停。 */
                  }
                  notifyUnsentQueuedPrompts("previous follow-up refused");
                  finish(buildResult("completed", ""));
                  return;
                }
                notifyUnsentQueuedPrompts("request refused");
                finish(buildResult("failed", "Antigravity refused the request."));
                return;
              }
            } catch (error) {
              if (settled) return;
              if (controller.signal.aborted && controller.signal.reason === "disconnect") {
                finish();
                return;
              }
              if (disconnectedReason) {
                notifyUnsentQueuedPrompts("Antigravity disconnected");
                finish(
                  buildResult(
                    "interrupted",
                    "Antigravity disconnected. Check /status and /last before sending a new message.",
                  ),
                );
                return;
              }
              if (controller.signal.aborted) {
                notifyUnsentQueuedPrompts("task stopped");
                finish(
                  buildResult(
                    "cancelled",
                    "Antigravity session interrupted. Existing file changes were not reverted.",
                  ),
                );
                return;
              }
              if (current.isFollowUp) {
                const notice =
                  error instanceof JSONRPCErrorException && error.data === "agy"
                    ? `Antigravity rejected a follow-up message (${error.code}). Previous reply was kept.`
                    : "A follow-up message failed in Antigravity. Previous reply was kept.";
                try {
                  input.onNotice(notice);
                } catch {
                  /** 存储不可用时交由终态保存触发受控关停。 */
                }
                notifyUnsentQueuedPrompts("previous follow-up failed");
                finish(buildResult("completed", ""));
                return;
              }
              const notice =
                error instanceof JSONRPCErrorException && error.data === "agy"
                  ? `Antigravity rejected the request (${error.code}). Check login, model availability, and network.`
                  : "Antigravity task failed. Check /last and local Antigravity authentication.";
              notifyUnsentQueuedPrompts("task failed");
              finish(buildResult("failed", notice));
              return;
            }
            const next = queuedPrompts.shift();
            current = next ? { ...next, isFollowUp: true } : undefined;
          }
          if (!settled) {
            if (controller.signal.aborted && controller.signal.reason === "disconnect") {
              finish();
            } else if (controller.signal.aborted) {
              notifyUnsentQueuedPrompts("task stopped");
              finish(
                buildResult(
                  "cancelled",
                  "Antigravity session interrupted. Existing file changes were not reverted.",
                ),
              );
            } else {
              finish(buildResult("completed", ""));
            }
          }
        })();

        return await completed.promise;
      } catch (error) {
        if (createdInRun && sessionId && rpc?.alive) {
          createdInRun = false;
          void rpc.request("session/close", { sessionId }, 10_000).catch(() => {});
        }
        if (!settled) {
          if (controller.signal.aborted && controller.signal.reason === "disconnect") {
            finish();
          } else {
            const status: AgentResult["status"] = dispatched
              ? "interrupted"
              : controller.signal.aborted
                ? "cancelled"
                : "failed";
            const text =
              status === "cancelled"
                ? "Stopped before starting."
                : error instanceof AgentError
                  ? error.message
                  : error instanceof JSONRPCErrorException && error.data === "agy"
                    ? `Antigravity request rejected (${error.code}). Check login, session availability (/list or /new), and settings.`
                    : "Antigravity task failed. Check local agy CLI login and network.";
            finish({ status, text });
          }
        }
        return await completed.promise;
      } finally {
        settled = true;
        clearTimeout(previewTimer);
        previewTimer = undefined;
        clearTimeout(interruptTimer);
        interruptTimer = undefined;
        controller.signal.removeEventListener("abort", onAbort);
        unsubscribe?.();
        tasks.delete(input.taskId);
        const disconnected = controller.signal.aborted && controller.signal.reason === "disconnect";
        cancelPendingInteractions("Task ended. Request closed.", !disconnected);
      }
    },

    async respond(taskId, id, answer) {
      return tasks.get(taskId)?.respond?.(id, answer) ?? false;
    },

    steer(taskId, prompt, attachments) {
      const steer = tasks.get(taskId)?.steer;
      if (!steer) {
        return Promise.reject(
          new AgentError("Antigravity has no active turn. Input not sent; resend to continue."),
        );
      }
      return steer(prompt, attachments);
    },

    disconnect(taskId) {
      if (taskId !== undefined) {
        try {
          tasks.get(taskId)?.controller.abort("disconnect");
        } catch {
          /** 断连清理不向外抛错。 */
        }
        return;
      }
      rpcGeneration += 1;
      for (const task of [...tasks.values()]) {
        try {
          task.controller.abort("disconnect");
        } catch {
          /** 确保单个任务异常不阻断全局清理与子进程关闭。 */
        }
      }
      startingRpc = undefined;
      pendingInitRpc?.close("Tellrun disconnected.");
      pendingInitRpc = undefined;
      sharedRpc?.close("Tellrun disconnected.");
      sharedRpc = undefined;
      for (const isolated of [...activeIsolatedRpcs]) {
        isolated.close("Tellrun disconnected.");
      }
      activeIsolatedRpcs.clear();
      openSessions.clear();
    },

    interrupt(taskId) {
      tasks.get(taskId)?.controller.abort();
    },
  };
}
