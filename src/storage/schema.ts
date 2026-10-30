import { z } from "zod";

/** 存储操作与状态校验共用的未结束任务状态。 */
export const activeTaskStatuses = new Set<string>([
  "queued",
  "dispatching",
  "running",
  "cancelling",
]);

/** 状态记录共用正整数标识。 */
const id = z.number().int().positive();
/** 重试次数和时间均为非负整数。 */
const nonnegativeInteger = z.number().int().nonnegative();

/** 审批、权限、模型和推理档位共用展示选项。 */
const optionSchema = z.strictObject({ id: z.string().min(1), label: z.string() });

/** 菜单共用有效期和消息清理记录，模型菜单扩展第二步所需的信息。 */
const menuSchema = z.strictObject({
  id: z.uuid(),
  expiresAt: nonnegativeInteger,
  options: z.array(optionSchema),
  messages: z.array(z.strictObject({ messageId: id, text: z.string() })),
});

/** 只保存重启所需的业务状态；文件损坏时拒绝启动，不重置为空状态。 */
export const stateSchema = z
  .strictObject({
    channels: z.array(
      z.strictObject({
        id,
        platform: z.string(),
        accountId: z.string(),
        chatId: z.string(),
        userId: z.string(),
        cwd: z.string().nullable(),
        sessionId: z.string().nullable(),
        paused: z.boolean(),
        /** 模式标识属于 Agent；空值沿用默认模式，兼容旧状态文件。 */
        permissionMode: z.string().min(1).nullable().default(null),
        permissionMenu: menuSchema.nullable().default(null),
        /** 旧状态没有模型选择时沿用 Codex 配置。 */
        model: z.string().min(1).nullable().default(null),
        reasoningEffort: z.string().min(1).nullable().default(null),
        modelMenu: z.preprocess(
          /** 旧菜单没有阶段标记；读取时补齐，原选择与消息清理记录保持不变。 */
          (menu) =>
            menu && typeof menu === "object" && !("stage" in menu)
              ? {
                  ...menu,
                  stage:
                    "model" in menu
                      ? "reasoning"
                      : "options" in menu && Array.isArray(menu.options) && menu.options.length
                        ? "model"
                        : "loading",
                }
              : menu,
          z
            .discriminatedUnion("stage", [
              menuSchema.extend({ stage: z.literal("loading"), options: z.tuple([]) }),
              menuSchema.extend({
                stage: z.literal("model"),
                options: z
                  .array(
                    optionSchema.extend({
                      reasoningEfforts: z.array(optionSchema).default([]),
                      defaultReasoningEffort: z.string().default(""),
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
            .nullable()
            .default(null),
        ),
      }),
    ),
    inboundUpdates: z.array(
      z.strictObject({
        channelId: id,
        eventId: z.string(),
      }),
    ),
    tasks: z.array(
      z.strictObject({
        id,
        channelId: id,
        cwd: z.string(),
        sessionId: z.string().nullable(),
        /** 旧任务没有轮次 ID，仍按结果不确定处理，不能猜测或重跑。 */
        runId: z.string().min(1).nullable().default(null),
        prompt: z.string(),
        permissionMode: z.string().min(1).nullable().default(null),
        model: z.string().min(1).nullable().default(null),
        reasoningEffort: z.string().min(1).nullable().default(null),
        /** 旧状态文件没有补充输入；发送中记录用于重启后避免不确定重放。 */
        inputs: z
          .array(
            z.strictObject({
              text: z.string(),
              status: z.enum(["pending", "sending", "accepted", "failed"]),
            }),
          )
          .default([]),
        status: z.enum([
          "queued",
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
    /** 旧文件自动补空数组；请求编号和等待对象只保存在 Agent 内存中。 */
    interactions: z
      .array(
        z.strictObject({
          id: z.uuid(),
          taskId: id,
          kind: z.enum(["approval", "question"]),
          text: z.string(),
          expiresAt: nonnegativeInteger,
          blocking: z.boolean(),
          /** 兼容旧审批快照；恢复流程仍会作废旧按钮，不重放批准。 */
          choices: z.array(
            z.union([
              optionSchema,
              z.enum(["accept", "decline"]).transform((id) => ({
                id,
                label: id === "accept" ? "Allow once" : "Decline",
              })),
            ]),
          ),
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
      )
      .default([]),
    outbox: z.array(
      z.strictObject({
        id,
        channelId: id,
        text: z.string(),
        attempts: nonnegativeInteger,
        retryAt: nonnegativeInteger,
        interactionId: z.uuid().optional(),
        questionIndex: nonnegativeInteger.optional(),
        promptEnd: z.boolean().optional(),
        /** 有消息 ID 时编辑原消息；关联菜单时更新按钮，否则移除按钮。 */
        messageId: id.optional(),
        permissionMenuId: z.uuid().optional(),
        modelMenuId: z.uuid().optional(),
      }),
    ),
  })
  .refine((state) => {
    const channels = new Set(state.channels.map((row) => row.id));
    return (
      [state.channels, state.tasks, state.outbox].every(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      ) &&
      new Set(
        state.channels.map((row) => JSON.stringify([row.platform, row.accountId, row.chatId])),
      ).size === state.channels.length &&
      new Set(state.inboundUpdates.map((row) => JSON.stringify([row.channelId, row.eventId])))
        .size === state.inboundUpdates.length &&
      state.inboundUpdates.every((row) => channels.has(row.channelId)) &&
      state.tasks.every((row) => channels.has(row.channelId)) &&
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
