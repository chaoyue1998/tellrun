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
  content: { type: "command"; name: string } | { type: "text"; text: string };
}

/** 核心层返回平台无关的回复，具体发送方式由 IM 连接层决定。 */
export interface Reply {
  text: string;
}

/** 每个 IM 连接器通过同一入口调用业务逻辑。 */
export type MessageHandler = (message: IncomingMessage) => Promise<Reply>;
