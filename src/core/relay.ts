import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { UpdateChecker } from "../updates.js";
import { AttachmentError, maxAttachmentBytes } from "./attachments.js";
import type { CoreState } from "./state.js";
import type {
  Agent,
  AgentAttachment,
  AgentOption,
  AgentSessionHistory,
  AgentSessionPage,
  AttachmentLoader,
  ChannelIdentity,
  IncomingMessage,
} from "./types.js";
import { listPageSize } from "./types.js";

/** 接收消息只保存必要状态；不同会话并发执行，控制命令始终可用。 */
export function createRelayService(options: {
  state: CoreState;
  agent: Agent;
  updates: UpdateChecker;
  prepareAttachments: AttachmentLoader;
  /** 请求落盘后同步关闭连接；不支持进程替换的平台不提供重启入口。 */
  restart: (() => void) | undefined;
}) {
  let stopping = false;
  /** 每项任务独立准备附件并等待结束，取消时只操作对应任务。 */
  const runningTasks = new Map<number, { preparation: AbortController; promise: Promise<void> }>();
  /** 菜单和会话控制独立于任务，关停时取消请求并等待退出后再关闭存储。 */
  const modelLoading = new AbortController();
  /** 状态与会话请求立即执行；工作循环统一接收结果并等待退出。 */
  const controlQueries: Promise<void>[] = [];
  /** 会话变更确认前暂缓新任务，避免接口等待期间把消息发往旧会话。 */
  const changingSessions = new Set<number>();
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
  options.state.recoverTasks();

  /** 列表与翻页共用独立查询；只把仍有效的结果交回菜单事务。 */
  async function loadListPage(query: {
    channelId: number;
    kind: "session" | "cwd";
    id: string;
    cwd: string;
    page: number;
    cursor: string | null;
  }) {
    if (query.kind === "cwd") {
      const directories = await options.agent
        .listDirectories(query.cwd, modelLoading.signal)
        .catch(() => undefined);
      if (!stopping)
        options.state.fillDirectories(
          query.channelId,
          query.id,
          directories,
          options.agent.unavailableReason,
        );
      return;
    }
    let result: AgentSessionPage | undefined;
    try {
      result = await options.agent.listSessions(query.cwd, modelLoading.signal, query.cursor);
    } catch {
      /** 失败由菜单保留原页并统一提示；状态写入异常仍交给工作循环处理。 */
    }
    if (!stopping)
      options.state.fillSessions(
        query.channelId,
        query.id,
        query.page,
        result,
        options.agent.unavailableReason,
      );
  }

  /** 单项执行固定任务快照，输入、交互与附件控制都按任务隔离。 */
  async function executeTask(
    task: NonNullable<ReturnType<CoreState["claimTask"]>>,
    preparing: AbortController,
  ) {
    try {
      if (realpathSync(task.cwd) !== task.cwd || !statSync(task.cwd).isDirectory())
        throw new Error("Directory changed.");
    } catch {
      options.state.finishTask(task.id, {
        status: "failed",
        text: "Directory missing, changed, or inaccessible. Task not started. Set /cwd and try again.",
      });
      return;
    }
    let attachments: AgentAttachment[] = [];
    if (task.status === "preparing") {
      try {
        attachments = await options.prepareAttachments(task.attachments, preparing.signal);
        if (stopping) return;
        if (preparing.signal.aborted || !options.state.markDispatching(task.id)) return;
      } catch (error) {
        if (stopping) return;
        options.state.finishTask(task.id, {
          status: preparing.signal.aborted ? "cancelled" : "failed",
          text: preparing.signal.aborted
            ? "Stopped before starting."
            : error instanceof AttachmentError
              ? error.message
              : "Cannot prepare attachments. Resend them to try again.",
        });
        return;
      }
    }
    let finished = false;
    const running = options.agent
      .run({
        taskId: task.id,
        cwd: task.cwd,
        prompt: task.prompt,
        attachments,
        sessionId: task.sessionId,
        runId: task.runId,
        permissionMode: task.permissionMode,
        model: task.model,
        reasoningEffort: task.reasoningEffort,
        onSession: (id) => options.state.recordSession(task.id, id),
        onStarted: (runId) => {
          options.state.markRunning(task.id, runId);
          if (
            options.state.activeTasks().find((item) => item.id === task.id)?.status === "cancelling"
          )
            options.agent.interrupt(task.id);
        },
        onText: (messages) => options.state.setDraft(task.id, messages),
        onNotice: (text) => options.state.replyTask(task.id, text),
        onInteraction: (request) => options.state.addInteraction(task.id, request),
        onInteractionClosed: (id, reason) => options.state.closeInteraction(id, reason),
      })
      .finally(() => {
        finished = true;
        preparing.abort();
      });
    /** 补充输入独立于入站处理和任务完成等待，慢 RPC 不阻塞 /status 与 /stop。 */
    const steering = (async () => {
      while (!finished && !stopping) {
        const input = options.state.claimTaskInput(task.id);
        if (!input) {
          await setTimeout(50);
          continue;
        }
        let error: string | undefined;
        try {
          const attachments = await options.prepareAttachments(input.attachments, preparing.signal);
          if (finished || stopping) return;
          if (!options.state.markTaskInputSending(task.id, input.index)) continue;
          await options.agent.steer(task.id, input.text, attachments);
        } catch (cause) {
          if (finished || stopping) return;
          error =
            cause instanceof AttachmentError ||
            (cause instanceof Error && cause.message.startsWith("Codex "))
              ? cause.message
              : "Submission unconfirmed. Not retried; check the session before resending.";
        }
        options.state.finishTaskInput(task.id, input.index, error);
      }
    })();
    /** 交互提交独立于慢速补充 RPC；停止、服务端解决和用户选择之间至多提交一次。 */
    const answering = (async () => {
      while (!finished && !stopping) {
        const interaction = options.state.claimInteraction(task.id);
        if (interaction) {
          const submitted = await options.agent.respond(
            task.id,
            interaction.id,
            interaction.answer,
          );
          options.state.closeInteraction(
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
      if (result) options.state.finishTask(task.id, result);
    } catch (error) {
      options.agent.disconnect(task.id);
      await Promise.allSettled([running, steering, answering]);
      options.state.finishTask(task.id, {
        status: "interrupted",
        text: "Service error; shutting down. Check the directory and local processes before sending a new task.",
      });
      throw error;
    } finally {
      preparing.abort();
    }
  }

  return {
    /** 返回前保存消息和必要回复；重复事件直接忽略，不重新执行控制或任务。 */
    async handleMessage(message: IncomingMessage) {
      if (stopping) throw new Error("Service stopping. Message not accepted.");
      let controlQuery: (() => Promise<void>) | undefined;
      let interruptedTask: number | undefined;
      const reply = options.state.accept(message, (channel) => {
        const tasks = options.state.activeTasks(message.channel);
        const task = options.state.sessionTask(channel.id);
        if (message.content.type === "permissions" || message.content.type === "model")
          return options.state.chooseOption(channel.id, message.content);
        if (
          message.content.type === "interaction" ||
          (message.content.type === "text" && message.content.replyToMessageId !== undefined)
        ) {
          const answer = options.state.answerInteraction(channel.id, message.content);
          if (answer !== undefined || message.content.type === "interaction") return answer;
        }
        if (
          changingSessions.has(channel.id) &&
          (message.content.type === "text" ||
            message.content.type === "attachments" ||
            message.content.type === "session" ||
            message.content.type === "sessionPage" ||
            message.content.type === "cwd" ||
            message.content.type === "cwdPage" ||
            (message.content.type === "command" &&
              ["new", "list", "cwd", "update"].includes(message.content.name)))
        )
          return "Session change in progress. Wait for confirmation, then resend your message.";
        if (message.content.type === "sessionPage" || message.content.type === "cwdPage") {
          const query = options.state.turnListPage(channel.id, message.content);
          if (typeof query === "string" || !query) return query;
          controlQuery = () => loadListPage(query);
          return "Loading list.";
        }
        /** 手动路径和菜单选择共用校验；目录按钮只能选择当前消息这一页保存的路径。 */
        if (
          message.content.type === "cwd" ||
          (message.content.type === "command" &&
            message.content.name === "cwd" &&
            message.content.args)
        ) {
          const { content } = message;
          if (content.type === "cwd") {
            const menu = channel.cwdMenu;
            if (
              !menu ||
              menu.id !== content.id ||
              menu.loading ||
              menu.expiresAt <= Date.now() ||
              !menu.messages.some((item) => item.messageId === content.messageId)
            )
              return "List expired. Open /cwd again.";
            if (
              !Number.isInteger(content.optionIndex) ||
              Math.floor(content.optionIndex / listPageSize) !== menu.page
            )
              return "Invalid directory option. Open /cwd again.";
          }
          let cwd =
            content.type === "cwd"
              ? channel.cwdMenu?.options[content.optionIndex]?.id
              : content.args;
          if (!cwd) return "Invalid directory option. Open /cwd again.";
          if (!isAbsolute(cwd)) return "Use an absolute path: /cwd /path/to/project.";
          try {
            cwd = realpathSync(cwd);
            if (!statSync(cwd).isDirectory()) return "Path is not a directory.";
          } catch {
            return "Cannot access directory. Check the path and permissions.";
          }
          if (cwd !== channel.cwd || content.type === "cwd")
            options.state.setSession(
              channel.id,
              cwd,
              cwd === channel.cwd ? channel.sessionId : null,
              content.type === "cwd" ? `Directory: ${cwd}\nSend a task to Codex.` : undefined,
            );
          return content.type === "cwd"
            ? "Directory saved."
            : `Directory: ${cwd}\nSend a task to Codex.`;
        }
        /** 新建命令和会话按钮共用切换保护，仅在接口确认后保存选择。 */
        if (
          message.content.type === "session" ||
          (message.content.type === "command" && message.content.name === "new")
        ) {
          const { content } = message;
          const snapshot = structuredClone(channel);
          controlQuery = async () => {
            changingSessions.add(channel.id);
            let session: AgentOption;
            try {
              session =
                content.type === "command"
                  ? await options.agent.createSession(
                      {
                        cwd: snapshot.cwd,
                        name: content.args,
                        model: snapshot.model,
                        permissionMode: snapshot.permissionMode,
                      },
                      modelLoading.signal,
                    )
                  : await options.agent.readSession(snapshot.cwd, content.id, modelLoading.signal);
            } catch (error) {
              if (!stopping)
                options.state.reply(
                  snapshot.id,
                  error instanceof Error && error.message.startsWith("Codex ")
                    ? error.message
                    : "Cannot change sessions. Current session unchanged. Check /list before retrying.",
                );
              return;
            } finally {
              changingSessions.delete(channel.id);
            }
            /** 接口成功后才更新绑定；存储错误交给工作循环处理。 */
            if (!stopping)
              options.state.setSession(
                snapshot.id,
                snapshot.cwd,
                session.id,
                `${content.type === "command" ? "New session" : "Switched session"}: ${session.label}\nID: ${session.id}\nDirectory: ${snapshot.cwd}`,
              );
          };
          return;
        }
        if (message.content.type === "command") {
          switch (message.content.name) {
            case "start":
            case "help":
              return "Tellrun ready.\nSend text, photos, or files to Codex (up to 20 MB per attachment). Add a caption to describe your task. New messages add to the running task in the selected session.\n/new [name] — Create and select a new session\n/list — Browse sessions, 10 per page; tap to switch\n/cwd [path] — Browse project directories or set a path; changing directories starts a new session\n/status — Status and update check\n/last [count] — Recent finished questions and replies in the selected session\n/interrupt — Interrupt the current task; send a new message after it ends\n/stop — Stop all background terminals in the current session\n/model — Select model and reasoning effort\n/permissions — Select permission mode\n/cron — Manage scheduled tasks\n/restart — Restart Tellrun and reload configuration\n/update — Ask Codex to upgrade Tellrun\nCreate or switch sessions at any time. Tasks in different sessions run concurrently.";
            case "cron":
              return options.state.handleCron(channel.id, message.content.args);
            case "model":
              if (message.content.args) return "Use /model to choose a model with the buttons.";
              options.state.openMenu(channel.id, "model");
              return;
            case "permissions":
              options.state.openMenu(channel.id, "permissions", options.agent.permissionModes);
              return;
            case "status": {
              /** 查询期间保存请求时的选择，后续切换不会改写这次状态快照。 */
              const snapshot = structuredClone(channel);
              controlQuery = async () => {
                /** 未选择时读取有效配置；读取失败仅回退到明确保存的模型与档位。 */
                const describe = async (
                  selection: Pick<typeof snapshot, "cwd" | "model" | "reasoningEffort">,
                ) => {
                  try {
                    return await options.agent.describeModel(
                      selection.cwd,
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
                /** 当前选择与其他运行任务分别展示，所有信息取自命令接收时的快照。 */
                const otherTasks = tasks
                  .filter((item) => item.id !== task?.id)
                  .map((item) =>
                    [
                      `Other task: #${item.id} ${statuses[item.status]}${item.cron ? ` · Cron #${item.cron.id}` : ""}`,
                      `Other task session: ${item.sessionId ?? "Not started"}`,
                      `Other task directory: ${item.cwd}`,
                      item.channelId !== snapshot.id ? "Other task is in another chat." : undefined,
                      item.interactions.length
                        ? `Other task pending: ${item.interactions.map((interaction) => (interaction.kind === "approval" ? "Approval" : "Question")).join(", ")}`
                        : undefined,
                    ]
                      .filter((line) => line !== undefined)
                      .join("\n"),
                  )
                  .join("\n\n");
                /** 权限选择与任务快照沿用同一显示规则。 */
                const formatPermissions = (mode: string | null) =>
                  options.agent.permissionModes.find((option) => option.id === mode)?.label ??
                  mode ??
                  options.agent.permissionModes[0]?.label ??
                  "Not set";
                options.state.reply(
                  snapshot.id,
                  [
                    "Service: connected",
                    `Tellrun: ${options.updates.version}${versionSuffix}`,
                    `${options.agent.name}: ${options.agent.version}`,
                    options.agent.unavailableReason,
                    `Directory: ${snapshot.cwd}`,
                    `Session: ${snapshot.sessionId ?? "Not started"}`,
                    `Model: ${formatModel(model)}`,
                    showTaskModel ? `Task model: ${formatModel(taskModel)}` : undefined,
                    `Permissions: ${formatPermissions(snapshot.permissionMode)}`,
                    task && task.permissionMode !== snapshot.permissionMode
                      ? `Task permissions: ${formatPermissions(task.permissionMode)}`
                      : undefined,
                    `Task: ${task ? `#${task.id} ${statuses[task.status]}${task.cron ? ` · Cron #${task.cron.id}` : ""}` : "idle"}`,
                    task?.interactions.length
                      ? `Task pending: ${task.interactions.map((item) => `${item.kind === "approval" ? "Approval" : "Question"}${item.blocking ? " (waiting)" : " (task running)"}`).join(", ")}`
                      : undefined,
                    otherTasks ? `\n${otherTasks}` : undefined,
                  ]
                    .filter((line) => line !== undefined)
                    .join("\n") + upgradeHint,
                );
              };
              return;
            }
            case "update":
              if (message.content.args) return "Use /update without arguments.";
              if (tasks.length) return "Wait for all tasks to finish, then send /update.";
              /** 复用普通任务的快照、去重、审批和恢复流程，不向执行中的任务追加升级指令。 */
              options.state.createTask(channel, options.updates.upgradePrompt());
              return `Tellrun update queued for ${options.agent.name}.`;
            case "restart":
              if (message.content.args) return "Use /restart without arguments.";
              if (!options.restart)
                return "Restart is unavailable on this platform. Restart Tellrun from the terminal.";
              /** 事务完成后同步停止发送；这条回复由重启并连接成功后的发送循环投递。 */
              controlQuery = async () => options.restart?.();
              return "Tellrun restarted. Configuration reloaded; session and task state preserved.";
            case "cwd": {
              const query = options.state.openList(channel.id, "cwd");
              if (query) controlQuery = () => loadListPage(query);
              return;
            }
            case "list": {
              if (message.content.args) return "Use /list without arguments.";
              const query = options.state.openList(channel.id, "session");
              if (query) controlQuery = () => loadListPage(query);
              return;
            }
            case "stop": {
              if (message.content.args) return "Use /stop without arguments.";
              /** 固定命令收到时的当前选择，不能误停其他会话的后台终端。 */
              const { cwd, sessionId } = channel;
              if (!sessionId) return "No Codex session available yet.";
              controlQuery = async () => {
                try {
                  await options.agent.stop(cwd, sessionId, modelLoading.signal);
                  if (!stopping)
                    options.state.reply(
                      channel.id,
                      `Session: ${sessionId}\nBackground terminals stopped.`,
                    );
                } catch {
                  if (!stopping)
                    options.state.reply(
                      channel.id,
                      "Background terminal cleanup unconfirmed. Check the local Codex session.",
                    );
                }
              };
              return;
            }
            case "interrupt":
              if (message.content.args) return "Use /interrupt without arguments.";
              if (!task || task.channelId !== channel.id)
                return "No task running in the selected session.";
              options.state.cancelTask(task.id);
              interruptedTask = task.id;
              return `Interrupt requested for task #${task.id}. You can send another message when it ends.`;
            case "last": {
              /** 数量只接受正整数；不传时保留最近一条的行为。 */
              const count = message.content.args ? Number(message.content.args) : 1;
              if (
                (message.content.args && !/^\d+$/u.test(message.content.args)) ||
                !Number.isSafeInteger(count) ||
                count < 1
              )
                return "Use /last [count], where count is a positive integer.";
              if (!channel.sessionId)
                return `No session selected yet.${task ? `\nCurrent task #${task.id}: ${statuses[task.status]}. Use /status to check progress.` : " Choose one with /list or create one with /new."}`;
              /** 慢查询固定命令接收时的会话，后续切换不影响本次查询。 */
              const snapshot = { ...channel, sessionId: channel.sessionId };
              controlQuery = async () => {
                let history: AgentSessionHistory;
                try {
                  history = await options.agent.readLastResult(
                    snapshot.cwd,
                    snapshot.sessionId,
                    modelLoading.signal,
                    count,
                  );
                } catch {
                  if (!stopping)
                    options.state.reply(
                      snapshot.id,
                      `#last\n\n${options.agent.unavailableReason ?? "Cannot load session history. Try /last again or choose a session from /list."}`,
                    );
                  return;
                }
                if (stopping) return;
                const { results } = history;
                if (!results.length) {
                  options.state.reply(
                    snapshot.id,
                    `#last\n\nNo finished results in this session.${task ? `\nCurrent task #${task.id}: ${statuses[task.status]}. Use /status to check progress.` : history.running ? "\nA turn is still running in this session. Check /status or the local Codex session." : ""}`,
                  );
                  return;
                }
                /** 最近记录按时间正序发送，序号从 1 开始且仅用于本次查询。 */
                for (const [index, last] of results.toReversed().entries())
                  options.state.reply(
                    snapshot.id,
                    `**#last ${index + 1}** · ${statuses[last.status]}\n\n**Question:**\n${last.prompt || "(No task description)"}\n\n**Reply:**\n${last.text}`,
                    { markdown: true },
                  );
              };
              return;
            }
            default:
              return "Unknown command. See /help.";
          }
        }
        if (message.content.type !== "text" && message.content.type !== "attachments")
          return "Send text, a photo, or a file. See /help.";
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
          options.state.appendTaskInput(task.id, message.content.text, attachments);
          return;
        }
        options.state.createTask(channel, message.content.text, attachments);
      });
      /** 只有入站去重记录保存成功后才执行；重复事件不会重复切换会话或重启。 */
      if (controlQuery) {
        const query = controlQuery();
        controlQueries.push(query);
        /** 错误由工作循环等待原 Promise 时传播，提前标记避免未处理拒绝。 */
        void query.catch(() => {});
      }
      /** 中断命令的状态落盘后才影响运行时。 */
      if (interruptedTask !== undefined) {
        runningTasks.get(interruptedTask)?.preparation.abort();
        options.agent.interrupt(interruptedTask);
      }
      return reply;
    },
    /** 模型、状态和会话请求不占用入站或任务循环，关停后丢弃迟到结果。 */
    async loadModels(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
      try {
        while (!stopping) {
          const query = controlQueries.shift();
          if (query) {
            await query;
            continue;
          }
          const menu = options.state.pendingModels(source);
          if (!menu) {
            await setTimeout(100);
            continue;
          }
          /** 配置与目录独立查询；无法解析当前选择时仍可展示可用的模型按钮。 */
          const [models, current] = await Promise.all([
            options.agent.listModels(menu.cwd, modelLoading.signal).catch(() => undefined),
            options.agent.describeModel(menu.cwd, menu, modelLoading.signal).catch(() => undefined),
          ]);
          if (!stopping) options.state.fillModels(menu.channelId, menu.id, models, current);
        }
      } finally {
        modelLoading.abort();
        await Promise.allSettled(controlQueries);
      }
    },
    /** 调度独立于执行和菜单查询；启动先跳过离线时段，再按持久化时间触发。 */
    async schedule(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
      if (stopping) return;
      options.state.recoverCrons(source);
      while (!stopping) {
        options.state.tickCrons(source);
        await setTimeout(1_000);
      }
    },
    /** 领取后立即启动独立执行，不等待其他会话；退出前收齐所有工作循环。 */
    async run(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
      let failure: { error: unknown } | undefined;
      try {
        while (!stopping) {
          if (failure) throw failure.error;
          const task = options.state.claimTask(source, new Set(runningTasks.keys()));
          if (!task) {
            await setTimeout(50);
            continue;
          }
          const preparation = new AbortController();
          const promise = executeTask(task, preparation)
            .catch((error: unknown) => {
              failure ??= { error };
            })
            .finally(() => {
              preparation.abort();
              runningTasks.delete(task.id);
            });
          runningTasks.set(task.id, { preparation, promise });
        }
      } finally {
        for (const task of runningTasks.values()) task.preparation.abort();
        options.agent.disconnect();
        await Promise.allSettled([...runningTasks.values()].map((task) => task.promise));
      }
      if (failure) throw failure.error;
    },
    /** 服务退出只断开客户端；后台任务继续运行，重启后按已保存轮次接回。 */
    stop() {
      stopping = true;
      modelLoading.abort();
      for (const task of runningTasks.values()) task.preparation.abort();
      options.agent.disconnect();
    },
  };
}
