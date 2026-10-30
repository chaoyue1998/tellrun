import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { JSONRPCErrorException } from "json-rpc-2.0";
import WebSocket from "ws";
import { z } from "zod";
import type {
  Agent,
  AgentInteraction,
  AgentModel,
  AgentOption,
  AgentResult,
} from "../core/types.js";
import { createCodexInput } from "./codex-input.js";
import {
  type CodexApprovalResponse,
  fileChangesSchema,
  parseCodexInteraction,
} from "./codex-interaction.js";
import { type CodexMessage, createCodexRpc } from "./codex-rpc.js";

/** 由 Codex 0.165.0 的 generate-ts 核对；只校验实际消费的协议字段。 */
const turnSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
});

/** 创建、列表和读取会话共用元数据校验；空标题回退到首条消息摘要。 */
const sessionSchema = z
  .object({
    id: z.string().min(1),
    cwd: z.string(),
    name: z.string().nullable(),
    preview: z.string(),
    status: z.object({ type: z.string() }),
  })
  .transform((thread) => ({
    id: thread.id,
    cwd: thread.cwd,
    label: (thread.name?.trim() || thread.preview.trim() || "Untitled session")
      .replace(/\s+/gu, " ")
      .slice(0, 120),
    status: thread.status.type,
  }));

/** Codex CLI 的四种预设；协议参数只在适配层使用，菜单与执行共用此定义。 */
const permissionModes = [
  {
    id: "default",
    label: "Ask for approval",
    config: { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" },
  },
  {
    id: "auto-review",
    label: "Approve for me",
    config: {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    },
  },
  {
    id: "full-access",
    label: "Full Access",
    config: { sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" },
  },
  {
    id: "read-only",
    label: "Read Only",
    config: { sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" },
  },
] as const;

/** 连接独立的 Codex 后台服务；Tellrun 退出不结束后台轮次。 */
export async function createCodexAgent(command = "codex"): Promise<Agent> {
  /** 保留运行时、认证和代理环境，不向子进程传入 Telegram 凭据。 */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_.*|TERM|TMPDIR|TEMP|TMP|SYSTEMROOT|WINDIR|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|CODEX_HOME|OPENAI_API_KEY|OPENAI_BASE_URL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(
        key,
      ),
    ),
  );
  /** npm 版 Codex 通过 env 查找 node；后台服务也应复用运行 Tellrun 的 Node。 */
  env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
  const { stdout } = await promisify(execFile)(command, ["--version"], {
    timeout: 5_000,
    maxBuffer: 4_096,
    env,
  });
  if (!/^codex-cli \S+$/.test(stdout.trim())) throw new Error("Unrecognized Codex CLI version.");
  let active: AbortController | undefined;
  /** 只绑定当前任务的连接，不能把迟到输入送入下一轮或其他客户端的轮次。 */
  let steer: Agent["steer"] | undefined;
  let respond: Agent["respond"] | undefined;

  /** 任务、会话管理与只读查询共用连接流程，各自使用独立 socket。 */
  async function connectServer(cwd: string, signal: AbortSignal): Promise<WebSocket> {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const socket = await new Promise<WebSocket | undefined>((resolve) => {
        const connection = new WebSocket("ws://localhost", {
          createConnection: () =>
            connect(
              join(
                env.CODEX_HOME ?? join(homedir(), ".codex"),
                "app-server-control",
                "app-server-control.sock",
              ),
            ),
          handshakeTimeout: 5_000,
          maxPayload: 8_000_000,
        });
        /** 连接尚未建立时也能响应关停，不等待握手超时。 */
        const abort = () => connection.terminate();
        signal.addEventListener("abort", abort, { once: true });
        connection.once("open", () => {
          signal.removeEventListener("abort", abort);
          resolve(connection);
        });
        connection.once("error", () => {
          signal.removeEventListener("abort", abort);
          connection.terminate();
          resolve(undefined);
        });
      });
      if (socket) {
        if (signal.aborted) {
          socket.terminate();
          signal.throwIfAborted();
        }
        return socket;
      }
      signal.throwIfAborted();
      if (attempt === 0) {
        /** bootstrap 由系统管理独立 daemon，避免随 Tellrun 的进程组退出。 */
        await promisify(execFile)(command, ["app-server", "daemon", "bootstrap"], {
          cwd,
          env,
          timeout: 30_000,
          maxBuffer: 1_048_576,
          signal,
        });
      }
    }
    throw new Error("Codex daemon unavailable.");
  }

  /** 会话管理共用短连接；超时或关停只断开查询，不中断后台任务。 */
  async function withSessionConnection<T>(
    cwd: string,
    signal: AbortSignal,
    action: (rpc: ReturnType<typeof createCodexRpc>) => Promise<T>,
  ): Promise<T> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
    const rpc = createCodexRpc(await connectServer(cwd, signal));
    const abort = () => rpc.close("Codex session request cancelled.");
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await rpc.initialize();
      return await action(rpc);
    } finally {
      signal.removeEventListener("abort", abort);
      rpc.close();
    }
  }

  /** 模型菜单与状态共用只读连接；按需读取目录配置，不恢复会话或发起轮次。 */
  async function readModelData(cwd: string, signal: AbortSignal, includeConfig = false) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const rpc = createCodexRpc(await connectServer(cwd, signal));
    /** 取消仅关闭目录查询，不能向正在运行的轮次发送中断。 */
    const abort = () => rpc.close("Codex model query cancelled.");
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await rpc.initialize();
      const config = includeConfig
        ? z
            .object({
              config: z.object({
                model: z.string().min(1).nullish(),
                model_reasoning_effort: z.string().min(1).nullish(),
              }),
            })
            .parse(await rpc.request("config/read", { cwd, includeLayers: false })).config
        : undefined;
      const models: AgentModel[] = [];
      let defaultModel: string | undefined;
      let cursor: string | null = null;
      do {
        signal.throwIfAborted();
        const page = z
          .object({
            data: z.array(
              z.object({
                model: z.string().min(1),
                displayName: z.string(),
                hidden: z.boolean(),
                isDefault: z.boolean().optional(),
                supportedReasoningEfforts: z.array(
                  z.object({
                    reasoningEffort: z.string().min(1),
                    description: z.string(),
                  }),
                ),
                defaultReasoningEffort: z.string().min(1),
              }),
            ),
            nextCursor: z.string().nullable(),
          })
          .parse(
            await rpc.request("model/list", { limit: 100, includeHidden: includeConfig, cursor }),
          );
        for (const model of page.data) {
          if (model.isDefault) defaultModel = model.model;
          if (
            (includeConfig || !model.hidden) &&
            !models.some((option) => option.id === model.model)
          )
            models.push({
              id: model.model,
              label: model.displayName || model.model,
              reasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
                id: effort.reasoningEffort,
                label: effort.description,
              })),
              defaultReasoningEffort: model.defaultReasoningEffort,
            });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return { models, defaultModel, config };
    } catch {
      throw new Error("Codex model query failed. Check the local configuration and connection.");
    } finally {
      signal.removeEventListener("abort", abort);
      rpc.close();
    }
  }

  return {
    name: "Codex",
    version: stdout.trim().replace(/^codex-cli /, ""),
    permissionModes: permissionModes.map(({ id, label }) => ({ id, label })),
    async listSessions(cwd, signal) {
      return withSessionConnection(cwd, signal, async (rpc) => {
        const sessions: AgentOption[] = [];
        let cursor: string | null = null;
        do {
          const page = z
            .object({ data: z.array(sessionSchema), nextCursor: z.string().nullable() })
            .parse(
              await rpc.request("thread/list", {
                cwd,
                cursor,
                limit: 100,
                sortKey: "updated_at",
                modelProviders: [],
                /** 默认来源会漏掉 app-server 会话；排除自动生成的子 Agent 会话。 */
                sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
                archived: false,
              }),
            );
          for (const session of page.data)
            if (session.cwd === cwd && !sessions.some((item) => item.id === session.id))
              sessions.push({ id: session.id, label: session.label });
          cursor = page.nextCursor;
        } while (cursor);
        return sessions;
      }).catch(() => {
        throw new Error("Codex session list unavailable. Try /list again.");
      });
    },
    async createSession(input, signal) {
      return withSessionConnection(input.cwd, signal, async (rpc) => {
        const permissionMode = permissionModes.find(
          (mode) => mode.id === (input.permissionMode ?? "default"),
        );
        if (!permissionMode) throw new Error("Unknown permission mode.");
        const { thread } = z.object({ thread: sessionSchema }).parse(
          await rpc.request("thread/start", {
            cwd: input.cwd,
            ...permissionMode.config,
            ...(input.model ? { model: input.model } : {}),
            ephemeral: false,
          }),
        );
        if (thread.cwd !== input.cwd || thread.status !== "idle")
          throw new Error("Unexpected new session.");
        /** 显式命名会物化空会话，保证首次发言前也能列出并在重启后恢复。 */
        await rpc.request("thread/name/set", {
          threadId: thread.id,
          name: input.name.trim() || "New session",
        });
        return { id: thread.id, label: input.name.trim() || "New session" };
      }).catch(() => {
        throw new Error(
          "Codex session creation unconfirmed. Current session unchanged. Check /list before retrying /new.",
        );
      });
    },
    async readSession(cwd, sessionId, signal) {
      const { thread } = await withSessionConnection(cwd, signal, async (rpc) =>
        z
          .object({ thread: sessionSchema })
          .parse(await rpc.request("thread/read", { threadId: sessionId })),
      ).catch(() => {
        throw new Error("Codex session unavailable. Use a full session ID from /list.");
      });
      if (thread.id !== sessionId || thread.cwd !== cwd)
        throw new Error("Codex session is not in the current directory. Choose one from /list.");
      if (!["idle", "notLoaded"].includes(thread.status))
        throw new Error("Codex session busy or unavailable. Wait until it is idle.");
      return { id: thread.id, label: thread.label };
    },
    async listModels(cwd, signal) {
      return (await readModelData(cwd, signal)).models;
    },
    async describeModel(cwd, selection, signal) {
      /** 已选模型可能已从菜单隐藏，状态仍需查询完整目录中的展示名称。 */
      const { models, defaultModel, config } = await readModelData(cwd, signal, true);
      const id = selection.model ?? config?.model ?? defaultModel;
      const model = models.find((option) => option.id === id);
      const reasoningEffort =
        selection.reasoningEffort ??
        config?.model_reasoning_effort ??
        model?.defaultReasoningEffort;
      if (!id || !reasoningEffort) throw new Error("Codex model settings unavailable.");
      return { id, label: model?.label ?? id, reasoningEffort };
    },
    async run(input) {
      if (active) throw new Error("Codex is already running a task.");
      const controller = new AbortController();
      active = controller;
      let socket: WebSocket | undefined;
      try {
        socket = await connectServer(input.cwd, controller.signal);
      } catch {
        active = undefined;
        if (controller.signal.aborted)
          return controller.signal.reason === "disconnect"
            ? undefined
            : input.runId
              ? {
                  status: "interrupted",
                  text: "Codex stop unconfirmed. Could not reconnect to the task.",
                }
              : { status: "cancelled", text: "Stopped before connecting." };
        return {
          status: input.runId ? "interrupted" : "failed",
          text: "Codex daemon unavailable. Run codex app-server daemon bootstrap on the host, then retry. Existing work was not stopped or resubmitted.",
        };
      }
      const completed = Promise.withResolvers<AgentResult | undefined>();
      /** 按首次出现顺序保存全部回复与文件变更标题，完整事件覆盖同一条增量。 */
      const messages = new Map<string, string>();
      /** 应用随机 ID 隔离每次连接；已见 RPC 编号保留到任务结束，重复请求不生成新按钮。 */
      const interactions = new Map<
        string,
        {
          /** 空值表示异步消息问题，通过用户输入提交，不发送 RPC 响应。 */
          requestId: string | number | null;
          request: AgentInteraction;
          timer: ReturnType<typeof setTimeout> | undefined;
          approvals: Map<string, CodexApprovalResponse>;
          fileReview?: { itemId: string; changes: string };
        }
      >();
      const seenRequests = new Set<string | number>();
      /** 保留已展示或已回答的问题标识，重复事件与恢复快照不能重新打开旧问题。 */
      const seenQuestions = new Set<string>();
      const fileChanges = new Map<string, z.infer<typeof fileChangesSchema>>();
      /** 新任务等启动响应，恢复任务等完整快照，再处理当前轮次的早到事件。 */
      const earlyMessages: CodexMessage[] = [];
      let earlyMessageSize = 0;
      let sessionId = input.sessionId ?? undefined;
      let runId: string | undefined;
      let dispatched = Boolean(input.runId);
      let settled = false;
      /** 原生 Cancel 的已确认中断视为用户取消，不能误报异常并暂停聊天。 */
      let cancelledByApproval = false;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;

      /** 只接受第一个终态，避免退出事件覆盖已经确认的执行结果。 */
      function finish(result?: AgentResult) {
        if (settled) return;
        settled = true;
        for (const interaction of interactions.values()) clearTimeout(interaction.timer);
        interactions.clear();
        completed.resolve(
          result
            ? {
                ...result,
                text:
                  [formatOutput(), result.text].filter(Boolean).join("\n\n") ||
                  "Codex finished with no text output.",
              }
            : undefined,
        );
      }

      /** 预览和结果共用完整内容；保留过程说明、最终回复及文件差异，由 IM 分段发送。 */
      function formatOutput() {
        return [...messages]
          .map(([id, text]) =>
            [
              text,
              ...(fileChanges.get(id) ?? []).map(
                (change) =>
                  `${change.kind.type}: ${change.path}${change.kind.move_path ? ` → ${change.kind.move_path}` : ""}\n${change.diff}`,
              ),
            ]
              .filter(Boolean)
              .join("\n\n"),
          )
          .filter(Boolean)
          .join("\n\n");
      }

      /** 通信故障不等于执行失败；保留不确定状态并结束当前连接。 */
      function fail(text: string) {
        if (settled) return;
        finish({ status: "interrupted", text });
        rpc.close(text);
        controller.abort();
      }

      /** 超时结束本次跟踪；区分服务端拒绝与连接故障，保留输入的不确定状态。 */
      async function request(method: string, params?: unknown): Promise<unknown> {
        if (controller.signal.aborted && method !== "turn/interrupt")
          throw new Error("Task stopped.");
        try {
          return await (method === "initialize" ? rpc.initialize() : rpc.request(method, params));
        } catch (error) {
          /** 只识别已知占用错误，避免把可能含敏感信息的原始错误转发到 IM。 */
          if (error instanceof JSONRPCErrorException && error.data === "codex")
            throw new Error(
              method === "thread/resume" &&
                error.code === -32600 &&
                error.message.includes("already has an active writer")
                ? "Codex session locked by another process. Task not started; check local Codex connections."
                : method === "turn/steer"
                  ? `Codex rejected input (${error.code}). The turn may have ended; resend to continue.`
                  : `Codex ${method} rejected (${error.code}). Check config and sign-in.`,
            );
          if (method === "turn/steer")
            throw new Error(
              "Codex input delivery unconfirmed. Not retried; check the session before resending.",
            );
          throw error;
        }
      }

      /** 启动响应或已保存轮次确定任务归属；其他客户端的事件不能改变关联。 */
      function recordRun(id: string) {
        if (runId && runId !== id) return false;
        if (!runId) {
          runId = id;
          input.onStarted(id);
        }
        return true;
      }

      controller.signal.addEventListener(
        "abort",
        () => {
          for (const interaction of interactions.values()) clearTimeout(interaction.timer);
          interactions.clear();
          if (settled) return;
          if (controller.signal.reason === "disconnect") {
            finish();
            rpc.close("Tellrun disconnected. Task continues in Codex.");
            return;
          }
          stopTimer = setTimeout(
            () => fail("Stop unconfirmed; Codex disconnected. Check the project before /resume."),
            5_000,
          );
          if (sessionId && runId) {
            void request("turn/interrupt", { threadId: sessionId, turnId: runId }).catch(() =>
              rpc.close(),
            );
          } else rpc.close();
        },
        { once: true },
      );
      /** 连接关闭不能当作后台任务已停止，更不能向后台补发取消。 */
      function onClose() {
        if (controller.signal.aborted && !dispatched)
          finish({ status: "cancelled", text: "Stopped before starting." });
        if (!settled)
          fail("Codex disconnected. Task may still be running; check the local session.");
        else rpc.close();
      }

      /** RPC 提问与异步消息共用展示和期限管理；异步题逐题提交，不等待其他题。 */
      function openInteraction(message: CodexMessage) {
        const parsed = parseCodexInteraction(
          message.method ?? "",
          message.params,
          input.cwd,
          fileChanges,
        );
        if ("error" in parsed) {
          if (parsed.unsupported && message.id !== undefined)
            rpc.write({
              id: message.id,
              error: { code: -32601, message: "Unsupported interactive request" },
            });
          fail(parsed.error);
          return;
        }
        for (const interaction of message.id === undefined
          ? parsed.request.questions.map((question) => ({
              ...parsed.request,
              id: randomUUID(),
              questions: [question],
            }))
          : [parsed.request]) {
          if (message.id === undefined) {
            if (
              interaction.questions.some(
                (question) =>
                  seenQuestions.has(question.id) || seenQuestions.has(JSON.parse(question.id)[1]),
              )
            )
              continue;
            for (const question of interaction.questions) seenQuestions.add(question.id);
          }
          interactions.set(interaction.id, {
            ...parsed,
            request: interaction,
            requestId: message.id ?? null,
            timer:
              interaction.expiresAt === null
                ? undefined
                : setTimeout(
                    () => {
                      const pending = interactions.get(interaction.id);
                      if (!pending) return;
                      if (interaction.blocking) {
                        fail("Request timed out. Check /last, then /resume.");
                      } else {
                        interactions.delete(interaction.id);
                        /** 异步问题没有待响应 RPC；过期只关闭按钮，不提交默认答案。 */
                        try {
                          input.onInteractionClosed(
                            interaction.id,
                            "Question expired. Task continues.",
                          );
                          if (pending.requestId !== null)
                            rpc.write({ id: pending.requestId, result: { answers: {} } });
                        } catch {
                          fail("Cannot save expired question state. Task interrupted.");
                        }
                      }
                    },
                    Math.max(0, interaction.expiresAt - Date.now()),
                  ),
          });
          input.onInteraction(interaction);
        }
      }

      /** 实时事件与恢复快照共用协议处理，始终只消费当前任务的事件。 */
      function onMessage(message: CodexMessage) {
        if (settled) return;
        try {
          if (message.method && !runId) {
            if (dispatched) {
              earlyMessages.push(message);
              earlyMessageSize += JSON.stringify(message).length;
              if (earlyMessageSize > 8_000_000)
                return fail("Codex event limit exceeded. Task interrupted.");
            }
            return;
          }
          if (message.id !== undefined && message.method) {
            /** 共享连接上的交互可能属于其他会话或轮次，不能替其他客户端拒绝。 */
            const context = z
              .object({ threadId: z.string(), turnId: z.string().optional() })
              .safeParse(message.params);
            if (
              !context.success ||
              context.data.threadId !== sessionId ||
              (context.data.turnId !== undefined && context.data.turnId !== runId)
            )
              return;
            if (controller.signal.aborted || seenRequests.has(message.id)) return;
            seenRequests.add(message.id);
            openInteraction(message);
          } else if (message.method === "serverRequest/resolved") {
            const event = z
              .object({ threadId: z.string(), requestId: z.union([z.string(), z.number()]) })
              .parse(message.params);
            if (event.threadId !== sessionId) return;
            seenRequests.add(event.requestId);
            for (const [id, interaction] of interactions) {
              if (interaction.requestId !== event.requestId) continue;
              clearTimeout(interaction.timer);
              interactions.delete(id);
              input.onInteractionClosed(id, "Request closed.");
            }
          } else if (message.method === "item/fileChange/patchUpdated") {
            const event = z
              .object({
                threadId: z.string(),
                turnId: z.string(),
                itemId: z.string(),
                changes: fileChangesSchema,
              })
              .parse(message.params);
            if (event.threadId === sessionId && event.turnId === runId) {
              fileChanges.set(event.itemId, event.changes);
              if (!messages.has(event.itemId)) messages.set(event.itemId, "File changes");
              input.onText(formatOutput());
            }
          } else if (message.method === "item/agentMessage/delta") {
            const event = z
              .object({
                threadId: z.string(),
                turnId: z.string(),
                itemId: z.string(),
                delta: z.string(),
              })
              .parse(message.params);
            if (event.threadId !== sessionId || !recordRun(event.turnId)) return;
            messages.set(event.itemId, (messages.get(event.itemId) ?? "") + event.delta);
            input.onText(formatOutput());
          } else if (message.method === "item/started" || message.method === "item/completed") {
            const event = z
              .object({
                threadId: z.string(),
                turnId: z.string(),
                item: z.object({
                  type: z.string(),
                  id: z.string(),
                  text: z.string().optional(),
                  status: z.string().optional(),
                  changes: fileChangesSchema.optional(),
                  delivery: z.string().nullish(),
                  questions: z.array(z.unknown()).nullish(),
                  content: z.unknown().optional(),
                }),
              })
              .parse(message.params);
            if (event.threadId !== sessionId || !recordRun(event.turnId)) return;
            if (event.item.type === "fileChange") {
              if (event.item.changes) fileChanges.set(event.item.id, event.item.changes);
              messages.set(
                event.item.id,
                `File changes${event.item.status ? ` (${event.item.status})` : ""}`,
              );
              input.onText(formatOutput());
            }
            if (event.item.type === "agentMessage" && event.item.text !== undefined) {
              messages.set(event.item.id, event.item.text);
              input.onText(formatOutput());
            }
            if (
              message.method === "item/completed" &&
              event.item.type === "agentMessage" &&
              event.item.delivery === "async" &&
              event.item.questions?.length &&
              !controller.signal.aborted
            )
              openInteraction(message);
            /** 官方客户端把异步答案作为用户消息广播；其他端已答的题立即关闭。 */
            if (event.item.type === "userMessage") {
              for (const content of z
                .array(z.object({ type: z.string(), text: z.string().optional() }))
                .parse(event.item.content ?? [])) {
                if (content.type !== "text") continue;
                const reply = content.text
                  ?.trim()
                  .match(
                    /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/,
                  );
                if (!reply?.[1]) continue;
                let answers: { questionItemId: string }[];
                try {
                  answers = z
                    .preprocess(
                      (value) => (Array.isArray(value) ? value : [value]),
                      z.array(z.object({ questionItemId: z.string(), answer: z.string().min(1) })),
                    )
                    .parse(JSON.parse(reply[1]));
                } catch {
                  /** 普通用户文字也可能包含该标记；无效封套不影响任务。 */
                  continue;
                }
                for (const answer of answers) {
                  seenQuestions.add(answer.questionItemId);
                  for (const [id, interaction] of interactions) {
                    if (
                      interaction.requestId !== null ||
                      !interaction.request.questions.some(
                        (question) =>
                          question.id === answer.questionItemId ||
                          JSON.parse(question.id)[1] === answer.questionItemId,
                      )
                    )
                      continue;
                    clearTimeout(interaction.timer);
                    interactions.delete(id);
                    input.onInteractionClosed(id, "Answered in another client.");
                  }
                }
              }
            }
          } else if (message.method === "turn/started" || message.method === "turn/completed") {
            const event = z
              .object({ threadId: z.string(), turn: turnSchema })
              .parse(message.params);
            if (event.threadId !== sessionId || !recordRun(event.turn.id)) return;
            if (message.method === "turn/completed") {
              finish({
                status:
                  event.turn.status === "completed"
                    ? "completed"
                    : event.turn.status === "failed"
                      ? "failed"
                      : controller.signal.aborted || cancelledByApproval
                        ? "cancelled"
                        : "interrupted",
                text:
                  event.turn.status === "completed"
                    ? ""
                    : event.turn.status === "failed"
                      ? "Codex task failed. Check sign-in, model access, and network."
                      : "Task interrupted. File changes were not reverted.",
              });
            }
          }
        } catch {
          fail(
            "Codex response or state save failed. Task interrupted; check CLI version and storage.",
          );
        }
      }

      const rpc = createCodexRpc(socket, { onMessage, onFailure: fail, onClose });

      steer = async (prompt, attachments) => {
        if (!sessionId || !runId || settled || controller.signal.aborted)
          throw new Error("Codex turn is not running. Input not sent; try again later.");
        const response = z.object({ turnId: z.string() }).parse(
          await request("turn/steer", {
            threadId: sessionId,
            expectedTurnId: runId,
            input: createCodexInput(prompt, attachments),
          }),
        );
        if (response.turnId !== runId) {
          fail("Codex input returned a different turn. Task status unknown.");
          throw new Error("Codex input turn unconfirmed. Not retried; check the session.");
        }
      };

      respond = async (id, answer) => {
        const interaction = interactions.get(id);
        if (
          !interaction ||
          settled ||
          controller.signal.aborted ||
          (interaction.request.expiresAt !== null && interaction.request.expiresAt <= Date.now())
        )
          return false;
        const approval =
          "decision" in answer ? interaction.approvals.get(answer.decision) : undefined;
        if (interaction.request.kind === "approval") {
          if (!("decision" in answer) || !approval) return false;
          if (
            approval.approved &&
            interaction.fileReview &&
            JSON.stringify(fileChanges.get(interaction.fileReview.itemId)) !==
              interaction.fileReview.changes
          ) {
            fail("Changes updated. Review locally, then /resume.");
            return false;
          }
        } else if (
          !("answers" in answer) ||
          Object.keys(answer.answers).length !== interaction.request.questions.length ||
          interaction.request.questions.some((question) => {
            const values = answer.answers[question.id]?.answers;
            return (
              values?.length !== 1 ||
              !values[0]?.trim() ||
              (!question.allowText &&
                !question.options.some((option) => option.label === values[0]))
            );
          })
        )
          return false;
        /** 在写入前移除映射，失败也不重发批准；任务终态负责说明不确定结果。 */
        interactions.delete(id);
        clearTimeout(interaction.timer);
        if (interaction.requestId === null) {
          if (!("answers" in answer) || !steer) return false;
          /** 异步答案沿用官方封套，经当前轮次输入通道提交并等待接收确认。 */
          try {
            await steer(
              `<send_user_message_question_reply>\n${JSON.stringify(
                interaction.request.questions.map((question) => ({
                  questionItemId: question.id,
                  question: question.question,
                  answer: answer.answers[question.id]?.answers[0],
                })),
              )}\n</send_user_message_question_reply>`,
            );
            return true;
          } catch {
            return false;
          }
        }
        if (approval?.result.decision === "cancel") cancelledByApproval = true;
        rpc.write({
          id: interaction.requestId,
          result: approval ? approval.result : answer,
        });
        return !settled;
      };

      try {
        if (controller.signal.aborted)
          return controller.signal.reason === "disconnect"
            ? undefined
            : input.runId
              ? {
                  status: "interrupted",
                  text: "Codex stop unconfirmed. Could not reconnect to the task.",
                }
              : { status: "cancelled", text: "Stopped before starting." };
        const permissionMode = permissionModes.find(
          (mode) => mode.id === (input.permissionMode ?? "default"),
        );
        if (!permissionMode)
          throw new Error(
            "Codex permission mode unavailable. Choose another mode with /permissions.",
          );
        await request("initialize");
        if (input.runId) {
          if (!sessionId) throw new Error("Codex task session missing. Task not resubmitted.");
          /** 恢复订阅时不覆盖权限或提交输入；只接回本任务已确认的轮次。 */
          const resumed = z
            .object({
              thread: z.object({ id: z.string(), status: z.object({ type: z.string() }) }),
            })
            .parse(await request("thread/resume", { threadId: sessionId, excludeTurns: true }));
          if (resumed.thread.id !== sessionId)
            throw new Error("Codex resumed a different session. Check the local session.");
          let cursor: string | null = null;
          do {
            const page = z
              .object({
                data: z.array(turnSchema.extend({ items: z.array(z.unknown()) })),
                nextCursor: z.string().nullable(),
              })
              .parse(
                await request("thread/turns/list", {
                  threadId: sessionId,
                  limit: 1,
                  itemsView: "full",
                  ...(cursor ? { cursor } : {}),
                }),
              );
            const turn = page.data.find((turn) => turn.id === input.runId);
            if (turn) {
              if (turn.status === "inProgress" && resumed.thread.status.type !== "active")
                throw new Error("Codex task is no longer active. Check the local session.");
              recordRun(turn.id);
              /** 完整快照补回离线输出；缓冲增量已包含在快照中，不再次拼接。 */
              for (const item of turn.items)
                onMessage({
                  method: "item/completed",
                  params: { threadId: sessionId, turnId: turn.id, item },
                });
              for (const message of earlyMessages)
                if (message.method !== "item/agentMessage/delta") onMessage(message);
              earlyMessages.length = 0;
              earlyMessageSize = 0;
              if (turn.status !== "inProgress")
                onMessage({ method: "turn/completed", params: { threadId: sessionId, turn } });
              return await completed.promise;
            }
            cursor = page.nextCursor;
          } while (cursor && !controller.signal.aborted);
          throw new Error(
            "Codex task turn missing. Task not resubmitted; check the local session.",
          );
        }
        if (input.sessionId) {
          /** 先查询共享会话，忙碌时不恢复配置、不追加输入，也不中断其他客户端任务。 */
          const current = z
            .object({ thread: z.object({ status: z.object({ type: z.string() }) }) })
            .parse(await request("thread/read", { threadId: input.sessionId }));
          if (!["idle", "notLoaded"].includes(current.thread.status.type))
            throw new Error(
              "Codex session busy or unavailable. Message not sent; wait until it is idle.",
            );
        }
        const response = z
          .object({
            thread: z.object({
              id: z.string().min(1),
              status: z.object({ type: z.string() }).optional(),
            }),
            approvalPolicy: z.unknown(),
            approvalsReviewer: z.string(),
            sandbox: z.object({ type: z.string() }),
            model: z.string().optional(),
          })
          .parse(
            await request(input.sessionId ? "thread/resume" : "thread/start", {
              ...(input.sessionId ? { threadId: input.sessionId, excludeTurns: true } : {}),
              cwd: input.cwd,
              ...permissionMode.config,
              ...(input.model ? { model: input.model } : {}),
            }),
          );
        if (response.thread.status?.type !== "idle")
          throw new Error("Codex session busy. Message not sent; wait until it is idle.");
        /** 模型被服务端替换时停止派发，避免悄悄使用其他模型。 */
        if (input.model && response.model !== input.model)
          throw new Error("Codex did not apply the selected model. Open /model and choose again.");
        /** 使用服务端实际返回值核实预设，不能在权限被改写时仍启动任务。 */
        if (
          response.approvalPolicy !== permissionMode.config.approvalPolicy ||
          response.approvalsReviewer !== permissionMode.config.approvalsReviewer ||
          response.sandbox.type.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`) !==
            permissionMode.config.sandbox
        )
          throw new Error(
            "Codex did not apply the selected permission mode. Task not started; check config and choose a mode with /permissions.",
          );
        sessionId = response.thread.id;
        input.onSession(sessionId);
        if (controller.signal.aborted)
          return controller.signal.reason === "disconnect"
            ? undefined
            : { status: "cancelled", text: "Stopped before starting." };
        dispatched = true;
        const started = await Promise.race([
          request("turn/start", {
            threadId: sessionId,
            input: createCodexInput(input.prompt, input.attachments),
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
          }),
          completed.promise.then(() => null),
        ]);
        if (started !== null && !settled) {
          recordRun(z.object({ turn: turnSchema }).parse(started).turn.id);
          for (const message of earlyMessages) onMessage(message);
          earlyMessages.length = 0;
          earlyMessageSize = 0;
        }
        return await completed.promise;
      } catch (error) {
        if (!settled)
          finish({
            status: dispatched ? "interrupted" : controller.signal.aborted ? "cancelled" : "failed",
            text:
              error instanceof Error && error.message.startsWith("Codex ")
                ? error.message
                : "Codex task failed. Check the local setup.",
          });
        return await completed.promise;
      } finally {
        steer = undefined;
        respond = undefined;
        for (const interaction of interactions.values()) clearTimeout(interaction.timer);
        interactions.clear();
        clearTimeout(stopTimer);
        rpc.close();
        active = undefined;
      }
    },
    /** 外部 ID 必须命中本次连接，不能把旧按钮转交给新一轮任务。 */
    async respond(id, answer) {
      return respond?.(id, answer) ?? false;
    },
    /** 复用当前连接提交补充消息，由 expectedTurnId 防止误入其他轮次。 */
    steer(prompt, attachments) {
      if (!steer)
        return Promise.reject(
          new Error("Codex has no active turn. Input not sent; resend to continue."),
        );
      return steer(prompt, attachments);
    },
    /** 服务退出只断开客户端，保留 Codex daemon 和当前任务。 */
    disconnect() {
      active?.abort("disconnect");
    },
    /** 用户停止等待当前轮次终态；不会退出共享后台服务。 */
    stop() {
      active?.abort();
    },
  };
}
