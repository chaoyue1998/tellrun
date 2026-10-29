import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
import type { Agent, AgentInteraction, AgentResult } from "../core/types.js";
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

/** 优先连接本机后台服务，否则启动独立进程；续聊使用已持久化的 thread ID。 */
export async function createCodexAgent(command = "codex"): Promise<Agent> {
  /** 保留运行时、认证和代理环境，不向子进程传入 Telegram 凭据。 */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_.*|TERM|TMPDIR|TEMP|TMP|SYSTEMROOT|WINDIR|CODEX_HOME|OPENAI_API_KEY|OPENAI_BASE_URL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(
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

  return {
    name: "Codex",
    version: stdout.trim().replace(/^codex-cli /, ""),
    permissionModes: permissionModes.map(({ id, label }) => ({ id, label })),
    async run(input) {
      if (active) throw new Error("Codex is already running a task.");
      const controller = new AbortController();
      active = controller;
      /** 后台服务会保留空闲会话的写锁，复用其连接才能立即恢复同一会话。 */
      const socketPath = join(
        env.CODEX_HOME ?? join(homedir(), ".codex"),
        "app-server-control",
        "app-server-control.sock",
      );
      const socket =
        process.platform !== "win32" && existsSync(socketPath)
          ? await new Promise<WebSocket | undefined>((resolve) => {
              const connection = new WebSocket("ws://localhost", {
                createConnection: () => connect(socketPath),
                handshakeTimeout: 5_000,
                maxPayload: 8_000_000,
              });
              connection.once("open", () => resolve(connection));
              connection.once("error", () => resolve(undefined));
            })
          : undefined;
      const child = socket
        ? undefined
        : spawn(command, ["app-server"], {
            cwd: input.cwd,
            env,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "ignore"],
          });
      const closed = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<AgentResult>();
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
      /** turn/start 响应前的事件暂存，收到当前 turn ID 后再处理，避免混入其他客户端事件。 */
      let earlyMessages = "";
      let sessionId: string | undefined;
      let runId: string | undefined;
      let dispatched = false;
      let settled = false;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;

      /** 只接受第一个终态，避免退出事件覆盖已经确认的执行结果。 */
      function finish(result: AgentResult) {
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

      /** 共享后台仅断开自己的连接；独立进程按进程组清理。 */
      function terminate(signal: NodeJS.Signals) {
        if (socket) {
          socket.terminate();
          return;
        }
        if (!child?.pid) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            finish({
              status: "interrupted",
              text: "Codex stop unconfirmed. Check local processes.",
            });
          }
        }
      }

      /** 通信故障不等于执行失败；保留不确定状态并结束当前连接。 */
      function fail(text: string) {
        if (settled) return;
        finish({ status: "interrupted", text });
        /** 共享服务不会随连接退出；仅中断已经确认归属本次任务的 turn。 */
        if (socket?.readyState === WebSocket.OPEN && sessionId && runId)
          void request("turn/interrupt", { threadId: sessionId, turnId: runId }).catch(() => {});
        client.rejectAllPendingRequests(text);
        controller.abort();
      }

      /** 请求、通知和交互应答共用发送入口，适配 JSONL 与 WebSocket 帧。 */
      function write(message: unknown) {
        try {
          if (socket)
            socket.send(JSON.stringify(message), (error) => {
              if (error) fail("Codex connection write failed. Task status unknown.");
            });
          else
            child?.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
              if (error) fail("Codex connection write failed. Task status unknown.");
            });
        } catch {
          fail("Codex connection write failed. Task status unknown.");
        }
      }

      /** 超时仍终止任务；区分服务端拒绝与连接故障，保留补充输入的不确定状态。 */
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

      /** 以 turn/start 响应确认本次任务的 run ID，其他客户端的事件不能改变归属。 */
      function recordRun(id: string) {
        if (runId && runId !== id) return false;
        if (!runId) {
          runId = id;
          input.onStarted();
        }
        return true;
      }

      controller.signal.addEventListener(
        "abort",
        () => {
          for (const interaction of interactions.values()) clearTimeout(interaction.timer);
          interactions.clear();
          if (settled) return;
          stopTimer = setTimeout(
            () => fail("Stop unconfirmed; Codex disconnected. Check the project before /resume."),
            5_000,
          );
          if (sessionId && runId) {
            void request("turn/interrupt", { threadId: sessionId, turnId: runId }).catch(() =>
              terminate("SIGTERM"),
            );
          } else terminate("SIGTERM");
        },
        { once: true },
      );
      /** 两种传输共用关闭处理；连接中断不能当作共享后台中的任务已经停止。 */
      function onClose(code: number | null) {
        closed.resolve();
        if (controller.signal.aborted && !dispatched)
          finish({ status: "cancelled", text: "Stopped before starting." });
        if (!settled)
          fail(`Codex disconnected (${code ?? "signal"}). Check sign-in and local setup.`);
        else client.rejectAllPendingRequests("Codex connection closed.");
      }

      /** 两种传输与提前到达的通知共用协议处理，始终只消费当前任务的事件。 */
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

      child?.on("error", () =>
        fail("Cannot start Codex app-server. Check CLI and working directory."),
      );
      child?.stdin.on("error", () => fail("Codex input closed. Task status unknown."));
      child?.on("close", onClose);
      child?.stdout.setEncoding("utf8");
      child?.stdout.on("data", onData);
      socket?.on("error", () => fail("Codex connection failed. Task status unknown."));
      socket?.on("close", () => onClose(null));
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
          return { status: "cancelled", text: "Stopped before starting." };
        const permissionMode = permissionModes.find(
          (mode) => mode.id === (input.permissionMode ?? "default"),
        );
        if (!permissionMode)
          throw new Error(
            "Codex permission mode unavailable. Choose another mode with /permissions.",
          );
        await request("initialize", {
          clientInfo: {
            name: "tellrun",
            title: "Tellrun",
            /** 源码和编译产物都读取包版本，与 CLI 的版本显示保持一致。 */
            version: JSON.parse(
              readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
            ).version,
          },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        write({ method: "initialized" });
        if (socket && input.sessionId) {
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
          })
          .parse(
            await request(input.sessionId ? "thread/resume" : "thread/start", {
              ...(input.sessionId ? { threadId: input.sessionId, excludeTurns: true } : {}),
              cwd: input.cwd,
              ...permissionMode.config,
            }),
          );
        if (socket && response.thread.status?.type !== "idle")
          throw new Error("Codex session busy. Message not sent; wait until it is idle.");
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
          return { status: "cancelled", text: "Stopped before starting." };
        dispatched = true;
        const started = await Promise.race([
          request("turn/start", {
            threadId: sessionId,
            input: [{ type: "text", text: input.prompt, text_elements: [] }],
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
        terminate("SIGTERM");
        const force = setTimeout(() => terminate("SIGKILL"), 3_000);
        const deadline = setTimeout(
          () => closed.reject(new Error("Codex exit unconfirmed. Service must stop.")),
          8_000,
        );
        try {
          await closed.promise;
          terminate("SIGKILL");
        } finally {
          clearTimeout(force);
          clearTimeout(deadline);
          active = undefined;
        }
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
    /** 中断当前任务；run 会等待终态或子进程退出后才返回。 */
    stop() {
      active?.abort();
    },
  };
}
