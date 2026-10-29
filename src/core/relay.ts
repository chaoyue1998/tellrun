import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Logger } from "pino";
import type { Store } from "../storage/store.js";
import type { Agent, ChannelIdentity, IncomingMessage } from "./types.js";

/** 接收消息只保存必要状态；任务执行独立串行运行，控制命令始终可用。 */
export function createRelayService(options: { store: Store; agent: Agent; logger: Logger }) {
  let stopping = false;
  /** 状态查询与历史结果共用面向用户的状态名称。 */
  const statuses = {
    queued: "Queued",
    dispatching: "Connecting",
    running: "Running",
    cancelling: "Stopping",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Stopped",
    interrupted: "Unconfirmed",
  };
  options.store.recoverTasks();

  return {
    /** 返回前保存消息和必要回复；重复事件直接忽略，不重新执行控制或任务。 */
    async handleMessage(message: IncomingMessage) {
      if (stopping) throw new Error("Service stopping. Message not accepted.");
      options.store.accept(message, (channel) => {
        /** 未指定目录时沿用服务启动目录，并随消息一同保存，后续可用 /cwd 切换。 */
        if (!channel.cwd) options.store.setSession(channel.id, realpathSync(process.cwd()));
        const task = options.store.activeTask();
        if (message.content.type === "command") {
          switch (message.content.name) {
            case "start":
            case "help":
              return "Tellrun ready.\nSend text to chat with Codex. New messages add to the running task.\n/cwd <path> — Set directory; start a new session\n/new — New session, same directory\n/status — Task status\n/last — Last result\n/stop — Stop task and pause\n/resume — Accept new tasks\nOne task at a time. Tasks needing approval or structured input are interrupted.";
            case "status":
              return `Service: connected\n${options.agent.name}: ${options.agent.version}\nDirectory: ${channel.cwd}\nSession: ${channel.sessionId ? "existing" : "new"}\nNew tasks: ${channel.paused ? "paused (/resume)" : "enabled"}\nTask: ${task ? `#${task.id} ${statuses[task.status]}` : "idle"}`;
            case "cwd": {
              if (!message.content.args)
                return `Directory: ${channel.cwd}\nUse /cwd /absolute/path to change directory and start a new session.`;
              if (task) return "Wait for the task to finish, or use /stop first.";
              if (!isAbsolute(message.content.args))
                return "Use an absolute path: /cwd /path/to/project.";
              let cwd: string;
              try {
                cwd = realpathSync(message.content.args);
                if (!statSync(cwd).isDirectory()) return "Path is not a directory.";
              } catch {
                return "Cannot access directory. Check the path and permissions.";
              }
              if (cwd !== channel.cwd) options.store.setSession(channel.id, cwd);
              return `Directory: ${cwd}\n${channel.paused ? "Paused. Send /resume to continue." : "Send a task to Codex."}`;
            }
            case "new":
              if (task) return "Wait for the task to finish, or use /stop first.";
              options.store.setSession(channel.id, channel.cwd);
              return `New session.\nDirectory: ${channel.cwd}${channel.paused ? "\nPaused. Send /resume to continue." : ""}`;
            case "stop":
              options.store.setPaused(channel.id, true);
              if (!task || task.channelId !== channel.id)
                return "Paused. No task running in this chat. Send /resume to continue.";
              options.store.cancelTask(task.id);
              if (task.status !== "queued") options.agent.stop();
              return `Stop requested for task #${task.id}. Wait for its result, then /resume.`;
            case "resume":
              if (task) return "Wait for the task to finish before /resume.";
              options.store.setPaused(channel.id, false);
              return "Ready for new tasks. Interrupted tasks will not be rerun.";
            case "last": {
              const last = options.store.lastTask(channel.id);
              return last
                ? `Task #${last.id} ${statuses[last.status]}\n${last.result ?? "No result yet."}`
                : "No tasks yet.";
            }
            default:
              return "Unknown command. See /help.";
          }
        }
        if (message.content.type === "unsupported") return "Text messages only. See /help.";
        if (channel.paused) return "Paused. Check /last, then /resume to send a new task.";
        if (!message.content.text.trim()) return "Send a task description.";
        if (task) {
          if (task.channelId !== channel.id)
            return `Task #${task.id} is running in another chat. Message not sent.`;
          if (task.status === "cancelling") return "Task stopping. Wait for its result.";
          options.store.appendTaskInput(task.id, message.content.text);
          return;
        }
        options.store.createTask(channel, message.content.text);
      });
    },
    /** 领取任务后再次检查目录；运行结果与最终回复在同一个快照中保存。 */
    async run(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
      while (!stopping) {
        const task = options.store.claimTask(source);
        if (!task) {
          await setTimeout(250);
          continue;
        }
        try {
          if (realpathSync(task.cwd) !== task.cwd || !statSync(task.cwd).isDirectory())
            throw new Error("Directory changed.");
        } catch {
          options.store.finishTask(task.id, {
            status: "failed",
            text: "Directory missing, changed, or inaccessible. Task not started. Set /cwd and try again.",
          });
          continue;
        }
        let finished = false;
        const running = options.agent
          .run({
            cwd: task.cwd,
            prompt: task.prompt,
            sessionId: task.sessionId,
            onSession: (id) => options.store.recordSession(task.id, id),
            onStarted: () => options.store.markRunning(task.id),
            onText: (text) => options.store.setDraft(task.id, text),
          })
          .finally(() => {
            finished = true;
          });
        /** 补充输入独立于入站处理和任务完成等待，慢 RPC 不阻塞 /status 与 /stop。 */
        const steering = (async () => {
          while (!finished && !stopping) {
            const input = options.store.claimTaskInput(task.id);
            if (!input) {
              await setTimeout(50);
              continue;
            }
            let error: string | undefined;
            try {
              await options.agent.steer(input.text);
            } catch (cause) {
              error =
                cause instanceof Error && cause.message.startsWith("Codex ")
                  ? cause.message
                  : "Submission unconfirmed. Not retried; check the session before resending.";
            }
            options.store.finishTaskInput(task.id, input.index, error);
          }
        })();
        try {
          const [result] = await Promise.all([running, steering]);
          options.store.finishTask(task.id, result);
          options.logger.info({ taskId: task.id, status: result.status }, "Task finished");
        } catch (error) {
          options.agent.stop();
          await Promise.allSettled([running, steering]);
          options.store.finishTask(task.id, {
            status: "interrupted",
            text: "Service error; shutting down. Check the directory and local processes before /resume.",
          });
          throw error;
        }
      }
    },
    /** 停止领取新任务；未派发记录保留，当前任务等待 Agent 确认退出。 */
    stop() {
      stopping = true;
      options.agent.stop();
    },
  };
}
