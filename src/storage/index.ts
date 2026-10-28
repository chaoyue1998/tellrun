import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { ChannelIdentity } from "../core/types.js";
import * as schema from "./schema.js";

/** 打开 SQLite 并应用已提交的迁移；初始化失败时释放连接。 */
export function openStore(path = "./data/agent-relay.db") {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");

    const db = drizzle(sqlite, { schema });
    migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
    });
    return {
      touchChannel(channel: ChannelIdentity) {
        db.insert(schema.channels)
          .values(channel)
          .onConflictDoUpdate({
            target: [schema.channels.platform, schema.channels.accountId, schema.channels.chatId],
            set: { userId: channel.userId, updatedAt: new Date() },
          })
          .run();
      },
      close() {
        sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/** 对外只暴露实际存储操作，驱动和 SQL 留在本模块内部。 */
export type Store = ReturnType<typeof openStore>;
