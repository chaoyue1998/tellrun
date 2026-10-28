import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 已授权的 IM 会话；Agent 会话和任务字段随对应功能添加。 */
export const channels = sqliteTable(
  "channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: text("platform").notNull(),
    accountId: text("account_id").notNull(),
    chatId: text("chat_id").notNull(),
    userId: text("user_id").notNull(),
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
