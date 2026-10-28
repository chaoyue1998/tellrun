import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { z } from "zod";
import type { Agent, AgentResult } from "../core/types.js";

/** 由 Codex 0.165.0 的 generate-ts 核对；只校验实际消费的协议字段。 */
const turnSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
});

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
  if (!/^codex-cli \S+$/.test(stdout.trim())) throw new Error("Codex CLI 返回了无法识别的版本信息");
  let active: AbortController | undefined;
  /** 只绑定当前任务的连接，不能把迟到输入送入下一轮或其他客户端的轮次。 */
  let steer: Agent["steer"] | undefined;

  return {
    name: "Codex",
    version: stdout.trim().replace(/^codex-cli /, ""),
    async run(input) {
      if (active) throw new Error("Codex 已有任务正在执行");
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
      const pending = new Map<
        number,
        {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
          method: string;
        }
      >();
      const messages = new Map<string, { text: string; phase?: string | null | undefined }>();
      let serial = 0;
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
        completed.resolve(result);
      }

      /** 增量与完整消息共用输出上限；只推送回复文本，不推送思考或工具原始输出。 */
      function publishText(text: string) {
        if ([...messages.values()].reduce((sum, item) => sum + item.text.length, 0) > 256_000) {
          fail("Codex 文本输出超出限制，任务已中断；可在本机查看会话记录。");
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
              text: "无法确认 Codex 子进程已停止，请检查本地进程。",
            });
          }
        }
      }

      /** 连接结束时释放所有 RPC 等待，取消初始化也不必等待请求超时。 */
      function rejectPending(text: string) {
        for (const item of pending.values()) {
          clearTimeout(item.timer);
          item.reject(
            new Error(
              item.method === "turn/steer"
                ? "Codex 无法确认补充输入是否已提交，未自动重试。请检查会话后重新发送需要继续的内容。"
                : text,
            ),
          );
        }
        pending.clear();
      }

      /** 通信故障不等于执行失败；保留不确定状态并结束当前连接。 */
      function fail(text: string) {
        if (settled) return;
        finish({ status: "interrupted", text });
        rejectPending(text);
        /** 共享服务不会随连接退出；仅中断已经确认归属本次任务的 turn。 */
        if (socket?.readyState === WebSocket.OPEN && sessionId && runId)
          write({
            id: ++serial,
            method: "turn/interrupt",
            params: { threadId: sessionId, turnId: runId },
          });
        controller.abort();
      }

      /** 请求、通知和交互应答共用发送入口，适配 JSONL 与 WebSocket 帧。 */
      function write(message: unknown) {
        try {
          if (socket)
            socket.send(JSON.stringify(message), (error) => {
              if (error) fail("无法写入 Codex 连接，执行状态待确认。");
            });
          else
            child?.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
              if (error) fail("无法写入 Codex 连接，执行状态待确认。");
            });
        } catch {
          fail("无法写入 Codex 连接，执行状态待确认。");
        }
      }

      /** 请求按 ID 关联且有超时，补充输入和中断使用当前任务的连接。 */
      function request(method: string, params: unknown): Promise<unknown> {
        if (controller.signal.aborted && method !== "turn/interrupt")
          return Promise.reject(new Error("任务已停止"));
        return new Promise((resolve, reject) => {
          const id = ++serial;
          pending.set(id, {
            resolve,
            reject,
            method,
            timer: setTimeout(() => fail(`Codex ${method} 请求超时，未自动重试。`), 30_000),
          });
          write({ id, method, params });
        });
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
          if (settled) return;
          stopTimer = setTimeout(
            () => fail("停止请求未得到确认，已结束 Codex 连接。请检查工作目录后发送 /resume。"),
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
          finish({ status: "cancelled", text: "任务在开始前已停止。" });
        if (!settled) fail(`Codex 连接已退出（${code ?? "signal"}），请检查本机认证与运行环境。`);
        else rejectPending("Codex 连接已关闭");
      }

      /** 两种传输与提前到达的通知共用协议处理，始终只消费当前任务的事件。 */
      function onData(chunk: string) {
        if (settled) return;
        buffer += chunk;
        if (buffer.length > 8_000_000) return fail("Codex 协议缓冲超出限制，任务已中断。");
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
                  return fail("Codex 提前通知超出限制，任务已中断。");
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
              /** 暂未接入审批与结构化提问界面，明确拒绝并停止，不能静默批准。 */
              write({
                id: message.id,
                error: {
                  code: -32601,
                  message: "This client does not support interactive requests yet",
                },
              });
              fail(
                "任务需要审批或补充输入，当前版本尚未接入该交互，已中断。请在本机处理后发送 /resume，或调整任务后重新提交。",
              );
            } else if (typeof message.id === "number") {
              const item = pending.get(message.id);
              if (!item) continue;
              clearTimeout(item.timer);
              pending.delete(message.id);
              /** 只识别已知占用错误，避免把可能含敏感信息的原始错误转发到 IM。 */
              if (message.error)
                item.reject(
                  new Error(
                    item.method === "thread/resume" &&
                      message.error.code === -32600 &&
                      message.error.message?.includes("already has an active writer")
                      ? "Codex 会话仍由其他进程持有，本次任务未开始。请检查本机 Codex 后台连接；空闲会话也可能暂时保留写锁。"
                      : item.method === "turn/steer"
                        ? `Codex 补充输入被拒绝（${message.error.code}），可能当前轮次已结束。请重新发送需要继续的内容。`
                        : `Codex ${item.method} 请求被拒绝（${message.error.code}）。请检查本机 Codex 配置与认证。`,
                  ),
                );
              else item.resolve(message.result);
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
                  }),
                })
                .parse(message.params);
              if (event.threadId !== sessionId || !recordRun(event.turnId)) continue;
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
                      ? "Codex 已完成，本轮没有文本输出。"
                      : event.turn.status === "failed"
                        ? "Codex 未能完成本轮任务，请检查本机认证、模型访问与网络。"
                        : "任务已中断。已完成的文件修改不会自动撤销。"),
                });
              }
            }
          } catch {
            fail("Codex 协议响应或状态保存失败，任务已中断，请检查 CLI 版本与本地存储。");
          }
        }
      }

      child?.on("error", () => fail("无法启动 Codex app-server，请检查 CLI 和工作目录。"));
      child?.stdin.on("error", () => fail("Codex 输入连接已关闭，执行状态待确认。"));
      child?.on("close", onClose);
      child?.stdout.setEncoding("utf8");
      child?.stdout.on("data", onData);
      socket?.on("error", () => fail("Codex 后台连接异常，执行状态待确认。"));
      socket?.on("close", () => onClose(null));
      socket?.on("message", (data) => onData(`${data.toString()}\n`));

      steer = async (prompt) => {
        if (!sessionId || !runId || settled || controller.signal.aborted)
          throw new Error(
            "Codex 当前轮次尚未开始、已结束或正在停止，补充消息未提交。请稍后重新发送。",
          );
        const response = z.object({ turnId: z.string() }).parse(
          await request("turn/steer", {
            threadId: sessionId,
            expectedTurnId: runId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
          }),
        );
        if (response.turnId !== runId) {
          fail("Codex 补充输入返回了不同轮次，执行状态待确认。");
          throw new Error("Codex 无法确认补充输入所属轮次，未自动重试。请检查会话。");
        }
      };

      try {
        if (controller.signal.aborted) return { status: "cancelled", text: "任务在开始前已停止。" };
        await request("initialize", {
          clientInfo: { name: "tellrun", title: "Tellrun", version: "1.0.1" },
          capabilities: null,
        });
        write({ method: "initialized" });
        if (socket && input.sessionId) {
          /** 先查询共享会话，忙碌时不恢复配置、不追加输入，也不中断其他客户端任务。 */
          const current = z
            .object({ thread: z.object({ status: z.object({ type: z.string() }) }) })
            .parse(await request("thread/read", { threadId: input.sessionId }));
          if (!["idle", "notLoaded"].includes(current.thread.status.type))
            throw new Error(
              "Codex 会话仍在执行任务或状态异常，本次消息未提交。请等待当前任务结束后再发送。",
            );
        }
        const response = z
          .object({
            thread: z.object({
              id: z.string().min(1),
              status: z.object({ type: z.string() }).optional(),
            }),
          })
          .parse(
            await request(input.sessionId ? "thread/resume" : "thread/start", {
              ...(input.sessionId ? { threadId: input.sessionId, excludeTurns: true } : {}),
              cwd: input.cwd,
              approvalPolicy: "on-request",
              sandbox: "workspace-write",
            }),
          );
        if (socket && response.thread.status?.type !== "idle")
          throw new Error("Codex 会话当前未空闲，本次消息未提交。请等待当前任务结束后再发送。");
        sessionId = response.thread.id;
        input.onSession(sessionId);
        if (controller.signal.aborted) return { status: "cancelled", text: "任务在开始前已停止。" };
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
                : "Codex 任务未能正常完成，请检查本地运行环境。",
          });
        return await completed.promise;
      } finally {
        steer = undefined;
        clearTimeout(stopTimer);
        rejectPending("Codex 连接已结束");
        terminate("SIGTERM");
        const force = setTimeout(() => terminate("SIGKILL"), 3_000);
        const deadline = setTimeout(
          () => closed.reject(new Error("无法确认 Codex 子进程退出，服务必须停止")),
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
    /** 复用当前连接提交补充消息，由 expectedTurnId 防止误入其他轮次。 */
    steer(prompt) {
      if (!steer)
        return Promise.reject(
          new Error("Codex 当前没有执行中的轮次，补充消息未提交。请重新发送。"),
        );
      return steer(prompt);
    },
    /** 中断当前任务；run 会等待终态或子进程退出后才返回。 */
    stop() {
      active?.abort();
    },
  };
}
