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
  InteractionAnswer,
} from "../core/types.js";
import { AgentError, listPageSize } from "../core/types.js";
import { createAgyInput } from "./agy-input.js";
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

const sessionMetaSchema = z.object({
  sessionId: z.string().min(1),
  models: z
    .object({
      availableModels: z
        .array(z.object({ modelId: z.string().min(1), name: z.string() }))
        .default([]),
      currentModelId: z.string().min(1).nullish(),
    })
    .nullish(),
  configOptions: z
    .array(
      z.object({
        id: z.string().min(1),
        currentValue: z.string().nullish(),
        options: z.array(z.object({ value: z.string().min(1), name: z.string() })).optional(),
      }),
    )
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
  fetchedAt: number;
}

interface SessionSubscriber {
  onUpdate: (update: z.infer<typeof sessionUpdateSchema>["update"]) => void;
  onRequest?: (message: AgyRpcMessage & { id: string | number; method: string }) => void;
  onDisconnect?: (reason: string) => void;
}

interface TaskRuntime {
  sessionId?: string;
  controller: AbortController;
  steer?: (prompt: string, attachments?: AgentAttachment[]) => Promise<void>;
  respond?: (id: string, answer: InteractionAnswer) => Promise<boolean>;
}

/** 从 ACP session/new 返回的 models 与 configOptions 构建模型目录。 */
function parseModelCatalog(meta: z.infer<typeof sessionMetaSchema>): ModelCatalog {
  const availableModels = meta.models?.availableModels ?? [];
  const currentModelId = meta.models?.currentModelId ?? null;
  const modelOption = meta.configOptions?.find((item) => item.id === "model");
  const thoughtOption = meta.configOptions?.find((item) => item.id === "thought_level");
  const effortLabels = new Map<string, string>(knownEfforts.map((item) => [item.id, item.label]));
  for (const item of thoughtOption?.options ?? []) {
    effortLabels.set(item.value, item.name || item.value);
  }

  const models: AgentModel[] = [];
  if (modelOption?.options?.length) {
    for (const base of modelOption.options) {
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

  return { models, availableModels, currentModelId, fetchedAt: Date.now() };
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
  const versionText = stdout.trim().replace(/^agy\s+/i, "");
  if (!unavailableReason && !/^\S+$/.test(versionText)) {
    throw new Error("Unrecognized Antigravity CLI version.");
  }

  let sharedRpc: AgyRpc | undefined;
  let startingRpc: Promise<AgyRpc> | undefined;
  let cachedCatalog: ModelCatalog | undefined;
  const tasks = new Map<number, TaskRuntime>();
  const subscribers = new Map<string, Set<SessionSubscriber>>();
  /** 记录本进程中已加载到共享 ACP 服务的会话，避免重复 resume。 */
  const openSessions = new Set<string>();
  /** 尚未发送首条消息的 /new 会话不会出现在 session/list 中，在内存中保留元数据。 */
  const createdSessions = new Map<string, { cwd: string; label: string }>();

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

  /** 将 ACP 通知和服务端请求按 sessionId 分发给对应任务或历史查询。 */
  function createInitializedRpc(isolated = false): Promise<AgyRpc> {
    return new Promise((resolve, reject) => {
      let rpc: AgyRpc;
      try {
        rpc = createAgyRpc(command, env, {
          onNotification: (message) => {
            if (isolated || message.method !== "session/update") return;
            const parsed = sessionUpdateSchema.safeParse(message.params);
            if (!parsed.success) return;
            const targets = subscribers.get(parsed.data.sessionId);
            if (!targets) return;
            for (const target of targets) target.onUpdate(parsed.data.update);
          },
          onRequest: (message) => {
            if (isolated) {
              rpc.respondError(message.id, -32601, "Unsupported request in read-only session.");
              return;
            }
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
            if (!isolated && sharedRpc === rpc) {
              sharedRpc = undefined;
              openSessions.clear();
              for (const set of subscribers.values()) {
                for (const target of set) target.onDisconnect?.(reason);
              }
            }
          },
        });
      } catch (error) {
        reject(error);
        return;
      }
      rpc
        .initialize()
        .then(() => resolve(rpc))
        .catch((error) => {
          rpc.close("Antigravity ACP initialization failed.");
          reject(error);
        });
    });
  }

  /** 复用长连接 ACP 子进程；进程异常退出后按需自动拉起。 */
  async function ensureRpc(signal?: AbortSignal): Promise<AgyRpc> {
    signal?.throwIfAborted();
    if (unavailableReason) throw new AgentError(unavailableReason);
    if (sharedRpc?.alive) return sharedRpc;
    if (!startingRpc) {
      startingRpc = createInitializedRpc(false)
        .then((rpc) => {
          sharedRpc = rpc;
          return rpc;
        })
        .finally(() => {
          startingRpc = undefined;
        });
    }
    if (!signal) return startingRpc;
    return await new Promise<AgyRpc>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("Aborted."));
      signal.addEventListener("abort", onAbort, { once: true });
      startingRpc?.then(
        (rpc) => {
          signal.removeEventListener("abort", onAbort);
          resolve(rpc);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /** 将 AbortSignal 与指定超时绑定到单次控制请求。 */
  async function controlRequest<T>(
    rpc: AgyRpc,
    method: string,
    params: unknown,
    signal: AbortSignal,
    timeoutMs = 45_000,
  ): Promise<T> {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("Request cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
      rpc.request(method, params, timeoutMs).then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result as T);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
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

  /** 通过临时空会话查询最新模型列表与默认配置，并在读取后立即关闭。 */
  async function readModelCatalog(
    cwd: string,
    signal: AbortSignal,
    allowCache: boolean,
  ): Promise<ModelCatalog> {
    if (allowCache && cachedCatalog && Date.now() - cachedCatalog.fetchedAt < 300_000) {
      return cachedCatalog;
    }
    const rpc = await ensureRpc(signal);
    const created = sessionMetaSchema.parse(
      await controlRequest(rpc, "session/new", { cwd, mcpServers: [] }, signal, 30_000),
    );
    await rpc.request("session/close", { sessionId: created.sessionId }, 10_000).catch(() => {});
    cachedCatalog = parseModelCatalog(created);
    return cachedCatalog;
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

  /** 按目录校验并返回会话摘要，同时兼容尚未持久化的新建空会话。 */
  async function readSession(
    cwd: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<AgentOption> {
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
        return { id: found.sessionId, label };
      }
      const pending = createdSessions.get(sessionId);
      if (pending) {
        if (pending.cwd !== cwd) {
          throw new AgentError(
            "Antigravity session is not in the current directory. Choose one from /list.",
          );
        }
        return { id: sessionId, label: pending.label };
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
        const created = sessionMetaSchema.parse(
          await controlRequest(rpc, "session/new", { cwd: input.cwd, mcpServers: [] }, signal),
        );
        cachedCatalog = parseModelCatalog(created);
        openSessions.add(created.sessionId);
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
            cachedCatalog,
          );
        }
        const label = formatSessionLabel(input.name, defaultSessionName);
        createdSessions.set(created.sessionId, { cwd: input.cwd, label });
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
        const session = await readSession(cwd, sessionId, signal);
        const running = [...tasks.values()].some((task) => task.sessionId === sessionId);
        const all = await fetchAllSessions(signal);
        if (!all.some((item) => item.sessionId === sessionId)) {
          return { session, running, results: [] };
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

        /** 运行中的会话改用独立只读进程回放历史，避免干扰正在执行的流式推送。 */
        if (running) {
          let isolatedRpc: AgyRpc | undefined;
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
            });
            await isolatedRpc.initialize();
            await controlRequest(
              isolatedRpc,
              "session/load",
              { sessionId, cwd, mcpServers: [] },
              signal,
              45_000,
            );
          } finally {
            isolatedRpc?.close();
          }
        } else {
          const rpc = await ensureRpc(signal);
          const wasOpen = openSessions.has(sessionId);
          const unsubscribe = subscribeSession(sessionId, { onUpdate: collectUpdate });
          try {
            await controlRequest(
              rpc,
              "session/load",
              { sessionId, cwd, mcpServers: [] },
              signal,
              45_000,
            );
          } finally {
            unsubscribe();
            if (!wasOpen) {
              await rpc.request("session/close", { sessionId }, 10_000).catch(() => {});
            }
          }
        }

        const completedTurns = running ? turns.slice(0, -1) : turns;
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
      const runtime: TaskRuntime = { controller };
      tasks.set(input.taskId, runtime);

      const modeId = input.permissionMode ?? "default";
      if (!permissionModes.some((mode) => mode.id === modeId)) {
        tasks.delete(input.taskId);
        return {
          status: "failed",
          text: "Antigravity permission mode unavailable. Choose another mode with /permissions.",
        };
      }

      const segments: { id: string; text: string }[] = [{ id: randomUUID(), text: "" }];
      const interactions = new Map<
        string,
        {
          requestId: string | number;
          approvals: Map<string, AgyApprovalResponse>;
        }
      >();
      let previewTimer: ReturnType<typeof setTimeout> | undefined;
      let nextPreviewAt = 0;
      let settled = false;
      let rpc: AgyRpc | undefined;
      let sessionId = input.sessionId ?? undefined;
      let unsubscribe: (() => void) | undefined;
      let dispatched = false;

      /** 输出按用户输入分段，与 Telegram 原地预览更新对齐。 */
      function formatOutput(): AgentMessage[] {
        return segments
          .filter((segment) => segment.text.trim())
          .map((segment) => ({ id: segment.id, text: segment.text }));
      }

      /** 首段即时发送，后续增量按 1 秒窗口节流合并。 */
      function publishPreview() {
        if (settled || controller.signal.aborted || previewTimer) return;
        if (Date.now() < nextPreviewAt) {
          previewTimer = setTimeout(() => {
            previewTimer = undefined;
            publishPreview();
          }, nextPreviewAt - Date.now());
          return;
        }
        const output = formatOutput();
        if (!nextPreviewAt && !output.length) return;
        nextPreviewAt = Date.now() + 1_000;
        input.onText(output);
      }

      /** 释放所有尚未应答的权限请求，避免取消后阻塞 ACP 服务。 */
      function cancelPendingInteractions(reason: string) {
        for (const [id, pending] of interactions) {
          interactions.delete(id);
          if (rpc?.alive) {
            try {
              rpc.respond(pending.requestId, { outcome: { outcome: "cancelled" } });
            } catch {
              /** 连接已断开时忽略写入异常。 */
            }
          }
          input.onInteractionClosed(id, reason);
        }
      }

      /** 追踪主提示和所有补充提示，直到整个会话轮次队列执行完成。 */
      const inFlightPrompts = new Set<Promise<void>>();
      let lastStopReason = "end_turn";
      let promptError: unknown;
      let disconnectedReason: string | undefined;

      function enqueuePrompt(prompt: string, attachments?: AgentAttachment[]) {
        if (!rpc || !sessionId) {
          throw new AgentError("Antigravity session is not active.");
        }
        const promise = rpc
          .request("session/prompt", { sessionId, prompt: createAgyInput(prompt, attachments) }, 0)
          .then((result) => {
            const parsed = promptResponseSchema.safeParse(result);
            if (parsed.success && parsed.data.stopReason) {
              lastStopReason = parsed.data.stopReason;
            }
          })
          .catch((error) => {
            promptError ??= error;
          })
          .finally(() => {
            inFlightPrompts.delete(promise);
          });
        inFlightPrompts.add(promise);
        return promise;
      }

      const onAbort = () => {
        clearTimeout(previewTimer);
        if (controller.signal.reason === "disconnect") {
          cancelPendingInteractions("Service stopping.");
          return;
        }
        cancelPendingInteractions("Stopping. Request closed.");
        if (rpc?.alive && sessionId && dispatched) {
          try {
            rpc.notify("session/cancel", { sessionId });
          } catch {
            /** 忽略取消时的管道异常。 */
          }
        }
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });

      try {
        rpc = await ensureRpc(controller.signal);
        if (sessionId) {
          if (!openSessions.has(sessionId)) {
            const resumed = sessionMetaSchema.parse(
              await controlRequest(
                rpc,
                "session/resume",
                { sessionId, cwd: input.cwd, mcpServers: [] },
                controller.signal,
              ),
            );
            cachedCatalog = parseModelCatalog(resumed);
            openSessions.add(sessionId);
          }
        } else {
          const created = sessionMetaSchema.parse(
            await controlRequest(
              rpc,
              "session/new",
              { cwd: input.cwd, mcpServers: [] },
              controller.signal,
            ),
          );
          sessionId = created.sessionId;
          cachedCatalog = parseModelCatalog(created);
          openSessions.add(sessionId);
        }
        runtime.sessionId = sessionId;

        await controlRequest(rpc, "session/set_mode", { sessionId, modeId }, controller.signal);
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

        input.onSession(sessionId);
        if (controller.signal.aborted) {
          return controller.signal.reason === "disconnect"
            ? undefined
            : { status: "cancelled", text: "Stopped before starting." };
        }

        unsubscribe = subscribeSession(sessionId, {
          onUpdate: (update) => {
            if (settled || controller.signal.aborted) return;
            if (update.sessionUpdate !== "agent_message_chunk") return;
            const text = update.content?.type === "text" ? update.content.text : undefined;
            if (!text) return;
            const current = segments.at(-1);
            if (current) current.text += text;
            publishPreview();
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
          if (segments.at(-1)?.text.trim()) {
            segments.push({ id: randomUUID(), text: "" });
          }
          enqueuePrompt(prompt, attachments);
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

        dispatched = true;
        /** 发送首条提示后移除未持久化占位记录，由服务端会话列表接管。 */
        createdSessions.delete(sessionId);
        input.onStarted(randomUUID());
        enqueuePrompt(input.prompt, input.attachments);

        while (inFlightPrompts.size > 0) {
          await Promise.all([...inFlightPrompts]);
        }

        settled = true;
        clearTimeout(previewTimer);
        if (controller.signal.aborted && controller.signal.reason === "disconnect") {
          return undefined;
        }
        const output = formatOutput();
        if (disconnectedReason) {
          const notice =
            "Antigravity disconnected. Check /status and /last before sending a new message.";
          return {
            status: "interrupted",
            text: [notice, ...output.map((item) => item.text)].filter(Boolean).join("\n\n"),
            messages: output.length
              ? output.map((item, index) =>
                  index === output.length - 1
                    ? { ...item, text: `${notice}\n\n${item.text}` }
                    : item,
                )
              : [{ text: notice }],
          };
        }
        if (promptError) {
          const notice =
            promptError instanceof JSONRPCErrorException && promptError.data === "agy"
              ? `Antigravity rejected the request (${promptError.code}). Check login, model availability, and network.`
              : "Antigravity task failed. Check /last and local Antigravity authentication.";
          return {
            status: controller.signal.aborted ? "cancelled" : "failed",
            text: [notice, ...output.map((item) => item.text)].filter(Boolean).join("\n\n"),
            messages: output.length
              ? output.map((item, index) =>
                  index === output.length - 1
                    ? { ...item, text: `${notice}\n\n${item.text}` }
                    : item,
                )
              : [{ text: notice }],
          };
        }

        const status: AgentResult["status"] =
          lastStopReason === "cancelled" || controller.signal.aborted
            ? "cancelled"
            : lastStopReason === "refusal"
              ? "failed"
              : "completed";
        const notice =
          status === "cancelled"
            ? "Antigravity session interrupted. Existing file changes were not reverted."
            : status === "failed"
              ? "Antigravity refused the request."
              : "";
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
            : {}),
        };
      } catch (error) {
        settled = true;
        clearTimeout(previewTimer);
        if (controller.signal.aborted && controller.signal.reason === "disconnect") {
          return undefined;
        }
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
                ? `Antigravity request rejected (${error.code}). Check login and session settings.`
                : "Antigravity task failed. Check local agy CLI login and network.";
        return { status, text };
      } finally {
        settled = true;
        clearTimeout(previewTimer);
        controller.signal.removeEventListener("abort", onAbort);
        cancelPendingInteractions("Task ended. Request closed.");
        unsubscribe?.();
        tasks.delete(input.taskId);
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
        tasks.get(taskId)?.controller.abort("disconnect");
        return;
      }
      for (const task of tasks.values()) task.controller.abort("disconnect");
      sharedRpc?.close("Tellrun disconnected.");
      sharedRpc = undefined;
      openSessions.clear();
    },

    interrupt(taskId) {
      tasks.get(taskId)?.controller.abort();
    },
  };
}
