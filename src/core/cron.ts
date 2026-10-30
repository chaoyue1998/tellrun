import { Cron } from "croner";
import { activeTaskStatuses, type State } from "../storage/schema.js";
import type { ChannelIdentity } from "./types.js";

/** 只使用五段 Cron；Croner 负责校验和时区计算，不创建独立执行定时器。 */
function nextRun(expression: string, timezone: string, after: number) {
  let cron: Cron | undefined;
  try {
    if (expression.trim().split(/\s+/).length !== 5) return null;
    cron = new Cron(expression, { timezone, mode: "5-part", paused: true });
    return cron.nextRun(new Date(after))?.getTime() ?? null;
  } catch {
    return null;
  } finally {
    cron?.stop();
  }
}

/** 时间按计划保存的时区展示，避免服务器时区变更后误读旧任务。 */
function formatTime(timestamp: number | null, timezone: string) {
  if (timestamp === null) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(timestamp);
}

/** 命令、触发记录和任务创建共用存储事务；计划本身不直接调用 Agent。 */
export function createCrons(storage: {
  read: () => State;
  update: <T>(action: () => T) => T;
  enqueueReply: (channelId: number, text: string) => void;
  createTask: (
    channel: State["channels"][number],
    cron: State["crons"][number],
    scheduledAt: number,
  ) => State["tasks"][number];
}) {
  /** 调度只读取当前机器人和授权用户的计划，旧配置的计划不能误触发。 */
  function channelsFor(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
    return new Map(
      storage
        .read()
        .channels.filter(
          (channel) =>
            channel.platform === source.platform &&
            channel.accountId === source.accountId &&
            channel.userId === source.userId,
        )
        .map((channel) => [channel.id, channel]),
    );
  }

  /** 到期时向未来推进；无效计划关闭并通知，避免反复触发或阻塞其他计划。 */
  function advance(cron: State["crons"][number], now: number) {
    cron.nextRunAt = nextRun(cron.expression, cron.timezone, now);
    if (cron.nextRunAt !== null) return;
    cron.enabled = false;
    cron.pendingAt = null;
    storage.enqueueReply(
      cron.channelId,
      `Cron #${cron.id} disabled: invalid expression or timezone, or no future run. Delete and recreate the schedule.`,
    );
  }

  return {
    /** 已接收命令由外层事务去重；参数校验完成后才修改计划。 */
    handleCron(channelId: number, args: string, now = Date.now()) {
      const state = storage.read();
      const channel = state.channels.find((item) => item.id === channelId);
      if (!channel?.cwd) return "Set a working directory with /cwd first.";
      const cwd = channel.cwd;
      /** 新计划读取创建时的服务器时区，已有计划始终使用保存的时区。 */
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      /** 帮助与参数错误共用命令格式，描述可以包含空格和换行。 */
      const usage = [
        "/cron — List all scheduled tasks",
        "/cron add <minute> <hour> <day> <month> <weekday> <task>",
        "/cron del <id> — Delete a schedule",
        "/cron enable <id> — Enable a schedule",
        "/cron disable <id> — Disable a schedule",
        `New schedule timezone: ${timezone} (server timezone)`,
        "Example: /cron add 0 9 * * 1-5 Check the project and report issues",
      ].join("\n");
      const input = args.trim();
      const paused = channel.paused
        ? "\nChat paused. Send /resume to allow future scheduled runs."
        : "";
      if (!input) {
        const crons = state.crons.filter((cron) => cron.channelId === channelId);
        if (!crons.length) return `No scheduled tasks.${paused}\n\n${usage}`;
        return [
          `Scheduled tasks: ${crons.length}${paused}`,
          ...crons.map((cron) => {
            const running = state.tasks.find(
              (task) => task.cron?.id === cron.id && activeTaskStatuses.has(task.status),
            );
            const activity = [
              running ? `Active task: #${running.id}` : "",
              cron.pendingAt !== null ? "Pending" : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return `#${cron.id} · ${cron.enabled ? "Enabled" : "Disabled"}${activity ? ` · ${activity}` : ""}\n${cron.expression}\nTimezone: ${cron.timezone}\nDirectory: ${cron.cwd}\nTask: ${cron.prompt}\nNext: ${formatTime(cron.nextRunAt, cron.timezone)}`;
          }),
        ].join("\n\n");
      }
      const add = input.match(/^add\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
      if (add) {
        const expression = add.slice(1, 6).join(" ");
        const prompt = add[6]?.trim();
        const nextRunAt = nextRun(expression, timezone, now);
        if (!prompt || nextRunAt === null)
          return `Invalid cron expression or no future run. Use five fields.\n\n${usage}`;
        return storage.update(() => {
          const state = storage.read();
          const id = state.nextCronId++;
          state.crons.push({
            id,
            channelId,
            expression,
            timezone,
            prompt,
            cwd,
            model: channel.model,
            reasoningEffort: channel.reasoningEffort,
            permissionMode: channel.permissionMode,
            enabled: true,
            nextRunAt,
            pendingAt: null,
          });
          return `Cron #${id} created (enabled).\n${expression}\nTimezone: ${timezone}\nDirectory: ${cwd}\nTask: ${prompt}\nNext: ${formatTime(nextRunAt, timezone)}${paused}`;
        });
      }
      const action = input.match(/^(del|enable|disable)\s+([1-9]\d*)$/);
      if (!action || !Number.isSafeInteger(Number(action[2]))) return usage;
      const cron = state.crons.find(
        (item) => item.id === Number(action[2]) && item.channelId === channelId,
      );
      if (!cron) return "Schedule not found. Send /cron to see task IDs.";
      if (action[1] === "enable" && cron.enabled)
        return `Cron #${cron.id} is already enabled.\nNext: ${formatTime(cron.nextRunAt, cron.timezone)} (${cron.timezone})${paused}`;
      const nextRunAt =
        action[1] === "enable" ? nextRun(cron.expression, cron.timezone, now) : null;
      if (action[1] === "enable" && nextRunAt === null)
        return "No future run could be calculated. Delete and recreate the schedule.";
      return storage.update(() => {
        const state = storage.read();
        const current = state.crons.find((item) => item.id === cron.id);
        if (!current) return "Schedule not found.";
        const active = state.tasks.some(
          (task) => task.cron?.id === current.id && activeTaskStatuses.has(task.status),
        );
        if (action[1] === "del") state.crons = state.crons.filter((item) => item.id !== current.id);
        else {
          current.enabled = action[1] === "enable";
          current.nextRunAt = nextRunAt;
          current.pendingAt = null;
        }
        return `Cron #${current.id} ${action[1] === "del" ? "deleted" : current.enabled ? "enabled" : "disabled"}.${action[1] === "enable" ? `\nNext: ${formatTime(nextRunAt, current.timezone)} (${current.timezone})${paused}` : active ? "\nThe active task will continue. Use /stop to stop it." : ""}`;
      });
    },
    /** 暂停清空等待触发；恢复时跳过暂停期间到期的次数，不产生过期工作。 */
    resetCronPending(channelId: number, now = Date.now()) {
      storage.update(() => {
        for (const cron of storage.read().crons) {
          if (cron.channelId !== channelId) continue;
          cron.pendingAt = null;
          if (cron.enabled && (cron.nextRunAt === null || cron.nextRunAt <= now))
            advance(cron, now);
        }
      });
    },
    /** 只跳过停机期间错过的触发；停机前已记录的待执行项继续保留。 */
    recoverCrons(
      source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">,
      now = Date.now(),
    ) {
      const channels = channelsFor(source);
      const due = storage
        .read()
        .crons.filter(
          (cron) =>
            channels.has(cron.channelId) &&
            ((cron.enabled && (cron.nextRunAt === null || cron.nextRunAt <= now)) ||
              (channels.get(cron.channelId)?.paused && cron.pendingAt !== null)),
        );
      if (!due.length) return;
      storage.update(() => {
        for (const saved of due) {
          const cron = storage.read().crons.find((item) => item.id === saved.id);
          if (!cron) continue;
          if (channels.get(cron.channelId)?.paused) cron.pendingAt = null;
          if (cron.enabled && (cron.nextRunAt === null || cron.nextRunAt <= now))
            advance(cron, now);
        }
      });
    },
    /** 触发、下一时刻和执行快照一次落盘；忙时每个计划只保留一次，空闲按时间串行领取。 */
    tickCrons(
      source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">,
      now = Date.now(),
    ) {
      const channels = channelsFor(source);
      const crons = storage
        .read()
        .crons.filter((cron) => cron.enabled && channels.has(cron.channelId));
      const busy = storage.read().tasks.some((task) => activeTaskStatuses.has(task.status));
      if (
        !crons.some(
          (cron) =>
            (cron.nextRunAt !== null && cron.nextRunAt <= now) ||
            (cron.pendingAt !== null && (!busy || channels.get(cron.channelId)?.paused)),
        )
      )
        return;
      storage.update(() => {
        const state = storage.read();
        for (const cron of state.crons) {
          const channel = channels.get(cron.channelId);
          if (!cron.enabled || !channel) continue;
          if (channel.paused) cron.pendingAt = null;
          if (cron.nextRunAt === null || cron.nextRunAt > now) continue;
          if (!channel.paused) cron.pendingAt ??= cron.nextRunAt;
          advance(cron, now);
        }
        if (state.tasks.some((task) => activeTaskStatuses.has(task.status))) return;
        const cron = state.crons
          .filter(
            (item) =>
              item.enabled &&
              item.pendingAt !== null &&
              channels.has(item.channelId) &&
              !channels.get(item.channelId)?.paused,
          )
          .sort((a, b) => (a.pendingAt ?? 0) - (b.pendingAt ?? 0) || a.id - b.id)[0];
        const channel = cron && state.channels.find((item) => item.id === cron.channelId);
        if (!cron || !channel || cron.pendingAt === null) return;
        const scheduledAt = cron.pendingAt;
        cron.pendingAt = null;
        const task = storage.createTask(channel, cron, scheduledAt);
        storage.enqueueReply(
          channel.id,
          `Cron #${cron.id} queued task #${task.id}.\nScheduled: ${formatTime(scheduledAt, cron.timezone)} (${cron.timezone})\nDirectory: ${cron.cwd}\nTask: ${cron.prompt}`,
        );
      });
    },
  };
}
