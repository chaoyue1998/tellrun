import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { appDirectory } from "../config.js";
import type { AgentResult, ChannelIdentity, IncomingMessage } from "../core/types.js";
import * as schema from "./schema.js";

/** 打开 SQLite 并应用已提交的迁移；初始化失败时释放连接。 */
export function openStore(path = join(appDirectory, "agent-relay.db")) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (dirname(path) === appDirectory) chmodSync(appDirectory, 0o700);
  }

  const sqlite = new Database(path);
  let lock: Database.Database | undefined;
  try {
    /** 独立 SQLite 写锁约束单实例；进程退出会释放锁，不依赖清理 PID 文件。 */
    if (path !== ":memory:") {
      lock = new Database(`${path}.lock`, { timeout: 0 });
      chmodSync(path, 0o600);
      chmodSync(`${path}.lock`, 0o600);
      lock.exec("BEGIN EXCLUSIVE");
    }
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");

    const db = drizzle(sqlite, { schema });
    migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
    });

    /** 按 Unicode 字符拆分，含表情的消息也不超过 Telegram 的长度限制。 */
    function enqueueReply(
      channelId: number,
      key: string,
      text: string,
      taskId: number | null = null,
    ) {
      const parts = text.match(/[\s\S]{1,2000}/gu) ?? ["（没有文本回复）"];
      for (const [index, part] of parts.entries()) {
        db.insert(schema.outbox)
          .values({
            channelId,
            taskId,
            key: `${key}:${index}`,
            text: parts.length > 1 ? `（${index + 1}/${parts.length}）\n${part}` : part,
          })
          .onConflictDoNothing()
          .run();
      }
    }

    /** 终态与最终回复一起提交；迟到事件不能重复结束任务或覆盖结果。 */
    function finishTask(id: number, result: AgentResult) {
      db.transaction(() => {
        const task = db
          .update(schema.tasks)
          .set({
            status: result.status,
            result: result.text,
            finishedAt: new Date(),
          })
          .where(and(eq(schema.tasks.id, id), isNull(schema.tasks.finishedAt)))
          .returning()
          .get();
        if (!task) return;
        if (result.status === "interrupted") {
          db.update(schema.channels)
            .set({ paused: true })
            .where(eq(schema.channels.id, task.channelId))
            .run();
        }
        enqueueReply(
          task.channelId,
          `task:${id}`,
          `任务 #${id} ${
            {
              completed: "已完成",
              failed: "失败",
              cancelled: "已停止",
              interrupted: "执行状态待确认",
            }[result.status]
          }\n${result.text}`,
          id,
        );
      });
    }

    return {
      /** 去重、业务写入和回复意图共用事务，成功返回后才能确认入站事件。 */
      accept(
        message: IncomingMessage,
        handle: (channel: typeof schema.channels.$inferSelect, inboundId: number) => string,
      ) {
        db.transaction(() => {
          const channel = db
            .insert(schema.channels)
            .values(message.channel)
            .onConflictDoUpdate({
              target: [schema.channels.platform, schema.channels.accountId, schema.channels.chatId],
              set: { userId: message.channel.userId, updatedAt: new Date() },
            })
            .returning()
            .get();
          const inbound = db
            .insert(schema.inboundUpdates)
            .values({
              channelId: channel.id,
              eventId: message.eventId,
              messageId: message.messageId,
            })
            .onConflictDoNothing()
            .returning()
            .get();
          if (!inbound) return;
          enqueueReply(channel.id, `inbound:${inbound.id}`, handle(channel, inbound.id));
        });
      },
      /** 目录变化或 /new 只影响后续消息，旧任务保留自己的会话与目录。 */
      setSession(channelId: number, cwd: string | null) {
        db.update(schema.channels)
          .set({ cwd, sessionId: null, updatedAt: new Date() })
          .where(eq(schema.channels.id, channelId))
          .run();
      },
      /** 暂停状态持久化，重启后仍需用户明确恢复。 */
      setPaused(channelId: number, paused: boolean) {
        db.update(schema.channels).set({ paused }).where(eq(schema.channels.id, channelId)).run();
      },
      /** 全局唯一的未结束任务，用于接收限制和控制命令。 */
      activeTask() {
        return db.select().from(schema.tasks).where(isNull(schema.tasks.finishedAt)).get();
      },
      /** 最近结果按聊天隔离，供 /last 再次查看。 */
      lastTask(channelId: number) {
        return db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.channelId, channelId))
          .orderBy(desc(schema.tasks.id))
          .limit(1)
          .get();
      },
      /** 在入站事务中创建任务并固定提交时的上下文。 */
      createTask(channel: typeof schema.channels.$inferSelect, inboundId: number, prompt: string) {
        if (!channel.cwd) throw new Error("创建任务前必须指定工作目录");
        return db
          .insert(schema.tasks)
          .values({
            channelId: channel.id,
            inboundId,
            cwd: channel.cwd,
            sessionId: channel.sessionId,
            prompt,
            status: "queued",
          })
          .returning()
          .get();
      },
      /** 先持久化 dispatching，再调用 Agent；崩溃后不会重新派发同一任务。 */
      claimTask(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
        return db.transaction(() => {
          const task = db
            .select()
            .from(schema.tasks)
            .where(eq(schema.tasks.status, "queued"))
            .get();
          if (!task) return;
          const channel = db
            .select()
            .from(schema.channels)
            .where(eq(schema.channels.id, task.channelId))
            .get();
          if (
            !channel ||
            channel.paused ||
            channel.platform !== source.platform ||
            channel.accountId !== source.accountId ||
            channel.userId !== source.userId
          )
            return;
          return db
            .update(schema.tasks)
            .set({ status: "dispatching" })
            .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "queued")))
            .returning()
            .get();
        });
      },
      /** 创建会话后立即保存关联，后续消息与重启均可续聊。 */
      recordSession(id: number, sessionId: string) {
        db.transaction(() => {
          const task = db
            .update(schema.tasks)
            .set({ sessionId })
            .where(and(eq(schema.tasks.id, id), isNull(schema.tasks.finishedAt)))
            .returning()
            .get();
          if (task)
            db.update(schema.channels)
              .set({ sessionId })
              .where(eq(schema.channels.id, task.channelId))
              .run();
        });
      },
      /** 早到通知也可登记 run ID，但不能撤销已经请求的停止。 */
      recordRun(id: number, runId: string) {
        db.update(schema.tasks)
          .set({
            runId,
            status: sql`case when ${schema.tasks.status} = 'dispatching' then 'running' else ${schema.tasks.status} end`,
          })
          .where(and(eq(schema.tasks.id, id), isNull(schema.tasks.finishedAt)))
          .run();
      },
      /** 未派发任务可直接取消；已派发任务等待 Agent 返回真实终态。 */
      cancelTask(id: number) {
        const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
        if (task?.status === "queued")
          finishTask(id, { status: "cancelled", text: "任务尚未开始，已取消。" });
        else
          db.update(schema.tasks)
            .set({ status: "cancelling" })
            .where(and(eq(schema.tasks.id, id), isNull(schema.tasks.finishedAt)))
            .run();
      },
      finishTask,
      /** 保留尚未派发的任务；执行结果不确定的任务只通知用户，绝不自动重跑。 */
      recoverTasks() {
        for (const task of db
          .select()
          .from(schema.tasks)
          .where(and(isNull(schema.tasks.finishedAt), ne(schema.tasks.status, "queued")))
          .all()) {
          finishTask(task.id, {
            status: "interrupted",
            text: "服务已重启，无法确认上次任务的执行结果。请先检查工作目录；确认后发送 /resume，再提交新消息。",
          });
        }
      },
      /** 仅取当前机器人所属聊天的回复，避免换 Token 后发送到错误账号。 */
      pendingReply(accountId: string, userId: string) {
        const reply = db
          .select({
            id: schema.outbox.id,
            text: schema.outbox.text,
            attempts: schema.outbox.attempts,
            retryAt: schema.outbox.retryAt,
            chatId: schema.channels.chatId,
          })
          .from(schema.outbox)
          .innerJoin(schema.channels, eq(schema.outbox.channelId, schema.channels.id))
          .where(
            and(
              eq(schema.outbox.status, "pending"),
              eq(schema.channels.platform, "telegram"),
              eq(schema.channels.accountId, accountId),
              eq(schema.channels.userId, userId),
            ),
          )
          .orderBy(asc(schema.outbox.id))
          .limit(1)
          .get();
        return reply && reply.retryAt.getTime() <= Date.now() ? reply : undefined;
      },
      /** 只有平台确认发送成功才标记完成。 */
      sentReply(id: number, messageId: string) {
        db.update(schema.outbox)
          .set({ status: "sent", messageId })
          .where(eq(schema.outbox.id, id))
          .run();
      },
      /** 保存重试时间或永久失败状态，发送过程不更改任务结果。 */
      retryReply(id: number, seconds: number, permanent = false) {
        db.update(schema.outbox)
          .set({
            status: permanent ? "failed" : "pending",
            attempts: sql`${schema.outbox.attempts} + 1`,
            retryAt: new Date(Date.now() + seconds * 1000),
          })
          .where(eq(schema.outbox.id, id))
          .run();
      },
      /** 最后释放单实例锁，避免旧执行尚未结束时新实例开始工作。 */
      close() {
        try {
          sqlite.close();
        } finally {
          lock?.close();
        }
      },
    };
  } catch (error) {
    sqlite.close();
    lock?.close();
    throw error;
  }
}

/** 对外只暴露实际存储操作，驱动和 SQL 留在本模块内部。 */
export type Store = ReturnType<typeof openStore>;
