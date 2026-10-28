/** 消息来源标识统一为字符串，兼容不同 IM 的账号与会话格式。 */
export interface ChannelIdentity {
  platform: string;
  accountId: string;
  chatId: string;
  userId: string;
}

/** IM 连接层完成身份校验后传入核心层的消息。 */
export interface IncomingMessage {
  channel: ChannelIdentity;
  eventId: string;
  messageId: string;
  content:
    | { type: "command"; name: string; args: string }
    | { type: "text"; text: string }
    | { type: "unsupported" };
}

/** 只有运行时确认结束才算完成；连接丢失单独记为 interrupted。 */
export interface AgentResult {
  status: "completed" | "failed" | "cancelled" | "interrupted";
  text: string;
}

/** Agent 适配层只暴露任务与会话，不向核心层泄露 RPC 类型。 */
export interface Agent {
  name: string;
  version: string;
  run(input: {
    cwd: string;
    prompt: string;
    sessionId: string | null;
    onSession: (sessionId: string) => void;
    onStarted: (runId: string) => void;
  }): Promise<AgentResult>;
  stop(): void;
}

/** 返回时表示消息及回复意图已保存，不等待 Agent 执行或 IM 发送。 */
export type MessageHandler = (message: IncomingMessage) => Promise<void>;
