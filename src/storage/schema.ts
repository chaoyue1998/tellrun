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
      }),
    ),
    outbox: z.array(
      z.strictObject({
        id,
        channelId: id,
        text: z.string(),
        attempts: nonnegativeInteger,
        retryAt: nonnegativeInteger,
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
      state.tasks.filter((row) => activeTaskStatuses.has(row.status)).length <= 1
    );
  }, "状态标识、引用关系或活动任务数量无效");

/** 存储操作共用的文件结构，由运行时校验规则推导。 */
export type State = z.infer<typeof stateSchema>;
