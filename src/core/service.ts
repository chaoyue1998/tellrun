import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Logger } from "pino";
import type { Store } from "../storage/index.js";
import type { Agent, ChannelIdentity, IncomingMessage } from "./types.js";

/** 接收消息只保存必要状态；任务执行独立串行运行，控制命令始终可用。 */
export function createRelayService(options: { store: Store; agent: Agent; logger: Logger }) {
  let stopping = false;
  /** 状态查询与历史结果共用面向用户的状态名称。 */
  const statuses = {
    queued: "等待开始",
    dispatching: "正在连接 Agent",
    running: "执行中",
    cancelling: "正在停止",
    completed: "已完成",
    failed: "失败",
    cancelled: "已停止",
    interrupted: "执行状态待确认",
  };
  options.store.recoverTasks();

  return {
    /** 返回前保存消息和回复；重复事件直接忽略，不重新执行控制或任务。 */
    async handleMessage(message: IncomingMessage) {
      if (stopping) throw new Error("服务正在停止，消息尚未接收");
      options.store.accept(message, (channel, inboundId) => {
        const task = options.store.activeTask();
        if (message.content.type === "command") {
          switch (message.content.name) {
            case "start":
            case "help":
              return "Agent Relay 已连接。\n/cwd 绝对路径 — 设置工作目录\n普通文本 — 交给 Codex，后续消息沿用当前会话\n/new — 新建会话，保留目录\n/status — 查看状态\n/stop — 停止任务并暂停\n/resume — 确认后恢复接收任务\n/last — 查看最近结果\n当前一次处理一个任务；审批与结构化提问尚未接入，遇到此类请求会停止并提示。";
            case "status":
              return `服务：已连接\n${options.agent.name}：${options.agent.version}\n工作目录：${channel.cwd ?? "未设置，请使用 /cwd 绝对路径"}\n会话：${channel.sessionId ? "已有上下文" : "新会话"}\n接收任务：${channel.paused ? "已暂停，使用 /resume 恢复" : "已启用"}\n任务：${task ? `#${task.id} ${statuses[task.status]}` : "空闲"}`;
            case "cwd": {
              if (!message.content.args)
                return `当前目录：${channel.cwd ?? "未设置"}\n使用 /cwd 绝对路径 设置目录，目录变化会开始新会话。`;
              if (task) return "请等待当前任务结束，或先用 /stop 停止后再切换目录。";
              if (!isAbsolute(message.content.args))
                return "请提供绝对目录，例如 /cwd /Users/你的用户名/Code/项目名。";
              let cwd: string;
              try {
                cwd = realpathSync(message.content.args);
                if (!statSync(cwd).isDirectory()) return "指定路径不是目录。";
              } catch {
                return "无法访问该目录，请检查路径是否存在及访问权限。";
              }
              if (cwd !== channel.cwd) options.store.setSession(channel.id, cwd);
              return `工作目录：${cwd}\n${channel.paused ? "当前已暂停，发送 /resume 后可提交任务。" : "现在可以发送消息给 Codex。"}`;
            }
            case "new":
              if (task) return "请等待当前任务结束，或先用 /stop 停止后再新建会话。";
              options.store.setSession(channel.id, channel.cwd);
              return `已开始新会话。\n工作目录：${channel.cwd ?? "未设置，请先使用 /cwd 绝对路径"}${channel.paused ? "\n当前已暂停，请发送 /resume。" : ""}`;
            case "stop":
              options.store.setPaused(channel.id, true);
              if (!task || task.channelId !== channel.id)
                return "已暂停接收任务，当前聊天没有执行中的任务。发送 /resume 可恢复。";
              options.store.cancelTask(task.id);
              if (task.status !== "queued") options.agent.stop();
              return `已请求停止任务 #${task.id}，请等待最终状态。之后发送 /resume 可恢复接收任务。`;
            case "resume":
              if (task) return "当前任务尚未结束，请等待最终状态后再恢复。";
              options.store.setPaused(channel.id, false);
              return "已恢复接收任务。之前中断的任务不会重新执行，请发送新的消息。";
            case "last": {
              const last = options.store.lastTask(channel.id);
              return last
                ? `任务 #${last.id} ${statuses[last.status]}\n${last.result ?? "尚无最终结果。"}`
                : "当前聊天还没有任务记录。";
            }
            default:
              return "暂不支持此命令，请使用 /help 查看可用操作。";
          }
        }
        if (message.content.type === "unsupported")
          return "当前仅支持文本消息，请使用 /help 查看可用操作。";
        if (!channel.cwd) return "请先发送 /cwd 绝对路径 指定工作目录，再发送消息给 Codex。";
        if (channel.paused)
          return "当前已暂停。请检查上次任务结果，确认后发送 /resume，再提交新消息。";
        if (task)
          return `任务 #${task.id} 仍在处理，本条消息未提交。可用 /status 查看状态或 /stop 停止。`;
        if (!message.content.text.trim()) return "请输入任务内容。";
        return `已接收任务 #${options.store.createTask(channel, inboundId, message.content.text).id}\n工作目录：${channel.cwd}\n可用 /status 查看状态或 /stop 停止。`;
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
            throw new Error("目录已改变");
        } catch {
          options.store.finishTask(task.id, {
            status: "failed",
            text: "工作目录不存在、已改变或无法访问，未调用 Agent。请重新设置 /cwd 后提交任务。",
          });
          continue;
        }
        try {
          const result = await options.agent.run({
            cwd: task.cwd,
            prompt: task.prompt,
            sessionId: task.sessionId,
            onSession: (id) => options.store.recordSession(task.id, id),
            onStarted: (id) => options.store.recordRun(task.id, id),
          });
          options.store.finishTask(task.id, result);
          options.logger.info({ taskId: task.id, status: result.status }, "Agent 任务已结束");
        } catch (error) {
          options.store.finishTask(task.id, {
            status: "interrupted",
            text: "运行环境异常，服务将停止。请检查工作目录与本地进程后再恢复。",
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
