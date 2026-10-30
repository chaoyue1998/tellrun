import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout } from "node:timers/promises";
import { AttachmentError, maxAttachmentBytes } from "../storage/attachments.js";
import type { Store } from "../storage/store.js";
import type { UpdateChecker } from "../updates.js";
import type {
  Agent,
  AgentAttachment,
  AgentModel,
  AttachmentLoader,
  ChannelIdentity,
  IncomingMessage,
} from "./types.js";

/** 接收消息只保存必要状态；任务执行独立串行运行，控制命令始终可用。 */
export function createRelayService(options: {
  store: Store;
  agent: Agent;
  updates: UpdateChecker;
  prepareAttachments: AttachmentLoader;
}) {
  let stopping = false;
  /** 当前任务的附件准备可独立取消，不能阻塞停止指令或拖住服务退出。 */
  let inputPreparation: AbortController | undefined;
  /** 菜单查询独立于任务，关停时取消查询并等待退出后再关闭存储。 */
  const modelLoading = new AbortController();
  /** 状态的模型与版本查询复用独立工作循环，不阻塞入站审批和停止指令。 */
  const statusQueries: (() => Promise<void>)[] = [];
  /** 状态查询与历史结果共用面向用户的状态名称。 */
  const statuses = {
    queued: "Queued",
    preparing: "Downloading attachments",
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
      let statusQuery: (() => Promise<void>) | undefined;
      const reply = options.store.accept(message, (channel) => {
        /** 未指定目录时沿用服务启动目录，并随消息一同保存，后续可用 /cwd 切换。 */
        if (!channel.cwd) options.store.setSession(channel.id, realpathSync(process.cwd()));
        const task = options.store.activeTask();
        if (message.content.type === "permissions" || message.content.type === "model")
          return options.store.chooseOption(channel.id, message.content);
        if (
          message.content.type === "interaction" ||
          (message.content.type === "text" && message.content.replyToMessageId !== undefined)
        ) {
          const answer = options.store.answerInteraction(channel.id, message.content);
          if (answer !== undefined || message.content.type === "interaction") return answer;
        }
        if (message.content.type === "command") {
          switch (message.content.name) {
            case "start":
            case "help":
              return "Tellrun ready.\nSend text, photos, or files to Codex (up to 20 MB per attachment). Add a caption to describe your task. New messages add to the running task.\n/cwd <path> — Set directory; start a new session\n/new — New session, same directory\n/model — Select model and reasoning effort\n/permissions — Select permission mode\n/status — Status and update check\n/update — Ask Codex to upgrade Tellrun\n/last — Last result\n/stop — Stop task and pause\n/resume — Accept new tasks\nUse buttons for approvals. Approvals wait for your response. Answer questions with buttons or replies. Questions expire within 10 minutes.";
            case "model":
              if (message.content.args) return "Use /model to choose a model with the buttons.";
              options.store.openMenu(channel.id, "model");
              return;
            case "permissions":
              options.store.openMenu(channel.id, "permissions", options.agent.permissionModes);
              return;
            case "status": {
              /** 查询期间保存请求时的选择，后续切换不会改写这次状态快照。 */
              const snapshot = structuredClone(channel);
              statusQuery = async () => {
                /** 未选择时读取有效配置；读取失败仅回退到明确保存的模型与档位。 */
                const describe = async (
                  selection: Pick<typeof snapshot, "cwd" | "model" | "reasoningEffort">,
                ) => {
                  try {
                    return await options.agent.describeModel(
                      selection.cwd ?? process.cwd(),
                      selection,
                      modelLoading.signal,
                    );
                  } catch {
                    return selection.model && selection.reasoningEffort
                      ? {
                          id: selection.model,
                          label: selection.model,
                          reasoningEffort: selection.reasoningEffort,
                        }
                      : undefined;
                  }
                };
                const taskDiffers =
                  task &&
                  (task.model !== snapshot.model ||
                    task.reasoningEffort !== snapshot.reasoningEffort ||
                    task.cwd !== snapshot.cwd);
                const [model, taskModel, update] = await Promise.all([
                  describe(snapshot),
                  taskDiffers ? describe(task) : undefined,
                  options.updates.check(modelLoading.signal),
                ]);
                if (stopping) return;
                /** 同一模型的不同推理档位也需要区分当前选择与执行中的任务。 */
                const showTaskModel =
                  taskDiffers &&
                  (!model ||
                    !taskModel ||
                    model.id !== taskModel.id ||
                    model.reasoningEffort !== taskModel.reasoningEffort);
                const formatModel = (value: typeof model) =>
                  value
                    ? `${value.label} · ${value.reasoningEffort}`
                    : "Unavailable (check /model)";
                /** 仅在检查失败或发现更新时附加提示，最新版只显示版本号。 */
                const versionSuffix = !update
                  ? " (update check unavailable; check network or proxy)"
                  : update.available
                    ? ` (update available: ${update.latest})`
                    : "";
                const upgradeHint = update?.available
                  ? `\n\nSend /update to ask ${options.agent.name} to upgrade Tellrun.`
                  : "";
                options.store.reply(
                  snapshot.id,
                  `Service: connected\nTellrun: ${options.updates.version}${versionSuffix}\n${options.agent.name}: ${options.agent.version}\nDirectory: ${snapshot.cwd}\nModel: ${formatModel(model)}${showTaskModel ? `\nTask model: ${formatModel(taskModel)}` : ""}\nPermissions: ${options.agent.permissionModes.find((mode) => mode.id === snapshot.permissionMode)?.label ?? snapshot.permissionMode ?? options.agent.permissionModes[0]?.label ?? "Not set"}${task && task.permissionMode !== snapshot.permissionMode ? `\nTask permissions: ${options.agent.permissionModes.find((mode) => mode.id === task.permissionMode)?.label ?? task.permissionMode ?? options.agent.permissionModes[0]?.label ?? "Not set"}` : ""}\nTask: ${task ? `#${task.id} ${statuses[task.status]}` : "idle"}${task?.interactions.length ? `\nPending: ${task.interactions.map((item) => `${item.kind === "approval" ? "Approval" : "Question"}${item.blocking ? " (waiting)" : " (task running)"}`).join(", ")}` : ""}${upgradeHint}`,
                );
              };
              return;
            }
            case "update":
              if (message.content.args) return "Use /update without arguments.";
              if (task) return "Wait for the current task to finish, then send /update.";
              if (channel.paused) return "Paused. Send /resume before /update.";
              /** 复用普通任务的快照、去重、审批和恢复流程，不向执行中的任务追加升级指令。 */
              options.store.createTask(channel, options.updates.upgradePrompt());
              return `Tellrun update queued for ${options.agent.name}.`;
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
        if (message.content.type !== "text" && message.content.type !== "attachments")
          return "Send text, a photo, or a file. See /help.";
        if (channel.paused) return "Paused. Check /last, then /resume to send a new task.";
        const attachments =
          message.content.type === "attachments" ? message.content.attachments : [];
        if (
          attachments.some(
            (attachment) => attachment.size !== null && attachment.size > maxAttachmentBytes,
          )
        )
          return "Attachment exceeds the 20 MB download limit. Send a smaller file.";
        if (!message.content.text.trim() && !attachments.length) return "Send a task description.";
        if (task) {
          if (task.channelId !== channel.id)
            return `Task #${task.id} is running in another chat. Message not sent.`;
          if (task.status === "cancelling") return "Task stopping. Wait for its result.";
          options.store.appendTaskInput(task.id, message.content.text, attachments);
          return;
        }
        options.store.createTask(channel, message.content.text, attachments);
      });
      /** 只有入站去重记录保存成功后才查询；重复的 /status 不会重复入队。 */
      if (statusQuery) statusQueries.push(statusQuery);
      /** 只有选择和停止状态落盘后才影响运行时；回调答复不承担提交职责。 */
      if (
        (message.content.type === "command" && message.content.name === "stop") ||
        (message.content.type === "interaction" && message.content.action === "stop")
      ) {
        const active = options.store.activeTask();
        if (!active || active.status === "cancelling") inputPreparation?.abort();
        if (active?.status === "cancelling") options.agent.stop();
      }
      return reply;
    },
    /** 慢模型列表请求不占用入站或任务循环；迟到结果由菜单 ID 校验丢弃。 */
    async loadModels(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
      while (!stopping) {
        const query = statusQueries.shift();
        if (query) {
          await query();
          continue;
        }
        const menu = options.store.pendingModels(source);
        if (!menu) {
          await setTimeout(100);
          continue;
        }
        let models: AgentModel[] | undefined;
        try {
          models = await options.agent.listModels(menu.cwd, modelLoading.signal);
        } catch {
          /** 查询失败只提示重新打开菜单，不影响任务和已有选择。 */
        }
        if (!stopping) options.store.fillModels(menu.channelId, menu.id, models);
      }
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
        const preparing = new AbortController();
        inputPreparation = preparing;
        let attachments: AgentAttachment[] = [];
        if (task.status === "preparing") {
          try {
            attachments = await options.prepareAttachments(task.attachments, preparing.signal);
            if (stopping) return;
            if (preparing.signal.aborted || !options.store.markDispatching(task.id)) continue;
          } catch (error) {
            if (stopping) return;
            options.store.finishTask(task.id, {
              status: preparing.signal.aborted ? "cancelled" : "failed",
              text: preparing.signal.aborted
                ? "Stopped before starting."
                : error instanceof AttachmentError
                  ? error.message
                  : "Cannot prepare attachments. Resend them to try again.",
            });
            continue;
          } finally {
            if (inputPreparation === preparing) inputPreparation = undefined;
          }
        }
        inputPreparation = preparing;
        let finished = false;
        const running = options.agent
          .run({
            cwd: task.cwd,
            prompt: task.prompt,
            attachments,
            sessionId: task.sessionId,
            runId: task.runId,
            permissionMode: task.permissionMode,
            model: task.model,
            reasoningEffort: task.reasoningEffort,
            onSession: (id) => options.store.recordSession(task.id, id),
            onStarted: (runId) => {
              options.store.markRunning(task.id, runId);
              if (options.store.activeTask()?.status === "cancelling") options.agent.stop();
            },
            onText: (text) => options.store.setDraft(task.id, text),
            onInteraction: (request) => options.store.addInteraction(task.id, request),
            onInteractionClosed: (id, reason) => options.store.closeInteraction(id, reason),
          })
          .finally(() => {
            finished = true;
            preparing.abort();
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
              const attachments = await options.prepareAttachments(
                input.attachments,
                preparing.signal,
              );
              if (finished || stopping) return;
              if (!options.store.markTaskInputSending(task.id, input.index)) continue;
              await options.agent.steer(input.text, attachments);
            } catch (cause) {
              if (finished || stopping) return;
              error =
                cause instanceof AttachmentError ||
                (cause instanceof Error && cause.message.startsWith("Codex "))
                  ? cause.message
                  : "Submission unconfirmed. Not retried; check the session before resending.";
            }
            options.store.finishTaskInput(task.id, input.index, error);
          }
        })();
        /** 交互提交独立于慢速补充 RPC；停止、服务端解决和用户选择之间至多提交一次。 */
        const answering = (async () => {
          while (!finished && !stopping) {
            const interaction = options.store.claimInteraction(task.id);
            if (interaction) {
              const submitted = options.agent.respond(interaction.id, interaction.answer);
              options.store.closeInteraction(
                interaction.id,
                submitted
                  ? "Submitted. Waiting for results."
                  : "Request closed or delivery unconfirmed. Check /status.",
              );
            }
            await setTimeout(50);
          }
        })();
        try {
          const [result] = await Promise.all([running, steering, answering]);
          if (result) options.store.finishTask(task.id, result);
        } catch (error) {
          options.agent.disconnect();
          await Promise.allSettled([running, steering, answering]);
          options.store.finishTask(task.id, {
            status: "interrupted",
            text: "Service error; shutting down. Check the directory and local processes before /resume.",
          });
          throw error;
        } finally {
          preparing.abort();
          if (inputPreparation === preparing) inputPreparation = undefined;
        }
      }
    },
    /** 服务退出只断开客户端；后台任务继续运行，重启后按已保存轮次接回。 */
    stop() {
      stopping = true;
      modelLoading.abort();
      inputPreparation?.abort();
      options.agent.disconnect();
    },
  };
}
