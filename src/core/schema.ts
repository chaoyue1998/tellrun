import { z } from "zod";
import { listPageSize } from "./types.js";

/** 任务规则与状态校验共用的未结束任务状态。 */
export const activeTaskStatuses = new Set<string>([
  "queued",
  "preparing",
  "dispatching",
  "running",
  "cancelling",
]);

/** 状态记录共用正整数标识。 */
const id = z.number().int().positive();
/** 重试次数和时间均为非负整数。 */
const nonnegativeInteger = z.number().int().nonnegative();

/** 附件引用不含凭据；没有附件时显式保存空数组。 */
const attachmentsSchema = z.array(
  z.strictObject({
    id: z.uuid(),
    fileId: z.string().min(1),
    name: z.string(),
    kind: z.enum(["image", "file"]),
    size: nonnegativeInteger.nullable(),
  }),
);

/** 出站附件引用 Agent 已保存的产物，不复制图片正文或保存下载凭据。 */
const resultAttachmentSchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(["image", "file"]),
});

/** 审批、权限、模型、Agent 和推理档位共用展示选项。 */
const optionSchema = z.strictObject({ id: z.string().min(1), label: z.string() });

/** 菜单共用有效期和消息清理记录，模型菜单扩展第二步所需的信息。 */
const menuSchema = z.strictObject({
  id: z.uuid(),
  expiresAt: nonnegativeInteger,
  options: z.array(optionSchema),
  messages: z.array(z.strictObject({ messageId: id, text: z.string() })),
});

/** 会话与目录共用分页状态；会话保存游标，目录保存去重后的选项快照。 */
const listMenuSchema = menuSchema.extend({
  page: nonnegativeInteger,
  loading: z.boolean(),
});

/** 每个 Agent 独立记忆的会话、模型与权限选择，切换回来时按目录恢复。 */
const agentSelectionSchema = z.strictObject({
  cwd: z.string().min(1),
  sessionId: z.string().nullable(),
  permissionMode: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  reasoningEffort: z.string().min(1).nullable(),
});

/** 仅接受当前完整状态结构，字段缺失、额外字段或格式无效时拒绝启动。 */
export const stateSchema = z
  .strictObject({
    channels: z.array(
      z.strictObject({
        id,
        platform: z.string(),
        accountId: z.string(),
        chatId: z.string(),
        userId: z.string(),
        cwd: z.string().min(1),
        /** 当前聊天激活的 Agent 标识。 */
        agent: z.string().min(1),
        /** 切换 Agent 时保存各 Agent 各自的会话与配置快照，便于无损切回。 */
        agentStates: z.record(z.string().min(1), agentSelectionSchema),
        agentMenu: menuSchema.nullable(),
        sessionId: z.string().nullable(),
        /** 尚未取得原生会话 ID 时，用选择版本隔离切换前后的新任务。 */
        sessionGeneration: nonnegativeInteger,
        /** 仅保存当前页选项与已访问页的游标。 */
        sessionMenu: listMenuSchema
          .extend({
            options: z.array(optionSchema).max(listPageSize),
            cursors: z.array(z.string().min(1).nullable()).min(1),
          })
          .refine((menu) => menu.cursors[0] === null && menu.page < menu.cursors.length)
          .nullable(),
        /** 目录仅在菜单有效期内保留，不作为长期历史缓存。 */
        cwdMenu: listMenuSchema
          .refine((menu) => menu.page < Math.max(1, Math.ceil(menu.options.length / listPageSize)))
          .nullable(),
        /** 出站限流按机器人账号共用；撤回消息后也保留，避免重启绕过等待。 */
        replyRetryAt: nonnegativeInteger,
        /** 模式标识属于当前 Agent；空值沿用默认模式。 */
        permissionMode: z.string().min(1).nullable(),
        permissionMenu: menuSchema.nullable(),
        /** 显式空值表示沿用当前 Agent 的模型配置。 */
        model: z.string().min(1).nullable(),
        reasoningEffort: z.string().min(1).nullable(),
        modelMenu: z
          .discriminatedUnion("stage", [
            menuSchema.extend({ stage: z.literal("loading"), options: z.tuple([]) }),
            menuSchema.extend({
              stage: z.literal("model"),
              options: z
                .array(
                  optionSchema.extend({
                    reasoningEfforts: z.array(optionSchema),
                    defaultReasoningEffort: z.string(),
                  }),
                )
                .min(1),
            }),
            menuSchema.extend({
              stage: z.literal("reasoning"),
              /** 第二步只暂存模型，选定推理强度后再一起应用。 */
              model: optionSchema,
              options: z.array(optionSchema).min(1),
            }),
          ])
          .nullable(),
      }),
    ),
    inboundUpdates: z.array(
      z.strictObject({
        channelId: id,
        eventId: z.string(),
      }),
    ),
    /** 定时任务 ID 持续递增，删除后不复用。 */
    nextCronId: id,
    crons: z.array(
      z.strictObject({
        id,
        channelId: id,
        expression: z.string().min(1),
        timezone: z.string().min(1),
        prompt: z.string().min(1),
        cwd: z.string().min(1),
        /** 固定创建计划时选中的 Agent。 */
        agent: z.string().min(1),
        model: z.string().min(1).nullable(),
        reasoningEffort: z.string().min(1).nullable(),
        permissionMode: z.string().min(1).nullable(),
        enabled: z.boolean(),
        nextRunAt: nonnegativeInteger.nullable(),
        /** 忙碌时同一计划最多保留一次待执行，不积累每次触发记录。 */
        pendingAt: nonnegativeInteger.nullable(),
      }),
    ),
    tasks: z.array(
      z.strictObject({
        id,
        channelId: id,
        /** 执行快照独立于计划，删除计划后仍能跟踪已开始的任务。 */
        cron: z.strictObject({ id, scheduledAt: nonnegativeInteger }).nullable(),
        cwd: z.string(),
        /** 固定任务提交时选中的 Agent；不同 Agent 的任务可并发执行。 */
        agent: z.string().min(1),
        sessionId: z.string().nullable(),
        /** 固定提交时的选择版本，防止迟到会话回调覆盖切换后的选择。 */
        sessionGeneration: nonnegativeInteger,
        /** 派发前显式保存空值，取得轮次 ID 后用于重启恢复。 */
        runId: z.string().min(1).nullable(),
        /** Agent 输出分段与消息一一关联，重启和终态均沿用各自的消息。 */
        previewMessages: z.array(z.strictObject({ segmentId: z.string().min(1), messageId: id })),
        prompt: z.string(),
        attachments: attachmentsSchema,
        permissionMode: z.string().min(1).nullable(),
        model: z.string().min(1).nullable(),
        reasoningEffort: z.string().min(1).nullable(),
        /** 发送中记录用于重启后避免不确定重放；没有补充输入时保存空数组。 */
        inputs: z.array(
          z.strictObject({
            text: z.string(),
            attachments: attachmentsSchema,
            status: z.enum(["pending", "preparing", "sending", "accepted", "failed"]),
          }),
        ),
        status: z.enum([
          "queued",
          "preparing",
          "dispatching",
          "running",
          "cancelling",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ]),
        result: z.string().nullable(),
      }),
    ),
    /** 请求编号和等待对象只保存在 Agent 内存中。 */
    interactions: z.array(
      z.strictObject({
        id: z.uuid(),
        taskId: id,
        kind: z.enum(["approval", "question"]),
        text: z.string(),
        /** 审批没有本地期限，问题保存到期时间。 */
        expiresAt: nonnegativeInteger.nullable(),
        blocking: z.boolean(),
        choices: z.array(optionSchema),
        questions: z.array(
          z.strictObject({
            id: z.string(),
            header: z.string(),
            question: z.string(),
            options: z.array(z.strictObject({ label: z.string(), description: z.string() })),
            allowText: z.boolean(),
            answer: z.string().nullable(),
          }),
        ),
        decision: z.string().min(1).nullable(),
        status: z.enum(["pending", "ready", "sending", "closed"]),
        resolution: z.string().nullable(),
        messages: z.array(
          z.strictObject({
            messageId: id,
            questionIndex: nonnegativeInteger.optional(),
            text: z.string(),
          }),
        ),
      }),
    ),
    outbox: z.array(
      z.strictObject({
        id,
        channelId: id,
        text: z.string(),
        /** 最终结果关联执行快照，用于接回预览发送的迟到回执。 */
        taskId: id.optional(),
        /** Agent 分段标识限定迟到回执，只接回该分段的第一条消息。 */
        segmentId: z.string().min(1).optional(),
        /** 任务输出可使用 Markdown；未标记的控制消息保留原文。 */
        markdown: z.boolean().optional(),
        /** 每张图片独立排队，失败重试不重发已成功的文字或其他图片。 */
        attachment: resultAttachmentSchema.optional(),
        /** 控制回复优先于普通任务结果投递。 */
        priority: z.boolean(),
        /** 同一回复的前一段或正文；前项出队后才能发送，重启后仍保持顺序。 */
        afterId: id.optional(),
        attempts: nonnegativeInteger,
        retryAt: nonnegativeInteger,
        interactionId: z.uuid().optional(),
        questionIndex: nonnegativeInteger.optional(),
        promptEnd: z.boolean().optional(),
        /** 有消息 ID 时编辑原消息；关联菜单时更新按钮，否则移除按钮。 */
        messageId: id.optional(),
        permissionMenuId: z.uuid().optional(),
        modelMenuId: z.uuid().optional(),
        agentMenuId: z.uuid().optional(),
        sessionMenuId: z.uuid().optional(),
        cwdMenuId: z.uuid().optional(),
      }),
    ),
  })
  .refine((state) => {
    const channels = new Set(state.channels.map((row) => row.id));
    const active = state.tasks.filter((row) => activeTaskStatuses.has(row.status));
    /** 原生会话按 Agent 隔离且唯一占用；未绑定的手动任务按 Agent、聊天、目录和版本区分。 */
    const sessionKeys = active.map((row) =>
      JSON.stringify(
        row.sessionId !== null
          ? ["session", row.agent, row.sessionId]
          : row.cron
            ? ["cron", row.id]
            : ["selection", row.agent, row.channelId, row.cwd, row.sessionGeneration],
      ),
    );
    return (
      [state.channels, state.tasks, state.outbox, state.crons].every(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      ) &&
      new Set(
        state.channels.map((row) => JSON.stringify([row.platform, row.accountId, row.chatId])),
      ).size === state.channels.length &&
      new Set(state.inboundUpdates.map((row) => JSON.stringify([row.channelId, row.eventId])))
        .size === state.inboundUpdates.length &&
      state.inboundUpdates.every((row) => channels.has(row.channelId)) &&
      state.tasks.every((row) => channels.has(row.channelId)) &&
      state.crons.every(
        (row) =>
          channels.has(row.channelId) &&
          row.id < state.nextCronId &&
          (row.enabled ? row.nextRunAt !== null : row.nextRunAt === null && row.pendingAt === null),
      ) &&
      state.tasks.every((row) => !row.cron || row.cron.id < state.nextCronId) &&
      state.outbox.every(
        (row) => channels.has(row.channelId) && (row.afterId === undefined || row.afterId < row.id),
      ) &&
      new Set(state.interactions.map((row) => row.id)).size === state.interactions.length &&
      state.interactions.every(
        (row) =>
          state.tasks.some((task) => task.id === row.taskId) &&
          new Set(row.questions.map((question) => question.id)).size === row.questions.length,
      ) &&
      state.outbox.every(
        (row) =>
          !row.interactionId || state.interactions.some((item) => item.id === row.interactionId),
      ) &&
      new Set(sessionKeys).size === active.length
    );
  }, "Invalid state IDs, references, or duplicate active sessions.");

/** 核心层定义业务状态结构，持久化边界复用同一校验规则。 */
export type State = z.infer<typeof stateSchema>;
