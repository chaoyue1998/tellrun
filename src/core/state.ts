import { createCrons } from "./cron.js";
import { createMenus } from "./menus.js";
import { activeTaskStatuses, type State } from "./schema.js";
import type {
  AgentAttachment,
  AgentInteraction,
  AgentMessage,
  AgentResult,
  Attachment,
  ChannelIdentity,
  IncomingMessage,
  InteractionAnswer,
} from "./types.js";

/** 已绑定会话按 Agent 与原生 ID 匹配；空选择按 Agent 与版本匹配，定时任务不占用手动空会话。 */
function matchesSession(task: State["tasks"][number], channel: State["channels"][number]) {
  if (task.agent !== channel.agent) return false;
  return channel.sessionId !== null
    ? task.sessionId === channel.sessionId
    : !task.cron &&
        task.sessionId === null &&
        task.channelId === channel.id &&
        task.cwd === channel.cwd &&
        task.sessionGeneration === channel.sessionGeneration;
}

/** 预览、结果和交互共用来源标识，多 Agent 与多会话交替输出时仍能辨认所属任务。 */
function taskHeading(task: State["tasks"][number], agentLabel: (agentId: string) => string) {
  return `Task #${task.id} · ${agentLabel(task.agent)}${task.cron ? ` · Cron #${task.cron.id}` : ""}\nSession: ${task.sessionId ?? "Not started"}\nDirectory: ${task.cwd}`;
}

/** 管理业务状态及事务；初始快照、保存方式和默认目录由组装入口提供。 */
export function createState(options: {
  initialState: State | undefined;
  save: (state: State) => void;
  cwd: string;
  /** 新建聊天及兜底切换使用的默认 Agent 标识。 */
  defaultAgent: string;
  /** 当前启用的全部 Agent 标识；已移除的 Agent 在启动恢复时切回默认项。 */
  availableAgents: readonly string[];
  /** 将 Agent 标识转换为展示名称，用于任务标题和定时计划列表。 */
  agentLabel: (agentId: string) => string;
}) {
  let state: State = structuredClone(
    options.initialState ?? {
      channels: [],
      inboundUpdates: [],
      nextCronId: 1,
      crons: [],
      tasks: [],
      interactions: [],
      outbox: [],
    },
  );
  if (!options.initialState) options.save(state);
  const { defaultAgent, agentLabel } = options;
  const availableAgents = new Set(options.availableAgents);
  let updating = false;
  /** 流式预览只保留内存中的最新片段，不为每个文本增量写磁盘。 */
  const drafts = new Map<number, AgentMessage[]>();
  /** 控制回复、普通文字与附件各有一个在途请求；交互关闭后保留迟到回执的关联。 */
  const delivering = new Map<number, State["outbox"][number]>();

  /** 交互撤回可能清空发送队列；实例内保持递增，避免迟到发送回执删除新消息。 */
  let replyId = state.outbox.reduce((max, item) => Math.max(max, item.id), 0);

  /** 一次业务操作只保存一个快照；嵌套操作合并提交，保存失败时回滚内存。 */
  function update<T>(action: () => T): T {
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
          [...delivering.values()].some((reply) => reply.interactionId === item.id) ||
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
      options.save(state);
      return structuredClone(result);
    } catch (error) {
      state = previous;
      throw error;
    } finally {
      updating = false;
    }
  }

  /** 账号级限流独立于消息保存，撤回、重启或新回复不能绕过尚未结束的等待。 */
  function replyRetryAt(source: Pick<ChannelIdentity, "platform" | "accountId">) {
    return state.channels.reduce(
      (at, channel) =>
        channel.platform === source.platform && channel.accountId === source.accountId
          ? Math.max(at, channel.replyRetryAt)
          : at,
      0,
    );
  }

  /** 回复按展示格式分段，并与触发它的状态变更一起保存。 */
  function enqueueReply(
    channelId: number,
    text: string | undefined,
    {
      attachments = [],
      priority = true,
      ...delivery
    }: Partial<
      Pick<
        State["outbox"][number],
        | "interactionId"
        | "questionIndex"
        | "messageId"
        | "permissionMenuId"
        | "modelMenuId"
        | "agentMenuId"
        | "sessionMenuId"
        | "cwdMenuId"
        | "markdown"
        | "priority"
        | "taskId"
        | "segmentId"
      >
    > & { attachments?: AgentAttachment[] } = {},
  ) {
    if (text === undefined) return;
    /** 结果分段和附件共用同一来源，每条消息都能独立辨认任务。 */
    const task = state.tasks.find((item) => item.id === delivery.taskId);
    const parts =
      delivery.messageId && !delivery.taskId
        ? [text]
        : delivery.markdown
          ? [text || "(No text reply)"]
          : (text.match(/[\s\S]{1,2000}/gu) ?? ["(No text reply)"]);
    if (delivery.markdown && (!delivery.messageId || delivery.taskId) && text.length > 30000) {
      parts.length = 0;
      let part = "";
      /** 保存围栏与语言标记，代码跨段时关闭并在下一段重新打开。 */
      let fence: { marker: string; opening: string } | undefined;
      for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
        /** 预留编号与围栏空间；超长单行按 Unicode 字符拆分，保留全部内容。 */
        for (const chunk of line.match(/[\s\S]{1,14000}/gu) ?? []) {
          if (part.length + chunk.length > 30000) {
            parts.push(
              `${part}${fence ? `${part.endsWith("\n") ? "" : "\n"}${fence.marker}` : ""}`,
            );
            part = fence ? `${fence.opening}\n` : "";
          }
          part += chunk;
        }
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$/u);
        if (!fence && marker?.[1] && marker[2] !== undefined) {
          if (marker[1].startsWith("~") || !marker[2].includes("`"))
            fence = { marker: marker[1], opening: line.replace(/\r?\n$/u, "") };
        } else if (
          fence &&
          marker?.[1] &&
          marker[1][0] === fence.marker[0] &&
          marker[1].length >= fence.marker.length &&
          !marker[2]?.trim()
        )
          fence = undefined;
      }
      if (part) parts.push(part);
    }
    for (const [index, part] of parts.entries()) {
      state.outbox.push({
        ...(index ? { afterId: replyId } : {}),
        id: ++replyId,
        channelId,
        priority,
        text: `${task ? `${taskHeading(task, agentLabel)}\n\n` : ""}${
          parts.length > 1
            ? `(${index + 1}/${parts.length})\n${delivery.markdown ? "\n" : ""}${part}`
            : part
        }`,
        attempts: 0,
        retryAt: Date.now(),
        ...delivery,
        /** 长结果只将第一段写回预览，其余分段按顺序新建。 */
        ...(index && delivery.taskId ? { messageId: undefined } : {}),
        ...(delivery.permissionMenuId ||
        delivery.modelMenuId ||
        delivery.agentMenuId ||
        delivery.sessionMenuId ||
        delivery.cwdMenuId ||
        (delivery.interactionId && !delivery.messageId)
          ? { promptEnd: index === parts.length - 1 }
          : {}),
      });
    }
    /** 附件与正文在同一状态事务中落盘，每个附件拥有独立发送回执。 */
    for (const attachment of attachments) {
      state.outbox.push({
        afterId: replyId,
        id: ++replyId,
        channelId,
        priority: false,
        text: task ? taskHeading(task, agentLabel) : "",
        ...(task ? { taskId: task.id } : {}),
        attachment,
        attempts: 0,
        retryAt: Date.now(),
      });
    }
  }

  /** 返回各任务的独立快照，限定来源时不能暴露其他账号的活动信息。 */
  function activeTasks(source?: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
    return state.tasks
      .filter(
        (task) =>
          activeTaskStatuses.has(task.status) &&
          (!source ||
            state.channels.some(
              (channel) =>
                channel.id === task.channelId &&
                channel.platform === source.platform &&
                channel.accountId === source.accountId &&
                channel.userId === source.userId,
            )),
      )
      .map((task) =>
        structuredClone({
          ...task,
          interactions: state.interactions.filter(
            (item) => item.taskId === task.id && item.status !== "closed",
          ),
        }),
      );
  }

  /** 手动任务按会话互斥，不同会话可并发；定时任务始终创建独立会话。 */
  function createTask(
    channel: State["channels"][number],
    prompt: string,
    attachments: Attachment[] = [],
    cron: State["tasks"][number]["cron"] = null,
  ) {
    return update(() => {
      if (!cron && activeTasks().some((task) => matchesSession(task, channel)))
        throw new Error("A task is already running in this session.");
      const task: State["tasks"][number] = {
        id: state.tasks.reduce((max, item) => Math.max(max, item.id), 0) + 1,
        channelId: channel.id,
        cron,
        cwd: channel.cwd,
        agent: channel.agent,
        sessionId: channel.sessionId,
        sessionGeneration: channel.sessionGeneration,
        runId: null,
        previewMessages: [],
        prompt,
        attachments,
        permissionMode: channel.permissionMode,
        model: channel.model,
        reasoningEffort: channel.reasoningEffort,
        inputs: [],
        status: "queued",
        result: null,
      };
      state.tasks.push(task);
      return task;
    });
  }

  /** 定时执行固定创建时的选择，每次新建会话，不改变聊天当前会话。 */
  const crons = createCrons({
    read: () => state,
    update,
    agentLabel,
    enqueueReply,
    createTask: (channel, cron, scheduledAt) =>
      createTask(
        {
          ...channel,
          cwd: cron.cwd,
          agent: cron.agent,
          sessionId: null,
          model: cron.model,
          reasoningEffort: cron.reasoningEffort,
          permissionMode: cron.permissionMode,
        },
        cron.prompt,
        [],
        { id: cron.id, scheduledAt },
      ),
  });

  /** 切换聊天使用的 Agent：保存当前 Agent 的会话/模型/权限快照，并按目录恢复目标 Agent 状态。 */
  function setAgent(
    channelId: number,
    nextAgent: string,
    options: { reply?: string; keepMessageId?: number } = {},
  ) {
    update(() => {
      const channel = state.channels.find((item) => item.id === channelId);
      if (!channel) return;
      const previousAgent = channel.agent;
      closeMenu(channelId, "agentMenu", options.keepMessageId);
      closeMenu(channelId, "permissionMenu");
      closeMenu(channelId, "modelMenu");
      closeMenu(channelId, "sessionMenu");
      closeMenu(channelId, "cwdMenu");
      if (previousAgent !== nextAgent) {
        channel.agentStates[previousAgent] = {
          cwd: channel.cwd,
          sessionId: channel.sessionId,
          permissionMode: channel.permissionMode,
          model: channel.model,
          reasoningEffort: channel.reasoningEffort,
        };
        const restored = channel.agentStates[nextAgent];
        channel.agent = nextAgent;
        channel.sessionGeneration += 1;
        channel.sessionId = restored && restored.cwd === channel.cwd ? restored.sessionId : null;
        channel.permissionMode = restored ? restored.permissionMode : null;
        channel.model = restored ? restored.model : null;
        channel.reasoningEffort = restored ? restored.reasoningEffort : null;
      }
      if (options.reply)
        enqueueReply(
          channelId,
          options.reply,
          options.keepMessageId !== undefined ? { messageId: options.keepMessageId } : {},
        );
    });
  }

  /** 菜单始终读取当前事务快照，避免捕获 update 替换前的状态。 */
  const { closeMenu, ...menus } = createMenus({
    read: () => state,
    update,
    switchAgent: (channelId, agentId, label, keepMessageId) => {
      const channel = state.channels.find((item) => item.id === channelId);
      const restored =
        channel?.agent === agentId
          ? channel.sessionId
          : channel?.agentStates[agentId]?.cwd === channel?.cwd
            ? channel?.agentStates[agentId]?.sessionId
            : null;
      setAgent(channelId, agentId, {
        ...(keepMessageId !== undefined ? { keepMessageId } : {}),
        reply: `✓ Agent: ${label}\nDirectory: ${channel?.cwd ?? options.cwd}\nSession: ${restored ?? "New session (send a message or use /list)"}`,
      });
    },
    enqueueReply,
  });

  /** 从已保存答案生成选中提示，提交、关闭和迟到回执都保留用户的选择。 */
  function formatInteractionMessage(
    interaction: State["interactions"][number],
    message: State["interactions"][number]["messages"][number],
    reason: string,
  ) {
    const answer = interaction.questions[message.questionIndex ?? -1]?.answer;
    let text = message.text;
    if (answer) {
      /** 仅限制展示长度，为原问题正文留出空间；实际提交的答案保持完整。 */
      const preview = [...answer].slice(0, 1000).join("");
      text += `\n\nSelected: ${preview}${preview.length < answer.length ? "…" : ""}`;
    }
    return `${text}\n\n${reason}`;
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
        enqueueReply(task.channelId, formatInteractionMessage(interaction, message, reason), {
          interactionId: id,
          messageId: message.messageId,
          ...(message.questionIndex !== undefined ? { questionIndex: message.questionIndex } : {}),
        });
      }
    });
  }

  /** 终态与最终回复一起保存；定时结果标注来源，迟到事件不能覆盖已完成结果。 */
  function finishTask(id: number, result: AgentResult) {
    if (!state.tasks.some((task) => task.id === id && activeTaskStatuses.has(task.status))) return;
    update(() => {
      const task = state.tasks.find((task) => task.id === id);
      if (!task) throw new Error("Task not found.");
      Object.assign(task, { status: result.status, result: result.text });
      for (const interaction of state.interactions.filter((item) => item.taskId === id))
        closeInteraction(interaction.id, "Task ended. Request closed.");
      const messages = result.messages?.length ? result.messages : [{ text: result.text }];
      for (const [index, message] of messages.entries())
        enqueueReply(
          task.channelId,
          `${
            result.status !== "completed" && index === messages.length - 1
              ? `Task #${id} ${
                  {
                    failed: "Failed",
                    cancelled: "Stopped",
                    interrupted: "Unconfirmed",
                  }[result.status]
                }\n`
              : ""
          }${message.text}`,
          {
            taskId: id,
            segmentId: message.id,
            messageId: task.previewMessages.find((preview) => preview.segmentId === message.id)
              ?.messageId,
            markdown: true,
            priority: false,
            attachments: index === messages.length - 1 ? (result.attachments ?? []) : [],
          },
        );
      for (const [index, input] of task.inputs.entries()) {
        if (!["pending", "preparing", "sending"].includes(input.status)) continue;
        enqueueReply(
          task.channelId,
          `Task #${id}, message ${index + 1}: ${input.status === "sending" ? "delivery unconfirmed" : "not sent"}. Task ended; not retried. Check the session before resending.`,
        );
        input.status = "failed";
      }
    });
    drafts.delete(id);
  }

  /** 先使交互失效，再由核心层请求中断。 */
  function cancelTask(id: number) {
    if (
      ["queued", "preparing"].includes(state.tasks.find((task) => task.id === id)?.status ?? "")
    ) {
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
        return [
          "interaction",
          "permissions",
          "model",
          "agent",
          "session",
          "sessionPage",
          "cwd",
          "cwdPage",
        ].includes(message.content.type)
          ? "Already handled."
          : undefined;
      return update(() => {
        let channel = state.channels.find((channel) => channel.id === existing?.id);
        if (!channel) {
          channel = {
            ...message.channel,
            id: state.channels.reduce((max, item) => Math.max(max, item.id), 0) + 1,
            /** 创建聊天时固定服务启动目录，后续命令直接使用已保存的路径。 */
            cwd: options.cwd,
            agent: defaultAgent,
            agentStates: {},
            agentMenu: null,
            sessionId: null,
            sessionGeneration: 0,
            sessionMenu: null,
            cwdMenu: null,
            replyRetryAt: 0,
            permissionMode: null,
            permissionMenu: null,
            model: null,
            reasoningEffort: null,
            modelMenu: null,
          };
          state.channels.push(channel);
        }
        channel.userId = message.channel.userId;
        state.inboundUpdates.push({
          channelId: channel.id,
          eventId: message.eventId,
        });
        const reply = handle(channel);
        if (
          ![
            "interaction",
            "permissions",
            "model",
            "agent",
            "session",
            "sessionPage",
            "cwd",
            "cwdPage",
          ].includes(message.content.type)
        )
          enqueueReply(channel.id, reply);
        return reply;
      });
    },
    /** 独立只读查询完成后保存回复；写入失败交给工作循环触发关停。 */
    reply(
      channelId: number,
      text: string,
      delivery: Pick<State["outbox"][number], "markdown"> = {},
    ) {
      update(() => {
        if (state.channels.some((channel) => channel.id === channelId))
          enqueueReply(channelId, text, delivery);
      });
    },
    /** 运行时通知附带任务来源，查询最新绑定以免使用派发前的空会话。 */
    replyTask(id: number, text: string) {
      update(() => {
        const task = state.tasks.find((item) => item.id === id);
        if (task) enqueueReply(task.channelId, `${taskHeading(task, agentLabel)}\n\n${text}`);
      });
    },
    /** 只回收指定来源已确认的事件；确认规则由连接器提供，不解释事件编号。 */
    confirmUpdates(
      source: Pick<ChannelIdentity, "platform" | "accountId">,
      confirmed: (eventId: string) => boolean,
    ) {
      const pending = state.inboundUpdates.filter((item) => {
        const channel = state.channels.find((channel) => channel.id === item.channelId);
        return (
          channel?.platform !== source.platform ||
          channel.accountId !== source.accountId ||
          !confirmed(item.eventId)
        );
      });
      if (pending.length !== state.inboundUpdates.length)
        update(() => {
          state.inboundUpdates = pending;
        });
    },
    setAgent,
    /** 新会话或目录变化只影响后续任务，已保存任务仍使用自己的快照。 */
    setSession(channelId: number, cwd: string, sessionId: string | null, reply?: string) {
      update(() => {
        const channel = state.channels.find((channel) => channel.id === channelId);
        if (channel) {
          if (cwd !== channel.cwd || sessionId !== channel.sessionId)
            channel.sessionGeneration += 1;
          closeMenu(channelId, "agentMenu");
          closeMenu(channelId, "permissionMenu");
          closeMenu(channelId, "modelMenu");
          closeMenu(channelId, "sessionMenu");
          closeMenu(channelId, "cwdMenu");
          if (cwd !== channel.cwd) {
            channel.permissionMode = null;
            channel.model = null;
            channel.reasoningEffort = null;
          }
          Object.assign(channel, { cwd, sessionId });
          /** 会话选择与成功回复一同落盘。 */
          if (reply) enqueueReply(channelId, reply);
        }
      });
    },
    ...menus,
    ...crons,
    activeTasks,
    /** 普通输入和控制命令固定当前选择，不能误操作同一聊天的其他任务。 */
    sessionTask(channelId: number) {
      const channel = state.channels.find((item) => item.id === channelId);
      return channel && activeTasks().find((task) => matchesSession(task, channel));
    },
    /** 内存保留 Agent 分段的最新正文，收到追加输入本身不改变消息边界。 */
    setDraft(id: number, messages: AgentMessage[]) {
      if (state.tasks.some((task) => task.id === id && task.status === "running"))
        drafts.set(id, messages);
    },
    /** 仅向当前机器人与授权用户返回执行中的预览，停止后不再刷新。 */
    pendingDrafts(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
      return activeTasks(source).flatMap((task) => {
        const messages = drafts.get(task.id);
        if (task.status !== "running" || !messages?.length) return [];
        /** 选择题独立等待答案，不屏蔽 Agent 已产生的后续输出。 */
        if (
          task.interactions.some(
            (item) => item.kind === "approval" && item.blocking && item.status !== "closed",
          )
        )
          return [];
        const channel = state.channels.find((channel) => channel.id === task.channelId);
        if (!channel) return [];
        return [
          {
            taskId: task.id,
            chatId: channel.chatId,
            messages: messages.map((message) => ({
              ...message,
              text: message.text.trim()
                ? `${taskHeading(task, agentLabel)}\n\n${message.text}`
                : "",
              messageId: task.previewMessages.find((preview) => preview.segmentId === message.id)
                ?.messageId,
            })),
          },
        ];
      });
    },
    /** 回执按 Agent 分段关联；慢发送不能把新输入对应的结果接到旧消息上。 */
    recordPreview(id: number, messageId: number, segmentId?: string) {
      if (!segmentId) return;
      update(() => {
        const task = state.tasks.find((item) => item.id === id);
        if (task && !task.previewMessages.some((preview) => preview.segmentId === segmentId))
          task.previewMessages.push({ segmentId, messageId });
        const reply = state.outbox.find(
          (item) => item.taskId === id && item.segmentId === segmentId && !item.attachment,
        );
        if (reply) reply.messageId = messageId;
      });
    },
    createTask,
    /** 尚未派发时合并首条输入；执行中的补充输入与入站去重标识一起保存。 */
    appendTaskInput(id: number, text: string, attachments: Attachment[] = []) {
      update(() => {
        const task = state.tasks.find((task) => task.id === id);
        if (!task || !["queued", "preparing", "dispatching", "running"].includes(task.status))
          throw new Error("Task cannot accept more input.");
        if (task.status === "queued") {
          task.prompt += `\n\n${text}`;
          task.attachments.push(...attachments);
        } else task.inputs.push({ text, attachments, status: "pending" });
      });
    },
    /** 按接收顺序准备附件；下载阶段尚未提交给 Agent，可以在重启后继续。 */
    claimTaskInput(id: number) {
      const task = state.tasks.find((task) => task.id === id && task.status === "running");
      const index = task?.inputs.findIndex((input) => input.status === "pending") ?? -1;
      if (!task || index < 0) return;
      return update(() => {
        const input = state.tasks.find((task) => task.id === id)?.inputs[index];
        if (!input) throw new Error("Input not found.");
        input.status = "preparing";
        return { index, text: input.text, attachments: input.attachments };
      });
    },
    /** 附件准备完成后再次核实任务仍在执行，先保存 sending 再提交，避免误入其他轮次。 */
    markTaskInputSending(id: number, index: number) {
      const task = state.tasks.find((task) => task.id === id && task.status === "running");
      if (task?.inputs[index]?.status !== "preparing") return false;
      return update(() => {
        const input = state.tasks.find((task) => task.id === id)?.inputs[index];
        if (!input) return false;
        input.status = "sending";
        return true;
      });
    },
    /** 成功补充不产生固定回执，失败提示和输入状态原子保存。 */
    finishTaskInput(id: number, index: number, error?: string) {
      update(() => {
        const task = state.tasks.find((task) => task.id === id);
        const input = task?.inputs[index];
        if (!task || !input || !["preparing", "sending"].includes(input.status)) return;
        input.status = error === undefined ? "accepted" : "failed";
        if (error !== undefined)
          enqueueReply(task.channelId, `Task #${id}, message ${index + 1}: ${error}`);
      });
    },
    /** 领取新任务或已保存轮次；恢复只连接后台，不能重发原始输入。 */
    claimTask(
      source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">,
      claimedIds: ReadonlySet<number>,
    ) {
      const index = state.tasks.findIndex(
        (task) =>
          activeTaskStatuses.has(task.status) &&
          !claimedIds.has(task.id) &&
          state.channels.some(
            (channel) =>
              channel.id === task.channelId &&
              channel.platform === source.platform &&
              channel.accountId === source.accountId &&
              channel.userId === source.userId,
          ),
      );
      const task = state.tasks[index];
      if (!task) return;
      return update(() => {
        const claimed = {
          ...task,
          status:
            task.status === "cancelling"
              ? ("cancelling" as const)
              : !task.runId && task.attachments.length
                ? ("preparing" as const)
                : ("dispatching" as const),
        };
        state.tasks[index] = claimed;
        return claimed;
      });
    },
    /** 下载完成后才进入可能派发的阶段；已停止的任务不能因下载迟到而启动。 */
    markDispatching(id: number) {
      if (!state.tasks.some((task) => task.id === id && task.status === "preparing")) return false;
      return update(() => {
        const task = state.tasks.find((task) => task.id === id);
        if (!task) return false;
        task.status = "dispatching";
        return true;
      });
    },
    /** 记录任务会话；仅同步仍指向该任务的手动选择，迟到回调不覆盖新选择。 */
    recordSession(id: number, sessionId: string) {
      update(() => {
        const task = state.tasks.find(
          (task) => task.id === id && activeTaskStatuses.has(task.status),
        );
        if (!task) return;
        const channel = state.channels.find((channel) => channel.id === task.channelId);
        if (channel && !task.cron && matchesSession(task, channel)) channel.sessionId = sessionId;
        task.sessionId = sessionId;
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
            `${taskHeading(task, agentLabel)}\n\nApproval\n${request.text}\n\nChoose below.`,
            { interactionId: request.id },
          );
        } else {
          for (const [index, question] of request.questions.entries())
            enqueueReply(
              task.channelId,
              `${taskHeading(task, agentLabel)}\n\nQuestion ${index + 1}/${request.questions.length}\n${question.header}\n${question.question}${question.options.map((option, i) => `\n\n${i + 1}. ${option.label}\n${option.description}`).join("")}\n\n${question.allowText ? "Pick an option or reply to this message." : "Pick an option or reply with its number or label."}\nAnswer all questions to submit.`,
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
        (interaction.expiresAt !== null && interaction.expiresAt <= Date.now())
      )
        return "Request closed. Check /status.";
      if (interaction.kind === "approval") {
        if (
          content.type !== "interaction" ||
          content.action !== "approval" ||
          !Number.isInteger(content.optionIndex)
        )
          return "Use the approval buttons.";
        const choice = interaction.choices[content.optionIndex ?? -1];
        if (!choice) return "Invalid approval option.";
        update(() => {
          const current = state.interactions.find((item) => item.id === interaction.id);
          if (!current) return;
          current.decision = choice.id;
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
          item.taskId === taskId &&
          item.status === "ready" &&
          (item.expiresAt === null || item.expiresAt > Date.now()),
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
      /** 通道先前选中的 Agent 若已从配置中移除，切回默认 Agent 并保留旧快照。 */
      for (const channel of [...state.channels]) {
        if (!availableAgents.has(channel.agent)) {
          setAgent(channel.id, defaultAgent);
        }
      }
      if (
        state.channels.some(
          (channel) =>
            channel.agentMenu ||
            channel.permissionMenu ||
            channel.modelMenu ||
            channel.sessionMenu ||
            channel.cwdMenu,
        )
      )
        update(() => {
          for (const channel of state.channels) {
            closeMenu(channel.id, "agentMenu");
            closeMenu(channel.id, "permissionMenu");
            closeMenu(channel.id, "modelMenu");
            closeMenu(channel.id, "sessionMenu");
            closeMenu(channel.id, "cwdMenu");
          }
        });
      for (const task of state.tasks.filter(
        (task) => activeTaskStatuses.has(task.status) && task.status !== "queued",
      )) {
        /** 下载阶段从未提交给 Agent；主输入和补充输入都可以安全重新准备。 */
        if (
          task.status === "preparing" ||
          task.inputs.some((input) => input.status === "preparing")
        )
          update(() => {
            const current = state.tasks.find((item) => item.id === task.id);
            if (!current) return;
            if (current.status === "preparing") current.status = "queued";
            for (const input of current.inputs)
              if (input.status === "preparing") input.status = "pending";
          });
        if (task.status === "preparing") continue;
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
          text: "Service restarted; task result unknown. Check the project before sending a new task.",
        });
      }
      for (const interaction of state.interactions)
        closeInteraction(interaction.id, "Service restarted. Request closed.");
    },
    replyRetryAt,
    /** 控制回复独立于普通输出领取；同类保序，跨类仍遵守附件和编辑的依赖。 */
    claimReply(
      source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">,
      kind: "priority" | "text" | "attachment" = "text",
    ) {
      if (
        replyRetryAt(source) > Date.now() ||
        [...delivering.values()].some(
          (reply) =>
            Boolean(reply.attachment) === (kind === "attachment") &&
            reply.priority === (kind === "priority"),
        )
      )
        return;
      for (const channel of state.channels) {
        if (channel.agentMenu && channel.agentMenu.expiresAt <= Date.now())
          update(() => closeMenu(channel.id, "agentMenu"));
        if (channel.permissionMenu && channel.permissionMenu.expiresAt <= Date.now())
          update(() => closeMenu(channel.id, "permissionMenu"));
        if (channel.modelMenu && channel.modelMenu.expiresAt <= Date.now())
          update(() => closeMenu(channel.id, "modelMenu"));
        if (channel.sessionMenu && channel.sessionMenu.expiresAt <= Date.now())
          update(() => closeMenu(channel.id, "sessionMenu"));
        if (channel.cwdMenu && channel.cwdMenu.expiresAt <= Date.now())
          update(() => closeMenu(channel.id, "cwdMenu"));
      }
      for (const reply of state.outbox) {
        if (reply.priority !== (kind === "priority")) continue;
        const interaction = state.interactions.find((item) => item.id === reply.interactionId);
        if (
          reply.interactionId &&
          !reply.messageId &&
          (interaction?.status !== "pending" ||
            (interaction.expiresAt !== null && interaction.expiresAt <= Date.now()) ||
            (reply.questionIndex !== undefined &&
              interaction.questions[reply.questionIndex]?.answer !== null))
        )
          continue;
        const channel = state.channels.find((channel) => channel.id === reply.channelId);
        if (
          channel?.platform === source.platform &&
          channel.accountId === source.accountId &&
          channel.userId === source.userId
        ) {
          if (
            reply.retryAt > Date.now() ||
            Boolean(reply.attachment) !== (kind === "attachment") ||
            (reply.afterId !== undefined &&
              (delivering.has(reply.afterId) ||
                state.outbox.some((item) => item.id === reply.afterId))) ||
            (reply.messageId !== undefined &&
              state.outbox.some(
                (item) =>
                  item.id < reply.id &&
                  item.channelId === reply.channelId &&
                  item.messageId === reply.messageId,
              ))
          ) {
            if (kind !== "priority") return;
            continue;
          }
          delivering.set(reply.id, structuredClone(reply));
          return structuredClone({
            ...reply,
            chatId: channel.chatId,
            interaction,
            permissionMenu:
              channel.permissionMenu?.id === reply.permissionMenuId
                ? channel.permissionMenu
                : undefined,
            modelMenu: channel.modelMenu?.id === reply.modelMenuId ? channel.modelMenu : undefined,
            agentMenu: channel.agentMenu?.id === reply.agentMenuId ? channel.agentMenu : undefined,
            sessionMenu:
              channel.sessionMenu?.id === reply.sessionMenuId ? channel.sessionMenu : undefined,
            cwdMenu: channel.cwdMenu?.id === reply.cwdMenuId ? channel.cwdMenu : undefined,
          });
        }
      }
    },
    /** 发送成功或永久拒绝后移出队列；原生历史由 Agent 查询，不依赖出站记录。 */
    removeReply(
      id: number,
      delivery?: {
        messageId: number;
        text: string;
        interactionId?: string;
        questionIndex?: number;
        permissionMenuId?: string;
        modelMenuId?: string;
        agentMenuId?: string;
        sessionMenuId?: string;
        cwdMenuId?: string;
      },
    ) {
      update(() => {
        const channelId =
          delivering.get(id)?.channelId ?? state.outbox.find((reply) => reply.id === id)?.channelId;
        delivering.delete(id);
        state.outbox = state.outbox.filter((reply) => reply.id !== id);
        if (
          (delivery?.permissionMenuId ||
            delivery?.modelMenuId ||
            delivery?.agentMenuId ||
            delivery?.sessionMenuId ||
            delivery?.cwdMenuId) &&
          channelId !== undefined
        ) {
          const channel = state.channels.find((item) => item.id === channelId);
          const menu = delivery.cwdMenuId
            ? channel?.cwdMenu
            : delivery.sessionMenuId
              ? channel?.sessionMenu
              : delivery.agentMenuId
                ? channel?.agentMenu
                : delivery.modelMenuId
                  ? channel?.modelMenu
                  : channel?.permissionMenu;
          if (
            menu &&
            menu.id ===
              (delivery.cwdMenuId ??
                delivery.sessionMenuId ??
                delivery.agentMenuId ??
                delivery.modelMenuId ??
                delivery.permissionMenuId) &&
            menu.expiresAt > Date.now()
          ) {
            if (!menu.messages.some((message) => message.messageId === delivery.messageId))
              menu.messages.push({
                messageId: delivery.messageId,
                text: delivery.text,
              });
          } else if (
            /** 迟到的编辑回执不能再排入旧正文，覆盖已保存的新阶段或最终确认。 */
            !state.outbox.some(
              (reply) => reply.channelId === channelId && reply.messageId === delivery.messageId,
            )
          )
            enqueueReply(channelId, delivery.text, { messageId: delivery.messageId });
        }
        const interaction = state.interactions.find((item) => item.id === delivery?.interactionId);
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
            (interaction.expiresAt !== null && interaction.expiresAt <= Date.now()) ||
            (delivery.questionIndex !== undefined &&
              interaction.questions[delivery.questionIndex]?.answer !== null)
          )
            enqueueReply(
              task.channelId,
              formatInteractionMessage(
                interaction,
                delivery,
                interaction.resolution ?? "Request closed.",
              ),
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
    /** 普通失败仅重试当前回复；平台限流同时暂停账号内的其他投递。 */
    retryReply(id: number, seconds: number, retryAll = false) {
      update(() => {
        const reply = state.outbox.find((reply) => reply.id === id);
        const channel = retryAll
          ? state.channels.find(
              (channel) => channel.id === (reply?.channelId ?? delivering.get(id)?.channelId),
            )
          : undefined;
        delivering.delete(id);
        if (reply)
          Object.assign(reply, {
            attempts: reply.attempts + 1,
            retryAt: Date.now() + seconds * 1000,
          });
        if (channel)
          channel.replyRetryAt = Math.max(channel.replyRetryAt, Date.now() + seconds * 1_000);
      });
    },
  };
}

/** 核心层共享业务操作；连接器只依赖消息投递需要的子集。 */
export type CoreState = ReturnType<typeof createState>;
