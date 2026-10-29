import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { appDirectory } from "../config.js";
import type { AgentResult, ChannelIdentity, IncomingMessage } from "../core/types.js";
import { writeJson } from "./json.js";
import { activeTaskStatuses, type State, stateSchema } from "./schema.js";

/** 打开文件状态并取得单实例锁；所有业务写入统一替换 state.json。 */
export function openStore(path = join(appDirectory, "state.json")) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (dirname(path) === appDirectory) chmodSync(appDirectory, 0o700);
  const lock = `${path}.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  let owned = false;
  let usable = true;
  let updating = false;
  /** 流式预览只保留内存中的最新片段，不为每个文本增量写磁盘。 */
  let draft: { taskId: number; text: string } | undefined;

  /** 只删除本实例的所有权文件；非空目录不能被另一个退出中的实例移除。 */
  function release() {
    if (!owned) return;
    rmSync(join(lock, owner), { force: true });
    owned = false;
    try {
      rmdirSync(lock);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTEMPTY"].includes(String(error.code))
        )
      )
        throw error;
    }
  }

  try {
    /** mkdir 竞争唯一写入者；回收旧锁必须先确认 PID 已退出，再删除该所有权文件。 */
    for (let attempt = 0; attempt < 3 && !owned; attempt++) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        writeFileSync(join(lock, owner), "", { flag: "wx", mode: 0o600 });
        owned = true;
        if (readdirSync(lock).length !== 1) throw new Error("State lock busy. Try again.");
      } catch (error) {
        if (owned || !(error instanceof Error && "code" in error && error.code === "EEXIST"))
          throw error;
        try {
          const owners = readdirSync(lock);
          if (owners.length === 0 && Date.now() - statSync(lock).mtimeMs > 30_000) {
            rmdirSync(lock);
            continue;
          }
          const previous = owners.length === 1 ? owners[0] : undefined;
          const pid = previous?.match(/^([1-9]\d*)-[0-9a-f-]+$/)?.[1];
          if (!previous || !pid)
            throw new Error("State lock initializing or invalid. Check for another instance.");
          try {
            process.kill(Number(pid), 0);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
            /** 只有成功移除旧所有权文件的实例才能回收目录，避免竞争时删除新锁。 */
            unlinkSync(join(lock, previous));
            rmdirSync(lock);
            continue;
          }
          throw new Error("Another Tellrun instance is running. Stop it first.");
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              ["ENOENT", "ENOTEMPTY"].includes(String(error.code))
            )
          )
            throw error;
        }
      }
    }
    if (!owned) throw new Error("Cannot acquire state lock. Try again.");

    let state: State;
    try {
      const contents = readFileSync(path, "utf8");
      try {
        state = stateSchema.parse(JSON.parse(contents));
      } catch {
        throw new Error("Invalid state.json; file unchanged. Check it or restore a backup.");
      }
      chmodSync(path, 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      state = { channels: [], inboundUpdates: [], tasks: [], outbox: [] };
      writeJson(path, state);
    }

    /** 一次业务操作只保存一个快照；嵌套操作合并写入，失败时回滚内存并停止后续写入。 */
    function update<T>(action: () => T): T {
      if (!usable) throw new Error("State storage unavailable. Restart the service.");
      if (updating) return action();
      const previous = state;
      state = structuredClone(state);
      updating = true;
      try {
        const result = action();
        try {
          writeJson(path, state);
        } catch (error) {
          usable = false;
          throw Object.assign(
            new Error("Cannot save state. Check disk space and permissions.", { cause: error }),
            { code: "STATE_WRITE_FAILED" },
          );
        }
        return structuredClone(result);
      } catch (error) {
        state = previous;
        throw error;
      } finally {
        updating = false;
      }
    }

    /** 无回复时跳过入队；其余按 Unicode 字符拆分，和触发它的状态变更一起保存。 */
    function enqueueReply(channelId: number, text: string | undefined) {
      if (text === undefined) return;
      const parts = text.match(/[\s\S]{1,2000}/gu) ?? ["(No text reply)"];
      for (const [index, part] of parts.entries()) {
        state.outbox.push({
          id: state.outbox.reduce((max, item) => Math.max(max, item.id), 0) + 1,
          channelId,
          text: parts.length > 1 ? `(${index + 1}/${parts.length})\n${part}` : part,
          attempts: 0,
          retryAt: Date.now(),
        });
      }
    }

    /** 终态与最终回复一起保存，迟到事件不能覆盖已完成结果。 */
    function finishTask(id: number, result: AgentResult) {
      if (!state.tasks.some((task) => task.id === id && activeTaskStatuses.has(task.status)))
        return;
      update(() => {
        const task = state.tasks.find((task) => task.id === id);
        if (!task) throw new Error("Task not found.");
        Object.assign(task, { status: result.status, result: result.text });
        if (result.status === "interrupted") {
          const channel = state.channels.find((channel) => channel.id === task.channelId);
          if (channel) channel.paused = true;
        }
        enqueueReply(
          task.channelId,
          `Task #${id} ${
            {
              completed: "Completed",
              failed: "Failed",
              cancelled: "Stopped",
              interrupted: "Unconfirmed",
            }[result.status]
          }\n${result.text}`,
        );
        for (const [index, input] of task.inputs.entries()) {
          if (input.status !== "pending" && input.status !== "sending") continue;
          enqueueReply(
            task.channelId,
            `Task #${id}, message ${index + 1}: ${input.status === "pending" ? "not sent" : "delivery unconfirmed"}. Task ended; not retried. Check the session before resending.`,
          );
          input.status = "failed";
        }
      });
      if (draft?.taskId === id) draft = undefined;
    }

    return {
      /** 去重标识、任务和必要回复合并保存，成功返回后才能确认入站事件。 */
      accept(
        message: IncomingMessage,
        handle: (channel: State["channels"][number]) => string | undefined,
      ) {
        const existing = state.channels.find(
          (channel) =>
            channel.platform === message.channel.platform &&
            channel.accountId === message.channel.accountId &&
            channel.chatId === message.channel.chatId,
        );
        if (
          existing &&
          state.inboundUpdates.some(
            (item) => item.channelId === existing.id && item.eventId === message.eventId,
          )
        )
          return;
        update(() => {
          let channel = state.channels.find((channel) => channel.id === existing?.id);
          if (!channel) {
            channel = {
              ...message.channel,
              id: state.channels.reduce((max, item) => Math.max(max, item.id), 0) + 1,
              cwd: null,
              sessionId: null,
              paused: false,
            };
            state.channels.push(channel);
          }
          channel.userId = message.channel.userId;
          state.inboundUpdates.push({
            channelId: channel.id,
            eventId: message.eventId,
          });
          enqueueReply(channel.id, handle(channel));
        });
      },
      /** 新会话或目录变化只影响后续任务，已保存任务仍使用自己的快照。 */
      setSession(channelId: number, cwd: string | null) {
        update(() => {
          const channel = state.channels.find((channel) => channel.id === channelId);
          if (channel) Object.assign(channel, { cwd, sessionId: null });
        });
      },
      /** 暂停状态跨重启保留，恢复须由用户明确触发。 */
      setPaused(channelId: number, paused: boolean) {
        update(() => {
          const channel = state.channels.find((channel) => channel.id === channelId);
          if (channel) channel.paused = paused;
        });
      },
      /** 返回快照，避免调用方直接修改内存中的持久状态。 */
      activeTask() {
        return structuredClone(state.tasks.find((task) => activeTaskStatuses.has(task.status)));
      },
      /** 限制预览为末尾 2000 个 Unicode 字符，完整结果仍由最终回复保存。 */
      setDraft(id: number, text: string) {
        if (state.tasks.some((task) => task.id === id && task.status === "running"))
          draft = { taskId: id, text: [...text].slice(-2000).join("") };
      },
      /** 仅向当前机器人与授权用户返回执行中的草稿，停止后不再刷新。 */
      pendingDraft(accountId: string, userId: string) {
        if (!draft?.text.trim()) return;
        const task = state.tasks.find(
          (task) => task.id === draft?.taskId && task.status === "running",
        );
        const channel = state.channels.find((channel) => channel.id === task?.channelId);
        if (
          channel?.platform === "telegram" &&
          channel.accountId === accountId &&
          channel.userId === userId
        )
          return { ...draft, chatId: channel.chatId };
      },
      /** 最近结果按聊天隔离，供 /last 再次查看。 */
      lastTask(channelId: number) {
        return structuredClone(state.tasks.findLast((task) => task.channelId === channelId));
      },
      /** 接收时固定目录、会话与输入，限制全局只有一个未结束任务。 */
      createTask(channel: State["channels"][number], prompt: string) {
        return update(() => {
          if (!channel.cwd) throw new Error("Set a working directory first.");
          if (state.tasks.some((task) => activeTaskStatuses.has(task.status)))
            throw new Error("A task is already running.");
          const task: State["tasks"][number] = {
            id: state.tasks.reduce((max, item) => Math.max(max, item.id), 0) + 1,
            channelId: channel.id,
            cwd: channel.cwd,
            sessionId: channel.sessionId,
            prompt,
            inputs: [],
            status: "queued",
            result: null,
          };
          state.tasks.push(task);
          return task;
        });
      },
      /** 尚未派发时合并首条输入；执行中的补充输入与入站去重标识一起保存。 */
      appendTaskInput(id: number, text: string) {
        update(() => {
          const task = state.tasks.find((task) => task.id === id);
          if (!task || !["queued", "dispatching", "running"].includes(task.status))
            throw new Error("Task cannot accept more input.");
          if (task.status === "queued") task.prompt += `\n\n${text}`;
          else task.inputs.push({ text, status: "pending" });
        });
      },
      /** 取得当前轮次后按接收顺序派发，先落盘 sending，不能自动重试不确定输入。 */
      claimTaskInput(id: number) {
        const task = state.tasks.find((task) => task.id === id && task.status === "running");
        const index = task?.inputs.findIndex((input) => input.status === "pending") ?? -1;
        if (!task || index < 0) return;
        return update(() => {
          const input = state.tasks.find((task) => task.id === id)?.inputs[index];
          if (!input) throw new Error("Input not found.");
          input.status = "sending";
          return { index, text: input.text };
        });
      },
      /** 成功补充不产生固定回执，失败提示和输入状态原子保存。 */
      finishTaskInput(id: number, index: number, error?: string) {
        update(() => {
          const task = state.tasks.find((task) => task.id === id);
          const input = task?.inputs[index];
          if (!task || input?.status !== "sending") return;
          input.status = error === undefined ? "accepted" : "failed";
          if (error !== undefined)
            enqueueReply(task.channelId, `Task #${id}, message ${index + 1}: ${error}`);
        });
      },
      /** 先保存派发状态再调用 Agent；空闲时仅查询，不反复写文件。 */
      claimTask(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
        const index = state.tasks.findIndex((task) => task.status === "queued");
        const task = state.tasks[index];
        const channel = state.channels.find((channel) => channel.id === task?.channelId);
        if (
          !task ||
          !channel ||
          channel.paused ||
          channel.platform !== source.platform ||
          channel.accountId !== source.accountId ||
          channel.userId !== source.userId
        )
          return;
        return update(() => {
          const claimed = { ...task, status: "dispatching" as const };
          state.tasks[index] = claimed;
          return claimed;
        });
      },
      /** 新建会话后立即保存关联，后续消息与重启均可续聊。 */
      recordSession(id: number, sessionId: string) {
        update(() => {
          const task = state.tasks.find(
            (task) => task.id === id && activeTaskStatuses.has(task.status),
          );
          if (!task) return;
          task.sessionId = sessionId;
          const channel = state.channels.find((channel) => channel.id === task.channelId);
          if (channel) channel.sessionId = sessionId;
        });
      },
      /** 确认开始执行；迟到通知不能撤销停止请求。 */
      markRunning(id: number) {
        update(() => {
          const task = state.tasks.find((task) => task.id === id);
          if (task?.status === "dispatching") task.status = "running";
        });
      },
      /** 未派发任务直接取消；其余等待 Agent 确认终态。 */
      cancelTask(id: number) {
        if (state.tasks.find((task) => task.id === id)?.status === "queued") {
          finishTask(id, { status: "cancelled", text: "Cancelled before starting." });
        } else
          update(() => {
            const task = state.tasks.find(
              (task) => task.id === id && activeTaskStatuses.has(task.status),
            );
            if (task) task.status = "cancelling";
          });
      },
      finishTask,
      /** 结果不确定的任务暂停并通知用户，不自动重新派发。 */
      recoverTasks() {
        for (const task of state.tasks.filter(
          (task) => activeTaskStatuses.has(task.status) && task.status !== "queued",
        )) {
          finishTask(task.id, {
            status: "interrupted",
            text: "Service restarted; task result unknown. Check the project, then /resume and send a new task.",
          });
        }
      },
      /** 按机器人与授权用户取最早回复，重试保持发送顺序。 */
      pendingReply(accountId: string, userId: string) {
        for (const reply of state.outbox) {
          const channel = state.channels.find((channel) => channel.id === reply.channelId);
          if (
            channel?.platform === "telegram" &&
            channel.accountId === accountId &&
            channel.userId === userId
          ) {
            return reply.retryAt <= Date.now()
              ? structuredClone({ ...reply, chatId: channel.chatId })
              : undefined;
          }
        }
      },
      /** 发送成功或永久拒绝后移出发送队列，任务结果仍保留。 */
      removeReply(id: number) {
        update(() => {
          state.outbox = state.outbox.filter((reply) => reply.id !== id);
        });
      },
      /** 发送失败只更新回复的重试信息，不影响任务执行状态。 */
      retryReply(id: number, seconds: number) {
        update(() => {
          const reply = state.outbox.find((reply) => reply.id === id);
          if (reply)
            Object.assign(reply, {
              attempts: reply.attempts + 1,
              retryAt: Date.now() + seconds * 1000,
            });
        });
      },
      /** 所有任务与消息处理结束后释放单实例锁。 */
      close() {
        usable = false;
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** 业务层使用的存储接口，文件格式与写入细节留在本模块。 */
export type Store = ReturnType<typeof openStore>;
