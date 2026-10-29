import { readFileSync } from "node:fs";
import {
  createJSONRPCErrorResponse,
  createJSONRPCSuccessResponse,
  JSONRPCClient,
  type JSONRPCRequest,
} from "json-rpc-2.0";
import type WebSocket from "ws";
import { z } from "zod";

/** 响应、通知与服务端请求共用边界校验，具体事件内容由 Codex 适配器解释。 */
const messageSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
});

/** 实时事件与恢复后的事件使用同一消息结构。 */
export type CodexMessage = z.infer<typeof messageSchema>;

/** 每条连接独立管理 RPC；关闭只释放连接和等待请求，不取消后台任务。 */
export function createCodexRpc(
  socket: WebSocket,
  handlers: {
    onMessage?: (message: CodexMessage) => void;
    onFailure?: (text: string) => void;
    onClose?: () => void;
  } = {},
) {
  const client = new JSONRPCClient(({ id, method, params }: JSONRPCRequest) =>
    write({ id, method, params }),
  );

  /** 查询取消、任务断开和最终清理共用入口，不发送 turn/interrupt。 */
  function close(reason = "Codex connection closed.") {
    client.rejectAllPendingRequests(reason);
    socket.terminate();
  }

  /** 先通知调用方记录连接故障，再释放全部等待，避免把断线当作任务完成。 */
  function fail(text: string) {
    handlers.onFailure?.(text);
    close(text);
  }

  /** Codex 线上协议省略 jsonrpc 字段；请求、通知与交互应答共用发送入口。 */
  function write(message: unknown) {
    try {
      socket.send(JSON.stringify(message), (error) => {
        if (error) fail("Codex connection write failed. Task status unknown.");
      });
    } catch {
      fail("Codex connection write failed. Task status unknown.");
    }
  }

  /** 请求超时后结束连接，不自动重发可能已执行的操作。 */
  function request(method: string, params: unknown) {
    return client
      .timeout(30_000, (id) => {
        fail(`Codex ${method} timed out. Not retried.`);
        return createJSONRPCErrorResponse(id, 0, "Codex request timed out.");
      })
      .request(method, params);
  }

  socket.on("error", () => fail("Codex connection failed. Task status unknown."));
  socket.on("close", () => {
    client.rejectAllPendingRequests("Codex connection closed.");
    handlers.onClose?.();
  });
  socket.on("message", (data) => {
    try {
      const message = messageSchema.parse(JSON.parse(data.toString()));
      if (message.method) handlers.onMessage?.(message);
      else if (typeof message.id === "number")
        /** 错误来源标记仅供适配器识别；服务端原始错误不能直接转发给用户。 */
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
    } catch {
      fail("Invalid Codex response. Check CLI version and connection.");
    }
  });

  return {
    request,
    write,
    close,
    /** 任务与模型查询使用相同客户端身份；初始化成功后才声明就绪。 */
    async initialize() {
      await request("initialize", {
        clientInfo: {
          name: "tellrun",
          title: "Tellrun",
          version: JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
            .version,
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      write({ method: "initialized" });
    },
  };
}
