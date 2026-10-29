import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appDirectory } from "../config.js";
import type {
  AgentInteraction,
  AgentResult,
  ChannelIdentity,
  IncomingMessage,
  InteractionAnswer,
  PermissionMode,
} from "../core/types.js";
import { writeJson } from "./json.js";
import { acquireLock } from "./lock.js";
import { activeTaskStatuses, type State, stateSchema } from "./schema.js";

/** 打开文件状态并取得单实例锁；所有业务写入统一替换 state.json。 */
export function openStore(path = join(appDirectory, "state.json")) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (dirname(path) === appDirectory) chmodSync(appDirectory, 0o700);
  const release = acquireLock(path);
  let usable = true;
  let updating = false;
  /** 流式预览只保留内存中的最新片段，不为每个文本增量写磁盘。 */
  let draft: { taskId: number; text: string } | undefined;
  /** 单个发送循环正在处理的回复；交互关闭时仍需保留它的消息清理关联。 */
  let delivering: State["outbox"][number] | undefined;

  try {
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
      state = { channels: [], inboundUpdates: [], tasks: [], interactions: [], outbox: [] };
      writeJson(path, state);
    }
    /** 交互撤回可能清空发送队列；实例内保持递增，避免迟到发送回执删除新消息。 */
    let replyId = state.outbox.reduce((max, item) => Math.max(max, item.id), 0);

    /** 一次业务操作只保存一个快照；嵌套操作合并写入，失败时回滚内存并停止后续写入。 */
    function update<T>(action: () => T): T {
      if (!usable) throw new Error("State storage unavailable. Restart the service.");
      if (updating) return action();
      const previous = state;
      state = structuredClone(state);
      updating = true;
      try {
        const result = action();
        /** state 只保留运行所需记录；发送中的交互及待发送编辑不能提前回收。 */
        state.interactions = state.interactions.filter(
          (item) =>
            item.status !== "closed" ||
            item.id === delivering?.interactionId ||
            state.outbox.some((reply) => reply.interactionId === item.id),
        );
        const latest = new Set(
          state.channels.map(
            (channel) =>
              state.tasks.findLast(
                (task) => task.channelId === channel.id && !activeTaskStatuses.has(task.status),
              )?.id,
          ),
        );
        state.tasks = state.tasks.filter(
          (task) =>
            activeTaskStatuses.has(task.status) ||
            latest.has(task.id) ||
            state.interactions.some((item) => item.taskId === task.id),
        );
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
    function enqueueReply(
      channelId: number,
      text: string | undefined,
      delivery: Pick<
        State["outbox"][number],
        "interactionId" | "questionIndex" | "messageId" | "permissionMenuId"
      > = {},
    ) {
      if (text === undefined) return;
      const parts = delivery.messageId
        ? [text]
        : (text.match(/[\s\S]{1,2000}/gu) ?? ["(No text reply)"]);
      for (const [index, part] of parts.entries()) {
        state.outbox.push({
          id: ++replyId,
          channelId,
          text: parts.length > 1 ? `(${index + 1}/${parts.length})\n${part}` : part,
          attempts: 0,
          retryAt: Date.now(),
          ...delivery,
          ...((delivery.interactionId || delivery.permissionMenuId) && !delivery.messageId
            ? { promptEnd: index === parts.length - 1 }
            : {}),
        });
      }
    }

    /** 新建、使用或失效菜单时清理按钮，发送途中的旧消息由回执继续清理。 */
    function closePermissionMenu(channelId: number) {
      const channel = state.channels.find((item) => item.id === channelId);
      if (!channel?.permissionMenu) return;
      state.outbox = state.outbox.filter(
        (reply) => reply.permissionMenuId !== channel.permissionMenu?.id,
      );
      for (const message of channel.permissionMenu.messages)
        enqueueReply(channel.id, message.text, { messageId: message.messageId });
      channel.permissionMenu = null;
    }

    /** 关闭请求或单个已答问题；撤回未发送提示，已发送消息保留正文并移除按钮。 */
    function closeInteraction(id: string, reason: string, questionIndex?: number) {
      const interaction = state.interactions.find((item) => item.id === id);
      if (!interaction || interaction.status === "closed") return;
      update(() => {
        const interaction = state.interactions.find((item) => item.id === id);
        const task = state.tasks.find((task) => task.id === interaction?.taskId);
        if (!interaction || !task) return;
        if (questionIndex === undefined) {
          interaction.status = "closed";
          interaction.resolution = reason;
        }
        state.outbox = state.outbox.filter(
          (reply) =>
            reply.interactionId !== id ||
            (questionIndex !== undefined && reply.questionIndex !== questionIndex),
        );
        for (const message of interaction.messages) {
          if (questionIndex !== undefined && message.questionIndex !== questionIndex) continue;
          enqueueReply(task.channelId, `${message.text}\n\n${reason}`, {
            interactionId: id,
            messageId: message.messageId,
            ...(message.questionIndex !== undefined
              ? { questionIndex: message.questionIndex }
              : {}),
          });
        }
      });
    }

    /** 终态与最终回复一起保存，成功时只发送正文；迟到事件不能覆盖已完成结果。 */
    function finishTask(id: number, result: AgentResult) {
      if (!state.tasks.some((task) => task.id === id && activeTaskStatuses.has(task.status)))
        return;
      update(() => {
        const task = state.tasks.find((task) => task.id === id);
        if (!task) throw new Error("Task not found.");
        Object.assign(task, { status: result.status, result: result.text });
        for (const interaction of state.interactions.filter((item) => item.taskId === id))
          closeInteraction(interaction.id, "Task ended. Request closed.");
        if (result.status === "interrupted") {
          const channel = state.channels.find((channel) => channel.id === task.channelId);
          if (channel) channel.paused = true;
        }
        enqueueReply(
          task.channelId,
          result.status === "completed"
            ? result.text
            : `Task #${id} ${
                {
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

    /** 命令与交互按钮共用停止逻辑；先使交互失效，再由核心层请求中断。 */
    function cancelTask(id: number) {
      if (state.tasks.find((task) => task.id === id)?.status === "queued") {
        finishTask(id, { status: "cancelled", text: "Cancelled before starting." });
      } else
        update(() => {
          const task = state.tasks.find(
            (task) => task.id === id && activeTaskStatuses.has(task.status),
          );
          if (task) task.status = "cancelling";
          for (const interaction of state.interactions.filter((item) => item.taskId === id))
            closeInteraction(interaction.id, "Stopping. Request closed.");
        });
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
          return ["interaction", "permissions"].includes(message.content.type)
            ? "Already handled."
            : undefined;
        return update(() => {
          let channel = state.channels.find((channel) => channel.id === existing?.id);
          if (!channel) {
            channel = {
              ...message.channel,
              id: state.channels.reduce((max, item) => Math.max(max, item.id), 0) + 1,
              cwd: null,
              sessionId: null,
              paused: false,
              permissionMode: null,
              permissionMenu: null,
            };
            state.channels.push(channel);
          }
          channel.userId = message.channel.userId;
          state.inboundUpdates.push({
            channelId: channel.id,
            eventId: message.eventId,
          });
          const reply = handle(channel);
          if (!["interaction", "permissions"].includes(message.content.type))
            enqueueReply(channel.id, reply);
          return reply;
        });
      },
      /** 成功拉取后才能回收已确认更新；空响应也说明服务端已无可重投记录。 */
      confirmUpdates(accountId: string, offset: number, empty: boolean) {
        const pending = state.inboundUpdates.filter((item) => {
          const channel = state.channels.find((channel) => channel.id === item.channelId);
          return (
            channel?.platform !== "telegram" ||
            channel.accountId !== accountId ||
            (!empty && !(Number(item.eventId) < offset))
          );
        });
        if (pending.length !== state.inboundUpdates.length)
          update(() => {
            state.inboundUpdates = pending;
          });
      },
      /** 新会话或目录变化只影响后续任务，已保存任务仍使用自己的快照。 */
      setSession(channelId: number, cwd: string | null) {
        update(() => {
          const channel = state.channels.find((channel) => channel.id === channelId);
          if (channel) {
            closePermissionMenu(channelId);
            if (cwd !== channel.cwd) channel.permissionMode = null;
            Object.assign(channel, { cwd, sessionId: null });
          }
        });
      },
      /** 菜单只依赖通用模式信息；不启动 Agent 或调用模型。 */
      openPermissions(channelId: number, modes: readonly PermissionMode[]) {
        update(() => {
          const channel = state.channels.find((item) => item.id === channelId);
          if (!channel) return;
          closePermissionMenu(channelId);
          channel.permissionMenu = {
            id: crypto.randomUUID(),
            expiresAt: Date.now() + 600_000,
            options: modes.map(({ id, label }) => ({ id, label })),
            messages: [],
          };
          enqueueReply(
            channelId,
            `Permissions\nCurrent selection: ${modes.find((mode) => mode.id === channel.permissionMode)?.label ?? channel.permissionMode ?? modes[0]?.label ?? "Not set"}\n\n${modes.map((mode, index) => `${index + 1}. ${mode.label}`).join("\n")}\n\nApplies to future tasks. The current task keeps its permissions. Modes are subject to local configuration.`,
            { permissionMenuId: channel.permissionMenu.id },
          );
        });
      },
      /** 校验聊天、原消息、菜单和有效期；只保存模式，不改变已提交任务的快照。 */
      choosePermissions(
        channelId: number,
        content: Extract<IncomingMessage["content"], { type: "permissions" }>,
      ) {
        const channel = state.channels.find((item) => item.id === channelId);
        const menu = channel?.permissionMenu;
        if (
          !menu ||
          menu.id !== content.id ||
          menu.expiresAt <= Date.now() ||
          !menu.messages.some((message) => message.messageId === content.messageId)
        )
          return "Menu expired. Open /permissions again.";
        const option = menu.options[content.optionIndex];
        if (!option) return "Invalid permission option.";
        update(() => {
          const current = state.channels.find((item) => item.id === channelId);
          if (!current) return;
          current.permissionMode = option.id;
          closePermissionMenu(channelId);
          enqueueReply(channelId, `Selected: ${option.label}. Applies to the next task.`);
        });
        return "Permission mode saved.";
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
        const task = state.tasks.find((task) => activeTaskStatuses.has(task.status));
        return task
          ? structuredClone({
              ...task,
              interactions: state.interactions.filter(
                (item) => item.taskId === task.id && item.status !== "closed",
              ),
            })
          : undefined;
      },
      /** 限制预览为末尾 2000 个 Unicode 字符，完整结果仍由最终回复保存。 */
      setDraft(id: number, text: string) {
        if (state.tasks.some((task) => task.id === id && task.status === "running"))
          draft = { taskId: id, text: [...text].slice(-2000).join("") };
      },
      /** 仅向当前机器人与授权用户返回执行中的草稿，停止后不再刷新。 */
      pendingDraft(accountId: string, userId: string) {
        if (!draft?.text.trim()) return;
        if (
          state.interactions.some(
            (item) => item.taskId === draft?.taskId && item.blocking && item.status !== "closed",
          )
        )
          return;
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
        return structuredClone(
          state.tasks.findLast(
            (task) => task.channelId === channelId && !activeTaskStatuses.has(task.status),
          ) ?? state.tasks.findLast((task) => task.channelId === channelId),
        );
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
            runId: null,
            prompt,
            permissionMode: channel.permissionMode,
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
      /** 领取新任务或已保存轮次；恢复只连接后台，不能重发原始输入。 */
      claimTask(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
        const index = state.tasks.findIndex((task) => activeTaskStatuses.has(task.status));
        const task = state.tasks[index];
        const channel = state.channels.find((channel) => channel.id === task?.channelId);
        if (
          !task ||
          !channel ||
          (channel.paused && !task.runId) ||
          channel.platform !== source.platform ||
          channel.accountId !== source.accountId ||
          channel.userId !== source.userId
        )
          return;
        return update(() => {
          const claimed = {
            ...task,
            status:
              task.status === "cancelling" ? ("cancelling" as const) : ("dispatching" as const),
          };
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
      /** 轮次 ID 与执行状态一起落盘；迟到通知不能撤销停止请求。 */
      markRunning(id: number, runId: string) {
        update(() => {
          const task = state.tasks.find((task) => task.id === id);
          if (!task || !activeTaskStatuses.has(task.status)) return;
          if (task.runId && task.runId !== runId) throw new Error("Task turn changed.");
          task.runId = runId;
          if (task.status === "dispatching") task.status = "running";
        });
      },
      cancelTask,
      finishTask,
      /** 交互展示与任务关联一起保存；多题分别发送，任意一段都能明确回复。 */
      addInteraction(taskId: number, request: AgentInteraction) {
        update(() => {
          const task = state.tasks.find((task) => task.id === taskId && task.status === "running");
          if (!task || state.interactions.some((item) => item.id === request.id)) return;
          state.interactions.push({
            ...request,
            taskId,
            questions: request.questions.map((question) => ({ ...question, answer: null })),
            decision: null,
            status: "pending",
            resolution: null,
            messages: [],
          });
          if (request.kind === "approval") {
            enqueueReply(
              task.channelId,
              `Task #${taskId} · Approval\n${request.text}\n\nChoose below.`,
              { interactionId: request.id },
            );
          } else {
            for (const [index, question] of request.questions.entries())
              enqueueReply(
                task.channelId,
                `Task #${taskId} · Question ${index + 1}/${request.questions.length}\n${question.header}\n${question.question}${question.options.map((option, i) => `\n\n${i + 1}. ${option.label}\n${option.description}`).join("")}\n\n${question.allowText ? "Pick an option or reply to this message." : "Pick an option or reply with its number or label."}\nAnswer all questions to submit.`,
                { interactionId: request.id, questionIndex: index },
              );
          }
        });
      },
      /** 与入站去重同一事务领取选择；不把普通消息或旧问题回复误作当前任务输入。 */
      answerInteraction(
        channelId: number,
        content: Extract<IncomingMessage["content"], { type: "interaction" | "text" }>,
      ) {
        const interaction = state.interactions.find((item) =>
          content.type === "interaction"
            ? item.id === content.id
            : item.messages.some((message) => message.messageId === content.replyToMessageId) &&
              state.tasks.some((task) => task.id === item.taskId && task.channelId === channelId),
        );
        if (!interaction)
          return content.type === "interaction"
            ? "Request expired."
            : content.replyToMessageId !== undefined
              ? "Send a new message to continue."
              : undefined;
        const task = state.tasks.find(
          (task) => task.id === interaction.taskId && task.channelId === channelId,
        );
        const message = interaction.messages.find(
          (item) =>
            item.messageId ===
            (content.type === "interaction" ? content.messageId : content.replyToMessageId),
        );
        if (
          task?.status !== "running" ||
          !message ||
          interaction.status !== "pending" ||
          interaction.expiresAt <= Date.now()
        )
          return "Request closed. Check /status.";
        if (content.type === "interaction" && content.action === "stop") {
          update(() => {
            const channel = state.channels.find((channel) => channel.id === channelId);
            if (channel) channel.paused = true;
            cancelTask(task.id);
          });
          return "Stopping. Wait for the result.";
        }
        if (interaction.kind === "approval") {
          if (
            content.type !== "interaction" ||
            (content.action !== "accept" && content.action !== "decline") ||
            !interaction.choices.includes(content.action)
          )
            return "Use the approval buttons.";
          update(() => {
            const current = state.interactions.find((item) => item.id === interaction.id);
            if (!current) return;
            current.decision = content.action as "accept" | "decline";
            current.status = "ready";
          });
          return "Saved. Submitting...";
        }
        const question =
          message.questionIndex === undefined
            ? undefined
            : interaction.questions[message.questionIndex];
        if (!question || question.answer !== null) return "Question closed.";
        let answer: string | undefined;
        if (content.type === "interaction") {
          if (
            content.action !== "option" ||
            content.questionIndex !== message.questionIndex ||
            content.optionIndex === undefined
          )
            return "Invalid option.";
          answer = question.options[content.optionIndex]?.label;
        } else {
          answer = content.text.trim();
          answer =
            question.options.find(
              (option, index) => String(index + 1) === answer || option.label === answer,
            )?.label ?? (question.allowText ? answer : undefined);
        }
        if (!answer) return "Invalid answer. Try again.";
        update(() => {
          const current = state.interactions.find((item) => item.id === interaction.id);
          const question = current?.questions[message.questionIndex ?? -1];
          if (!current || !question) return;
          question.answer = answer;
          closeInteraction(interaction.id, "Answer saved.", message.questionIndex);
          if (current.questions.every((question) => question.answer !== null))
            current.status = "ready";
        });
        return "Answer saved.";
      },
      /** 提交前持久化 sending；重启不会重放已经领取的批准或答案。 */
      claimInteraction(taskId: number) {
        const interaction = state.interactions.find(
          (item) =>
            item.taskId === taskId && item.status === "ready" && item.expiresAt > Date.now(),
        );
        if (
          !interaction ||
          !state.tasks.some((task) => task.id === taskId && task.status === "running")
        )
          return;
        return update(() => {
          const current = state.interactions.find((item) => item.id === interaction.id);
          if (!current) return;
          current.status = "sending";
          const answer: InteractionAnswer =
            current.kind === "approval" && current.decision
              ? { decision: current.decision }
              : {
                  answers: Object.fromEntries(
                    current.questions.map((question) => [
                      question.id,
                      { answers: [question.answer ?? ""] },
                    ]),
                  ),
                };
          return { id: current.id, answer };
        });
      },
      closeInteraction,
      /** 有轮次 ID 的任务重新连接；未确认派发和在途输入不自动重放。 */
      recoverTasks() {
        if (state.channels.some((channel) => channel.permissionMenu))
          update(() => {
            for (const channel of state.channels) closePermissionMenu(channel.id);
          });
        for (const task of state.tasks.filter(
          (task) => activeTaskStatuses.has(task.status) && task.status !== "queued",
        )) {
          if (task.sessionId && task.runId) {
            for (const [index, input] of task.inputs.entries()) {
              if (input.status !== "sending") continue;
              update(() => {
                const current = state.tasks.find((item) => item.id === task.id)?.inputs[index];
                if (current) current.status = "failed";
                enqueueReply(
                  task.channelId,
                  `Task #${task.id}, message ${index + 1}: delivery unconfirmed after restart. Not retried; check the session before resending.`,
                );
              });
            }
            continue;
          }
          finishTask(task.id, {
            status: "interrupted",
            text: "Service restarted; task result unknown. Check the project, then /resume and send a new task.",
          });
        }
        for (const interaction of state.interactions)
          closeInteraction(interaction.id, "Service restarted. Request closed.");
      },
      /** 按机器人与授权用户领取最早回复，内存关联保留到发送成功或失败。 */
      claimReply(accountId: string, userId: string) {
        if (delivering) return;
        for (const channel of state.channels)
          if (channel.permissionMenu && channel.permissionMenu.expiresAt <= Date.now())
            update(() => closePermissionMenu(channel.id));
        for (const reply of state.outbox) {
          const interaction = state.interactions.find((item) => item.id === reply.interactionId);
          if (
            reply.interactionId &&
            !reply.messageId &&
            (interaction?.status !== "pending" ||
              interaction.expiresAt <= Date.now() ||
              (reply.questionIndex !== undefined &&
                interaction.questions[reply.questionIndex]?.answer !== null))
          )
            continue;
          const channel = state.channels.find((channel) => channel.id === reply.channelId);
          if (
            channel?.platform === "telegram" &&
            channel.accountId === accountId &&
            channel.userId === userId
          ) {
            if (reply.retryAt > Date.now()) return;
            delivering = structuredClone(reply);
            return structuredClone({
              ...reply,
              chatId: channel.chatId,
              interaction,
              permissionMenu:
                channel.permissionMenu?.id === reply.permissionMenuId
                  ? channel.permissionMenu
                  : undefined,
            });
          }
        }
      },
      /** 发送成功或永久拒绝后移出队列；/last 只保留每个聊天的最近结果。 */
      removeReply(
        id: number,
        delivery?: {
          messageId: number;
          text: string;
          interactionId?: string;
          questionIndex?: number;
          permissionMenuId?: string;
        },
      ) {
        update(() => {
          const channelId =
            delivering?.id === id
              ? delivering.channelId
              : state.outbox.find((reply) => reply.id === id)?.channelId;
          if (delivering?.id === id) delivering = undefined;
          state.outbox = state.outbox.filter((reply) => reply.id !== id);
          if (delivery?.permissionMenuId && channelId !== undefined) {
            const channel = state.channels.find((item) => item.id === channelId);
            if (
              channel?.permissionMenu?.id === delivery.permissionMenuId &&
              channel.permissionMenu.expiresAt > Date.now()
            )
              channel.permissionMenu.messages.push({
                messageId: delivery.messageId,
                text: delivery.text,
              });
            else enqueueReply(channelId, delivery.text, { messageId: delivery.messageId });
          }
          const interaction = state.interactions.find(
            (item) => item.id === delivery?.interactionId,
          );
          const task = state.tasks.find((task) => task.id === interaction?.taskId);
          if (interaction && task && delivery) {
            interaction.messages.push({
              messageId: delivery.messageId,
              text: delivery.text,
              ...(delivery.questionIndex !== undefined
                ? { questionIndex: delivery.questionIndex }
                : {}),
            });
            /** 发送途中请求可能已关闭或该问题已回答；迟到的消息也必须移除按钮。 */
            if (
              interaction.status !== "pending" ||
              interaction.expiresAt <= Date.now() ||
              (delivery.questionIndex !== undefined &&
                interaction.questions[delivery.questionIndex]?.answer !== null)
            )
              enqueueReply(
                task.channelId,
                `${delivery.text}\n\n${interaction.resolution ?? "Request closed."}`,
                {
                  interactionId: interaction.id,
                  messageId: delivery.messageId,
                  ...(delivery.questionIndex !== undefined
                    ? { questionIndex: delivery.questionIndex }
                    : {}),
                },
              );
          }
        });
      },
      /** 发送失败只更新回复的重试信息，不影响任务执行状态。 */
      retryReply(id: number, seconds: number) {
        update(() => {
          if (delivering?.id === id) delivering = undefined;
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
