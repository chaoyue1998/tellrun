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
  jsonrpc: z.string().optional(),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
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
      child.stdin.end();
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
    if (closed || !child.stdin.writable) {
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
      if (parsed.method !== undefined && parsed.id !== undefined) {
        handlers.onRequest?.(parsed as AgyRpcMessage & { id: string | number; method: string });
      } else if (parsed.method !== undefined) {
        handlers.onNotification?.(parsed);
      } else if (parsed.id !== undefined) {
        client.receive(
          parsed.error
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
    respondError(id: string | number, code: number, message: string) {
      write({ jsonrpc: "2.0", id, error: { code, message } });
    },
    async initialize() {
      return request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    },
    close,
  };
}

export type AgyRpc = ReturnType<typeof createAgyRpc>;
