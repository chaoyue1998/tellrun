import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Agent, AgentResult } from "../core/types.js";

/** 由 Codex 0.165.0 的 generate-ts 核对；只校验实际消费的协议字段。 */
const turnSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
});

/** 每次任务使用独立 app-server 连接，续聊使用已持久化的 thread ID。 */
export async function createCodexAgent(command = "codex"): Promise<Agent> {
  /** 保留运行时、认证和代理环境，不向子进程传入 Telegram 凭据。 */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_.*|TERM|TMPDIR|TEMP|TMP|SYSTEMROOT|WINDIR|CODEX_HOME|OPENAI_API_KEY|OPENAI_BASE_URL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(
        key,
      ),
    ),
  );
  const { stdout } = await promisify(execFile)(command, ["--version"], {
    timeout: 5_000,
    maxBuffer: 4_096,
    env,
  });
  if (!/^codex-cli \S+$/.test(stdout.trim())) throw new Error("Codex CLI 返回了无法识别的版本信息");
  let active: AbortController | undefined;

  return {
    name: "Codex",
    version: stdout.trim().replace(/^codex-cli /, ""),
    async run(input) {
      if (active) throw new Error("Codex 已有任务正在执行");
      const controller = new AbortController();
      active = controller;
      const child = spawn(command, ["app-server"], {
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

      /** POSIX 下同时结束受管理进程组，避免切换任务后遗留旧命令。 */
      function terminate(signal: NodeJS.Signals) {
        if (!child.pid) return;
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
          item.reject(new Error(text));
        }
        pending.clear();
      }

      /** 通信故障不等于执行失败；保留不确定状态并结束当前连接。 */
      function fail(text: string) {
        if (settled) return;
        finish({ status: "interrupted", text });
        rejectPending(text);
        controller.abort();
      }

      /** 请求按 ID 关联且有超时；一次仅有一个业务请求及一个中断请求在途。 */
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
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
            if (error) fail("无法写入 Codex 连接，执行状态待确认。");
          });
        });
      }

      /** 通知可能先于 turn/start 响应；只记录当前任务的首个 run ID。 */
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
      child.on("error", () => fail("无法启动 Codex app-server，请检查 CLI 和工作目录。"));
      child.stdin.on("error", () => fail("Codex 输入连接已关闭，执行状态待确认。"));
      child.on("close", (code) => {
        closed.resolve();
        if (controller.signal.aborted && !dispatched)
          finish({ status: "cancelled", text: "任务在开始前已停止。" });
        if (!settled) fail(`Codex 连接已退出（${code ?? "signal"}），请检查本机认证与运行环境。`);
        else rejectPending("Codex 连接已关闭");
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
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
                error: z.object({ code: z.number() }).optional(),
              })
              .parse(JSON.parse(line));
            if (message.id !== undefined && message.method) {
              /** 暂未接入审批与结构化提问界面，明确拒绝并停止，不能静默批准。 */
              child.stdin.write(
                `${JSON.stringify({ id: message.id, error: { code: -32601, message: "This client does not support interactive requests yet" } })}\n`,
              );
              fail(
                "任务需要审批或补充输入，当前版本尚未接入该交互，已中断。请在本机处理后发送 /resume，或调整任务后重新提交。",
              );
            } else if (typeof message.id === "number") {
              const item = pending.get(message.id);
              if (!item) continue;
              clearTimeout(item.timer);
              pending.delete(message.id);
              if (message.error)
                item.reject(
                  new Error(
                    `Codex ${item.method} 请求被拒绝（${message.error.code}）。请检查本机 Codex 配置与认证。`,
                  ),
                );
              else item.resolve(message.result);
            } else if (message.method === "item/completed") {
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
                if (
                  [...messages.values()].reduce((sum, item) => sum + item.text.length, 0) > 256_000
                ) {
                  fail("Codex 文本输出超出限制，任务已中断；可在本机查看会话记录。");
                }
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
      });

      try {
        await request("initialize", {
          clientInfo: { name: "tellrun", title: "Tellrun", version: "1.0.0" },
          capabilities: null,
        });
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
        const response = z.object({ thread: z.object({ id: z.string().min(1) }) }).parse(
          await request(input.sessionId ? "thread/resume" : "thread/start", {
            ...(input.sessionId ? { threadId: input.sessionId, excludeTurns: true } : {}),
            cwd: input.cwd,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
          }),
        );
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
        if (started !== null) recordRun(z.object({ turn: turnSchema }).parse(started).turn.id);
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
    /** 中断当前任务；run 会等待终态或子进程退出后才返回。 */
    stop() {
      active?.abort();
    },
  };
}
