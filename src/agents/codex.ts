import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  createJSONRPCErrorResponse,
  createJSONRPCSuccessResponse,
  JSONRPCClient,
  JSONRPCErrorException,
  type JSONRPCRequest,
} from "json-rpc-2.0";
import WebSocket from "ws";
import { z } from "zod";
import type { Agent, AgentInteraction, AgentModel, AgentResult } from "../core/types.js";
import { fileChangesSchema, parseCodexInteraction } from "./codex-interaction.js";

/** 由 Codex 0.165.0 的 generate-ts 核对；只校验实际消费的协议字段。 */
const turnSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
});

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

  /** 任务与模型查询使用同一客户端身份和协议能力。 */
  const initialization = {
    clientInfo: {
      name: "tellrun",
      title: "Tellrun",
      version: JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
        .version,
    },
    capabilities: { experimentalApi: true, requestAttestation: false },
  };

  /** 任务与只读查询共用连接流程；各自使用独立 socket，不争用会话。 */
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

  return {
    name: "Codex",
    version: stdout.trim().replace(/^codex-cli /, ""),
    permissionModes: permissionModes.map(({ id, label }) => ({ id, label })),
    /** 分页读取模型目录；不恢复会话、不发起轮次，也不影响任务连接。 */
    async listModels(cwd, signal) {
      signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const socket = await connectServer(cwd, signal);
      const client = new JSONRPCClient(({ id, method, params }: JSONRPCRequest) => {
        socket.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) client.rejectAllPendingRequests("Codex model query failed.");
        });
      });
      /** 取消仅关闭目录查询，不能向正在运行的轮次发送中断。 */
      const abort = () => {
        client.rejectAllPendingRequests("Codex model query cancelled.");
        socket.terminate();
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.on("error", () => client.rejectAllPendingRequests("Codex model query failed."));
      socket.on("close", () => client.rejectAllPendingRequests("Codex model query closed."));
      socket.on("message", (data) => {
        try {
          const message = z
            .object({
              id: z.number().optional(),
              result: z.unknown().optional(),
              error: z.object({ code: z.number(), message: z.string() }).optional(),
            })
            .parse(JSON.parse(data.toString()));
          if (message.id !== undefined)
            client.receive(
              message.error
                ? createJSONRPCErrorResponse(
                    message.id,
                    message.error.code,
                    "Codex model query rejected.",
                  )
                : createJSONRPCSuccessResponse(message.id, message.result),
            );
        } catch {
          client.rejectAllPendingRequests("Invalid Codex model response.");
          socket.terminate();
        }
      });
      try {
        signal.throwIfAborted();
        await client.request("initialize", initialization);
        socket.send(JSON.stringify({ method: "initialized" }));
        const models: AgentModel[] = [];
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
              await client.request("model/list", { limit: 100, includeHidden: false, cursor }),
            );
          for (const model of page.data)
            if (!model.hidden && !models.some((option) => option.id === model.model))
              models.push({
                id: model.model,
                label: model.displayName || model.model,
                reasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
                  id: effort.reasoningEffort,
                  label: effort.description,
                })),
                defaultReasoningEffort: model.defaultReasoningEffort,
              });
          cursor = page.nextCursor;
        } while (cursor);
        return models;
      } finally {
        signal.removeEventListener("abort", abort);
        client.rejectAllPendingRequests("Codex model query closed.");
        socket.terminate();
      }
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
      /** 库管理请求关联和超时；Codex 线上消息省略 jsonrpc 字段。 */
      const client = new JSONRPCClient(({ id, method, params }: JSONRPCRequest) =>
        write({ id, method, params }),
      );
      const messages = new Map<string, { text: string; phase?: string | null | undefined }>();
      /** 应用随机 ID 隔离每次连接；已见 RPC 编号保留到任务结束，重复请求不生成新按钮。 */
      const interactions = new Map<
        string,
        {
          requestId: string | number;
          request: AgentInteraction;
          timer: ReturnType<typeof setTimeout>;
          permissions?: Record<string, unknown>;
          fileReview?: { itemId: string; changes: string };
        }
      >();
      const seenRequests = new Set<string | number>();
      const fileChanges = new Map<string, z.infer<typeof fileChangesSchema>>();
      let buffer = "";
      /** 新任务等启动响应，恢复任务等完整快照，再处理当前轮次的早到事件。 */
      let earlyMessages = "";
      let sessionId = input.sessionId ?? undefined;
      let runId: string | undefined;
      let dispatched = Boolean(input.runId);
      let settled = false;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;

      /** 只接受第一个终态，避免退出事件覆盖已经确认的执行结果。 */
      function finish(result?: AgentResult) {
        if (settled) return;
        settled = true;
        for (const interaction of interactions.values()) clearTimeout(interaction.timer);
        interactions.clear();
        completed.resolve(result);
      }

      /** 增量与完整消息共用输出上限；只推送回复文本，不推送思考或工具原始输出。 */
      function publishText(text: string) {
        if ([...messages.values()].reduce((sum, item) => sum + item.text.length, 0) > 256_000) {
          fail("Codex output limit exceeded. Task interrupted; check the local session.");
          return;
        }
        input.onText(text);
      }

      /** 通信故障不等于执行失败；保留不确定状态并结束当前连接。 */
      function fail(text: string) {
        if (settled) return;
        finish({ status: "interrupted", text });
        client.rejectAllPendingRequests(text);
        controller.abort();
      }

      /** 请求、通知和交互应答共用发送入口，一帧对应一条 RPC 消息。 */
      function write(message: unknown) {
        try {
          socket?.send(JSON.stringify(message), (error) => {
            if (error) fail("Codex connection write failed. Task status unknown.");
          });
        } catch {
          fail("Codex connection write failed. Task status unknown.");
        }
      }

      /** 超时结束本次跟踪；区分服务端拒绝与连接故障，保留输入的不确定状态。 */
      async function request(method: string, params: unknown): Promise<unknown> {
        if (controller.signal.aborted && method !== "turn/interrupt")
          throw new Error("Task stopped.");
        try {
          return await client
            .timeout(30_000, (id) => {
              fail(`Codex ${method} timed out. Not retried.`);
              return createJSONRPCErrorResponse(id, 0, "Codex request timed out.");
            })
            .request(method, params);
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
            client.rejectAllPendingRequests("Tellrun disconnected. Task continues in Codex.");
            socket?.terminate();
            return;
          }
          stopTimer = setTimeout(
            () => fail("Stop unconfirmed; Codex disconnected. Check the project before /resume."),
            5_000,
          );
          if (sessionId && runId) {
            void request("turn/interrupt", { threadId: sessionId, turnId: runId }).catch(() =>
              socket?.terminate(),
            );
          } else socket?.terminate();
        },
        { once: true },
      );
      /** 连接关闭不能当作后台任务已停止，更不能向后台补发取消。 */
      function onClose() {
        if (controller.signal.aborted && !dispatched)
          finish({ status: "cancelled", text: "Stopped before starting." });
        if (!settled)
          fail("Codex disconnected. Task may still be running; check the local session.");
        else client.rejectAllPendingRequests("Codex connection closed.");
      }

      /** 实时事件与恢复快照共用协议处理，始终只消费当前任务的事件。 */
      function onData(chunk: string) {
        if (settled) return;
        buffer += chunk;
        if (buffer.length > 8_000_000)
          return fail("Codex buffer limit exceeded. Task interrupted.");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim() || settled) continue;
          try {
            const message = z
              .object({
                id: z.union([z.number(), z.string()]).optional(),
                method: z.string().optional(),
                params: z.unknown().optional(),
                result: z.unknown().optional(),
                error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
              })
              .parse(JSON.parse(line));
            if (message.method && !runId) {
              if (dispatched) {
                earlyMessages += `${line}\n`;
                if (earlyMessages.length > 8_000_000)
                  return fail("Codex event limit exceeded. Task interrupted.");
              }
              continue;
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
                continue;
              if (controller.signal.aborted || seenRequests.has(message.id)) continue;
              seenRequests.add(message.id);
              const parsed = parseCodexInteraction(
                message.method,
                message.params,
                input.cwd,
                fileChanges,
              );
              if ("error" in parsed) {
                if (parsed.unsupported)
                  write({
                    id: message.id,
                    error: { code: -32601, message: "Unsupported interactive request" },
                  });
                fail(parsed.error);
                continue;
              }
              const { request: interaction } = parsed;
              interactions.set(interaction.id, {
                requestId: message.id,
                ...parsed,
                timer: setTimeout(
                  () => {
                    const pending = interactions.get(interaction.id);
                    if (!pending) return;
                    if (interaction.blocking) {
                      fail("Request timed out. Check /last, then /resume.");
                    } else {
                      interactions.delete(interaction.id);
                      /** 非阻塞问题过期只返回空答案，不替用户选择，也不中断正在执行的任务。 */
                      try {
                        input.onInteractionClosed(
                          interaction.id,
                          "Question expired. Task continues.",
                        );
                        write({ id: pending.requestId, result: { answers: {} } });
                      } catch {
                        fail("Cannot save expired question state. Task interrupted.");
                      }
                    }
                  },
                  Math.max(0, interaction.expiresAt - Date.now()),
                ),
              });
              input.onInteraction(interaction);
            } else if (typeof message.id === "number") {
              /** 补齐库需要的协议字段；错误来源标记仅用于本地处理，不信任服务端 data。 */
              client.receive(
                message.error
                  ? createJSONRPCErrorResponse(
                      message.id,
                      message.error.code,
                      message.error.message ?? "",
                      "codex",
                    )
                  : createJSONRPCSuccessResponse(message.id, message.result),
              );
            } else if (message.method === "serverRequest/resolved") {
              const event = z
                .object({ threadId: z.string(), requestId: z.union([z.string(), z.number()]) })
                .parse(message.params);
              if (event.threadId !== sessionId) continue;
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
              if (event.threadId === sessionId && event.turnId === runId)
                fileChanges.set(event.itemId, event.changes);
            } else if (message.method === "item/agentMessage/delta") {
              const event = z
                .object({
                  threadId: z.string(),
                  turnId: z.string(),
                  itemId: z.string(),
                  delta: z.string(),
                })
                .parse(message.params);
              if (event.threadId !== sessionId || !recordRun(event.turnId)) continue;
              const item = messages.get(event.itemId) ?? { text: "" };
              item.text += event.delta;
              messages.set(event.itemId, item);
              publishText(item.text);
            } else if (message.method === "item/started" || message.method === "item/completed") {
              const event = z
                .object({
                  threadId: z.string(),
                  turnId: z.string(),
                  item: z.object({
                    type: z.string(),
                    id: z.string(),
                    text: z.string().optional(),
                    phase: z.string().nullish(),
                    changes: fileChangesSchema.optional(),
                  }),
                })
                .parse(message.params);
              if (event.threadId !== sessionId || !recordRun(event.turnId)) continue;
              if (event.item.type === "fileChange" && event.item.changes)
                fileChanges.set(event.item.id, event.item.changes);
              if (event.item.type === "agentMessage" && event.item.text !== undefined) {
                messages.set(event.item.id, { text: event.item.text, phase: event.item.phase });
                publishText(event.item.text);
              }
            } else if (message.method === "turn/started" || message.method === "turn/completed") {
              const event = z
                .object({ threadId: z.string(), turn: turnSchema })
                .parse(message.params);
              if (event.threadId !== sessionId || !recordRun(event.turn.id)) continue;
              if (message.method === "turn/completed") {
                const final = [...messages.values()].filter(
                  (item) => item.phase === "final_answer",
                );
                finish({
                  status:
                    event.turn.status === "completed"
                      ? "completed"
                      : event.turn.status === "failed"
                        ? "failed"
                        : controller.signal.aborted
                          ? "cancelled"
                          : "interrupted",
                  text:
                    (final.length ? final : [...messages.values()])
                      .map((item) => item.text)
                      .join("\n\n") ||
                    (event.turn.status === "completed"
                      ? "Codex finished with no text output."
                      : event.turn.status === "failed"
                        ? "Codex task failed. Check sign-in, model access, and network."
                        : "Task interrupted. File changes were not reverted."),
                });
              }
            }
          } catch {
            fail(
              "Codex response or state save failed. Task interrupted; check CLI version and storage.",
            );
          }
        }
      }

      socket?.on("error", () => fail("Codex connection failed. Task status unknown."));
      socket?.on("close", onClose);
      socket?.on("message", (data) => onData(`${data.toString()}\n`));

      steer = async (prompt) => {
        if (!sessionId || !runId || settled || controller.signal.aborted)
          throw new Error("Codex turn is not running. Input not sent; try again later.");
        const response = z.object({ turnId: z.string() }).parse(
          await request("turn/steer", {
            threadId: sessionId,
            expectedTurnId: runId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
          }),
        );
        if (response.turnId !== runId) {
          fail("Codex input returned a different turn. Task status unknown.");
          throw new Error("Codex input turn unconfirmed. Not retried; check the session.");
        }
      };

      respond = (id, answer) => {
        const interaction = interactions.get(id);
        if (
          !interaction ||
          settled ||
          controller.signal.aborted ||
          interaction.request.expiresAt <= Date.now()
        )
          return false;
        if (interaction.request.kind === "approval") {
          if (!("decision" in answer) || !interaction.request.choices.includes(answer.decision))
            return false;
          if (
            answer.decision === "accept" &&
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
        write({
          id: interaction.requestId,
          result: interaction.permissions
            ? {
                permissions:
                  "decision" in answer && answer.decision === "accept"
                    ? interaction.permissions
                    : {},
                scope: "turn",
              }
            : answer,
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
        await request("initialize", initialization);
        write({ method: "initialized" });
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
                onData(
                  `${JSON.stringify({ method: "item/completed", params: { threadId: sessionId, turnId: turn.id, item } })}\n`,
                );
              onData(
                `${earlyMessages
                  .split("\n")
                  .filter((line) => line && JSON.parse(line).method !== "item/agentMessage/delta")
                  .join("\n")}\n`,
              );
              earlyMessages = "";
              if (turn.status !== "inProgress")
                onData(
                  `${JSON.stringify({ method: "turn/completed", params: { threadId: sessionId, turn } })}\n`,
                );
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
            input: [{ type: "text", text: input.prompt, text_elements: [] }],
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
          }),
          completed.promise.then(() => null),
        ]);
        if (started !== null && !settled) {
          recordRun(z.object({ turn: turnSchema }).parse(started).turn.id);
          earlyMessages += buffer;
          buffer = "";
          onData(earlyMessages);
          earlyMessages = "";
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
        client.rejectAllPendingRequests("Codex connection closed.");
        socket?.terminate();
        active = undefined;
      }
    },
    /** 外部 ID 必须命中本次连接，不能把旧按钮转交给新一轮任务。 */
    respond(id, answer) {
      return respond?.(id, answer) ?? false;
    },
    /** 复用当前连接提交补充消息，由 expectedTurnId 防止误入其他轮次。 */
    steer(prompt) {
      if (!steer)
        return Promise.reject(
          new Error("Codex has no active turn. Input not sent; resend to continue."),
        );
      return steer(prompt);
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
