import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  createJSONRPCErrorResponse,
  createJSONRPCSuccessResponse,
  JSONRPCClient,
  type JSONRPCRequest,
} from "json-rpc-2.0";
import { z } from "zod";

/** ACP stdio JSON-RPC 2.0 单帧边界校验。 */
const rpcMessageSchema = z.object({
  jsonrpc: z.string().nullish(),
  id: z.union([z.number(), z.string()]).nullish(),
  method: z.string().nullish(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string().nullish() }).nullish(),
});

export type AgyRpcMessage = z.infer<typeof rpcMessageSchema>;

/** 单行输出最大缓冲，避免异常输出占满内存。 */
const maxLineBufferBytes = 16_000_000;

/** 管理单个 agy acp 子进程的双向 JSON-RPC 2.0 通信。 */
export function createAgyRpc(
  command: string,
  env: NodeJS.ProcessEnv,
  handlers: {
    onNotification?: (message: AgyRpcMessage) => void;
    onRequest?: (message: AgyRpcMessage & { id: string | number; method: string }) => void;
    onClose?: (reason: string) => void;
  } = {},
) {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
  } catch (error) {
    throw new Error("Cannot start Antigravity ACP server.", { cause: error });
  }

  let closed = false;
  let buffer = "";

  const client = new JSONRPCClient((payload: JSONRPCRequest) => {
    write(payload);
  });

  /** 统一释放等待请求并终止子进程；重复调用安全幂等。 */
  function close(reason = "Antigravity ACP connection closed.") {
    if (closed) return;
    closed = true;
    client.rejectAllPendingRequests(reason);
    try {
      if (!child.stdin.destroyed) child.stdin.end();
    } catch {
      /** 忽略关闭期间的管道异常。 */
    }
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
      killTimer.unref();
    }
    handlers.onClose?.(reason);
  }

  /** 写入单条换行分隔的 JSON-RPC 消息。 */
  function write(message: unknown) {
    if (closed || !child.stdin.writable || child.stdin.destroyed) {
      throw new Error("Antigravity ACP connection is closed.");
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) close("Antigravity ACP write failed.");
      });
    } catch {
      close("Antigravity ACP write failed.");
    }
  }

  /** 向服务端返回 JSON-RPC 错误应答。 */
  function respondError(id: string | number, code: number, message: string) {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** 捕获子进程管道异常（如子进程退出后的 EPIPE），防止未处理 error 事件导致主进程崩溃。 */
  child.stdin.on("error", () => close("Antigravity ACP write failed."));
  child.stdout.on("error", () => close("Antigravity ACP read failed."));
  child.stderr.on("error", () => {});

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (closed) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > maxLineBufferBytes) {
      close("Antigravity ACP output exceeded buffer limit.");
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: AgyRpcMessage;
      try {
        parsed = rpcMessageSchema.parse(JSON.parse(trimmed));
      } catch {
        /** 忽略非 JSON 诊断输出，防止日志行中断正常协议流。 */
        continue;
      }
      if (parsed.method != null && parsed.id != null) {
        try {
          handlers.onRequest?.(parsed as AgyRpcMessage & { id: string | number; method: string });
        } catch {
          try {
            respondError(parsed.id, -32603, "Internal client error.");
          } catch {
            /** 连接已断开时忽略错误回复失败。 */
          }
        }
      } else if (parsed.method != null) {
        try {
          handlers.onNotification?.(parsed);
        } catch {
          /** 防止未捕获的通知异常击穿主进程事件循环。 */
        }
      } else if (parsed.id != null) {
        client.receive(
          parsed.error != null
            ? createJSONRPCErrorResponse(
                parsed.id,
                parsed.error.code,
                parsed.error.message ?? "",
                "agy",
              )
            : createJSONRPCSuccessResponse(parsed.id, parsed.result),
        );
      }
    }
  });

  /** 排空 stderr，防止子进程日志填满管道造成阻塞。 */
  child.stderr.resume();
  child.on("error", () => close("Antigravity ACP process error."));
  child.on("exit", (code, signal) => {
    close(`Antigravity ACP exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}).`);
  });

  /** 发送请求；timeoutMs 为 0 表示不设固定超时（用于长轮次 session/prompt）。 */
  function request(method: string, params?: unknown, timeoutMs = 45_000): Promise<unknown> {
    if (closed) return Promise.reject(new Error("Antigravity ACP connection is closed."));
    if (timeoutMs <= 0) return Promise.resolve(client.request(method, params));
    return Promise.resolve(
      client
        .timeout(timeoutMs, (id) =>
          createJSONRPCErrorResponse(id, -32001, `Antigravity ${method} timed out.`),
        )
        .request(method, params),
    );
  }

  return {
    get alive() {
      return !closed;
    },
    request,
    notify(method: string, params?: unknown) {
      write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    },
    respond(id: string | number, result: unknown) {
      write({ jsonrpc: "2.0", id, result });
    },
    respondError,
    async initialize() {
      return request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    },
    close,
  };
}

export type AgyRpc = ReturnType<typeof createAgyRpc>;
