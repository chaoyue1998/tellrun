import { z } from "zod";

/** 文件中的标识与时间统一使用安全整数，避免恢复时隐式转换。 */
const id = z.number().int().positive();
const timestamp = z.number().int().nonnegative();

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
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    inboundUpdates: z.array(
      z.strictObject({
        id,
        channelId: id,
        eventId: z.string(),
        messageId: z.string(),
        createdAt: timestamp,
      }),
    ),
    tasks: z.array(
      z.strictObject({
        id,
        channelId: id,
        inboundId: id,
        cwd: z.string(),
        sessionId: z.string().nullable(),
        runId: z.string().nullable(),
        prompt: z.string(),
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
        createdAt: timestamp,
        finishedAt: timestamp.nullable(),
      }),
    ),
    outbox: z.array(
      z.strictObject({
        id,
        channelId: id,
        taskId: id.nullable(),
        key: z.string(),
        text: z.string(),
        status: z.enum(["pending", "failed"]),
        attempts: timestamp,
        retryAt: timestamp,
      }),
    ),
  })
  .refine((state) => {
    const channels = new Set(state.channels.map((row) => row.id));
    const updates = new Map(state.inboundUpdates.map((row) => [row.id, row.channelId]));
    const tasks = new Set(state.tasks.map((row) => row.id));
    return (
      [state.channels, state.inboundUpdates, state.tasks, state.outbox].every(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      ) &&
      new Set(
        state.channels.map((row) => JSON.stringify([row.platform, row.accountId, row.chatId])),
      ).size === state.channels.length &&
      new Set(state.inboundUpdates.map((row) => JSON.stringify([row.channelId, row.eventId])))
        .size === state.inboundUpdates.length &&
      new Set(state.tasks.map((row) => row.inboundId)).size === state.tasks.length &&
      new Set(state.outbox.map((row) => row.key)).size === state.outbox.length &&
      state.inboundUpdates.every((row) => channels.has(row.channelId)) &&
      state.tasks.every(
        (row) =>
          channels.has(row.channelId) &&
          updates.get(row.inboundId) === row.channelId &&
          (row.finishedAt === null) ===
            ["queued", "dispatching", "running", "cancelling"].includes(row.status),
      ) &&
      state.outbox.every(
        (row) => channels.has(row.channelId) && (row.taskId === null || tasks.has(row.taskId)),
      ) &&
      state.tasks.filter((row) => row.finishedAt === null).length <= 1
    );
  }, "状态标识、引用关系或活动任务数量无效");

/** 存储操作共用的文件结构，由运行时校验规则推导。 */
export type State = z.infer<typeof stateSchema>;
