/** 消息来源标识统一为字符串，兼容不同 IM 的账号与会话格式。 */
export interface ChannelIdentity {
  platform: string;
  accountId: string;
  chatId: string;
  userId: string;
}

/** 入站附件只保存下载所需的引用；随机标识隔离同名文件和重复上传。 */
export interface Attachment {
  id: string;
  fileId: string;
  name: string;
  kind: "image" | "file";
  size: number | null;
}

/** 下载完成后交给 Agent 的本地附件，不包含 Telegram 凭据或下载链接。 */
export interface AgentAttachment {
  name: string;
  path: string;
  kind: "image" | "file";
}

/** 附件准备独立于入站处理；停止任务或服务时可以中止下载。 */
export type AttachmentLoader = (
  attachments: Attachment[],
  signal: AbortSignal,
) => Promise<AgentAttachment[]>;

/** IM 连接层完成身份校验后传入核心层的消息。 */
export interface IncomingMessage {
  channel: ChannelIdentity;
  eventId: string;
  content:
    | { type: "command"; name: string; args: string }
    /** 会话切换由按钮触发，与文本命令分开处理。 */
    | { type: "session"; id: string }
    | { type: "text"; text: string; replyToMessageId?: number }
    | { type: "attachments"; text: string; attachments: Attachment[] }
    | { type: "permissions" | "model"; id: string; optionIndex: number; messageId: number }
    | {
        type: "interaction";
        id: string;
        action: "approval" | "stop" | "option";
        messageId: number;
        questionIndex?: number;
        optionIndex?: number;
      }
    | { type: "unsupported" };
}

/** 只有运行时确认结束才算完成；连接丢失单独记为 interrupted。 */
export interface AgentResult {
  status: "completed" | "failed" | "cancelled" | "interrupted";
  text: string;
}

/** 面向用户的交互快照；随机 ID 只在当前任务连接内有效，不暴露 RPC 请求编号。 */
export interface AgentInteraction {
  id: string;
  kind: "approval" | "question";
  text: string;
  /** 空值表示持续等待，直到用户处理或请求关闭。 */
  expiresAt: number | null;
  blocking: boolean;
  /** 审批选项由 Agent 提供；索引只在当前交互内有效。 */
  choices: AgentOption[];
  questions: {
    id: string;
    header: string;
    question: string;
    options: { label: string; description: string }[];
    allowText: boolean;
  }[];
}

/** 审批决定与按问题 ID 收集的答案分别映射到运行时协议。 */
export type InteractionAnswer =
  | { decision: string }
  | { answers: Record<string, { answers: string[] }> };

/** 模型与权限菜单共用选项；核心层与 IM 只处理标识和展示信息。 */
export interface AgentOption {
  id: string;
  label: string;
}

/** 推理选项与默认值由 Agent 返回，不能假设所有模型支持相同档位。 */
export interface AgentModel extends AgentOption {
  reasoningEfforts: AgentOption[];
  defaultReasoningEffort: string;
}

/** 空值表示沿用 Agent 配置；解析后返回实际模型名称和推理强度。 */
export interface AgentModelSelection {
  model: string | null;
  reasoningEffort: string | null;
}

/** Agent 适配层暴露任务、会话与菜单选项，不向核心层泄露 RPC 类型。 */
export interface Agent {
  name: string;
  version: string;
  /** 第一项为默认模式；模式 ID 由各 Agent 自行解释。 */
  permissionModes: readonly AgentOption[];
  /** 按最近更新时间列出当前目录最多 10 个会话；名称和历史由 Agent 保存。 */
  listSessions(cwd: string, signal: AbortSignal): Promise<AgentOption[]>;
  /** 创建并保存空会话，不启动任务；未指定名称时使用默认名称。 */
  createSession(
    input: {
      cwd: string;
      name: string;
      model: string | null;
      permissionMode: string | null;
    },
    signal: AbortSignal,
  ): Promise<AgentOption>;
  /** 校验会话属于当前目录且可续聊，不恢复会话或修改配置。 */
  readSession(cwd: string, sessionId: string, signal: AbortSignal): Promise<AgentOption>;
  /** 只读取可选模型，不创建会话；独立连接避免影响正在执行的任务。 */
  listModels(cwd: string, signal: AbortSignal): Promise<AgentModel[]>;
  /** 只读查询目录下的有效选择，不创建会话或提交任务。 */
  describeModel(
    cwd: string,
    selection: AgentModelSelection,
    signal: AbortSignal,
  ): Promise<AgentOption & { reasoningEffort: string }>;
  run(input: {
    cwd: string;
    prompt: string;
    attachments?: AgentAttachment[];
    sessionId: string | null;
    /** 已派发的轮次只恢复跟踪，不能再次提交原始输入。 */
    runId?: string | null;
    /** 未选择时由 Agent 使用默认模式，任务提交后不受后续选择影响。 */
    permissionMode?: string | null;
    /** 空值沿用 Agent 配置；选择在任务提交时固定。 */
    model?: string | null;
    /** 与模型一起形成任务快照；空值沿用 Agent 配置。 */
    reasoningEffort?: string | null;
    onSession: (sessionId: string) => void;
    onStarted: (runId: string) => void;
    /** 完整输出快照，包含过程说明、最终回复和文件差异；调用方不能等待 IM 发送。 */
    onText: (text: string) => void;
    /** 执行异常等通知进入持久化消息队列，不依赖流式草稿或任务结束。 */
    onNotice: (text: string) => void;
    onInteraction: (interaction: AgentInteraction) => void;
    onInteractionClosed: (id: string, reason: string) => void;
  }): Promise<AgentResult | undefined>;
  /** 只提交当前连接仍有效的交互；异步问题等待输入确认，不代表操作已经执行。 */
  respond(id: string, answer: InteractionAnswer): Promise<boolean>;
  /** 向当前轮次补充输入，只等待接收确认，不等待任务结束。 */
  steer(prompt: string, attachments?: AgentAttachment[]): Promise<void>;
  /** 只断开客户端；run 返回 undefined，后台任务及持久状态继续保留。 */
  disconnect(): void;
  /** 用户明确停止时才请求取消当前轮次。 */
  stop(): void;
}

/** 返回时表示消息标识及回复意图已保存，不等待 Agent 执行或 IM 发送。 */
export type MessageHandler = (message: IncomingMessage) => Promise<string | undefined>;
