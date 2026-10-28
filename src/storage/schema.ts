import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 每个授权聊天保留一个当前 Agent 会话及工作目录。 */
export const channels = sqliteTable(
  "channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: text("platform").notNull(),
    accountId: text("account_id").notNull(),
    chatId: text("chat_id").notNull(),
    userId: text("user_id").notNull(),
    cwd: text("cwd"),
    sessionId: text("session_id"),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("channels_source_unique").on(table.platform, table.accountId, table.chatId),
  ],
);

/** 消息唯一标识与任务在同一事务内保存，重投不会重复执行。 */
export const inboundUpdates = sqliteTable(
  "inbound_updates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id),
    eventId: text("event_id").notNull(),
    messageId: text("message_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [uniqueIndex("inbound_source_unique").on(table.channelId, table.eventId)],
);

/** 任务保存提交时的目录、会话与输入；全局同时只有一个未结束任务。 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id),
    inboundId: integer("inbound_id")
      .notNull()
      .unique()
      .references(() => inboundUpdates.id),
    cwd: text("cwd").notNull(),
    sessionId: text("session_id"),
    runId: text("run_id"),
    prompt: text("prompt").notNull(),
    status: text("status", {
      enum: [
        "queued",
        "dispatching",
        "running",
        "cancelling",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ],
    }).notNull(),
    result: text("result"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("tasks_single_active").on(sql`(1)`).where(sql`${table.finishedAt} is null`),
    index("tasks_channel_created").on(table.channelId, table.id),
  ],
);

/** 回复先持久化，再由 IM 连接层发送；重试发送不会重新执行任务。 */
export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id),
    taskId: integer("task_id").references(() => tasks.id),
    key: text("key").notNull().unique(),
    text: text("text").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    retryAt: integer("retry_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    messageId: text("message_id"),
  },
  (table) => [index("outbox_pending").on(table.status, table.retryAt, table.id)],
);
