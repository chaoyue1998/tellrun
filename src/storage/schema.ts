import { z } from "zod";

/** 存储操作与状态校验共用的未结束任务状态。 */
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

/** 审批、权限、模型和推理档位共用展示选项。 */
const optionSchema = z.strictObject({ id: z.string().min(1), label: z.string() });

/** 菜单共用有效期和消息清理记录，模型菜单扩展第二步所需的信息。 */
const menuSchema = z.strictObject({
  id: z.uuid(),
  expiresAt: nonnegativeInteger,
  options: z.array(optionSchema),
  messages: z.array(z.strictObject({ messageId: id, text: z.string() })),
});

/** 仅接受当前状态结构；字段缺失或格式无效时拒绝启动，不迁移或清空文件。 */
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
        sessionId: z.string().nullable(),
        paused: z.boolean(),
        /** 模式标识属于 Agent；空值沿用默认模式。 */
        permissionMode: z.string().min(1).nullable(),
        permissionMenu: menuSchema.nullable(),
        /** 显式空值表示沿用 Codex 的模型配置。 */
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
    /** 定时任务 ID 持续递增，删除后不复用；旧状态默认没有定时任务。 */
    nextCronId: id.default(1),
    crons: z
      .array(
        z.strictObject({
          id,
          channelId: id,
          expression: z.string().min(1),
          timezone: z.string().min(1),
          prompt: z.string().min(1),
          cwd: z.string().min(1),
          model: z.string().min(1).nullable(),
          reasoningEffort: z.string().min(1).nullable(),
          permissionMode: z.string().min(1).nullable(),
          enabled: z.boolean(),
          nextRunAt: nonnegativeInteger.nullable(),
          /** 忙碌时同一计划最多保留一次待执行，不积累每次触发记录。 */
          pendingAt: nonnegativeInteger.nullable(),
        }),
      )
      .default([]),
    tasks: z.array(
      z.strictObject({
        id,
        channelId: id,
        /** 执行快照独立于计划，删除计划后仍能跟踪已开始的任务。 */
        cron: z.strictObject({ id, scheduledAt: nonnegativeInteger }).nullable().default(null),
        cwd: z.string(),
        sessionId: z.string().nullable(),
        /** 派发前显式保存空值，取得轮次 ID 后用于重启恢复。 */
        runId: z.string().min(1).nullable(),
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
        /** 仅任务输出使用 Markdown；旧队列和控制消息默认保留原文。 */
        markdown: z.boolean().optional(),
        /** 每张图片独立排队，失败重试不重发已成功的文字或其他图片。 */
        attachment: resultAttachmentSchema.optional(),
        attempts: nonnegativeInteger,
        retryAt: nonnegativeInteger,
        interactionId: z.uuid().optional(),
        questionIndex: nonnegativeInteger.optional(),
        promptEnd: z.boolean().optional(),
        /** 有消息 ID 时编辑原消息；关联菜单时更新按钮，否则移除按钮。 */
        messageId: id.optional(),
        permissionMenuId: z.uuid().optional(),
        modelMenuId: z.uuid().optional(),
        /** 会话列表随回复保存，发送成功后释放；按钮直接引用完整会话 ID。 */
        sessions: z.array(optionSchema).max(10).optional(),
      }),
    ),
  })
  .refine((state) => {
    const channels = new Set(state.channels.map((row) => row.id));
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
      state.outbox.every((row) => channels.has(row.channelId)) &&
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
      state.tasks.filter((row) => activeTaskStatuses.has(row.status)).length <= 1
    );
  }, "Invalid state IDs, references, or active task count.");

/** 存储操作共用的文件结构，由运行时校验规则推导。 */
export type State = z.infer<typeof stateSchema>;
