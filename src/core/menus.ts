import type { State } from "./schema.js";
import type {
  AgentModel,
  AgentOption,
  AgentSessionPage,
  ChannelIdentity,
  IncomingMessage,
} from "./types.js";

/** 菜单规则共用业务事务与回复入队；不直接读写文件或调用 IM。 */
export function createMenus(context: {
  read: () => Pick<State, "channels" | "outbox">;
  update: <T>(action: () => T) => T;
  enqueueReply: (
    channelId: number,
    text: string,
    delivery?: Pick<
      State["outbox"][number],
      "messageId" | "permissionMenuId" | "modelMenuId" | "sessionMenuId"
    >,
  ) => void;
}) {
  /** 清理旧按钮；正在原地更新的消息保留，由下一阶段或确认结果替换。 */
  function closeMenu(
    channelId: number,
    key: "permissionMenu" | "modelMenu" | "sessionMenu",
    keepMessageId?: number,
  ) {
    const state = context.read();
    const channel = state.channels.find((item) => item.id === channelId);
    const menu = channel?.[key];
    if (!channel || !menu) return;
    context.read().outbox = context
      .read()
      .outbox.filter(
        (reply) =>
          reply.permissionMenuId !== menu.id &&
          reply.modelMenuId !== menu.id &&
          reply.sessionMenuId !== menu.id,
      );
    for (const message of menu.messages)
      if (message.messageId !== keepMessageId)
        context.enqueueReply(channelId, message.text, { messageId: message.messageId });
    channel[key] = null;
  }

  return {
    closeMenu,
    /** 每次 /list 重新读取首页，旧列表和尚未完成的查询同时失效。 */
    openSessions(channelId: number) {
      return context.update(() => {
        const channel = context.read().channels.find((item) => item.id === channelId);
        if (!channel) return;
        closeMenu(channelId, "sessionMenu");
        channel.sessionMenu = {
          id: crypto.randomUUID(),
          expiresAt: Date.now() + 600_000,
          options: [],
          messages: [],
          page: 0,
          cursors: [null],
          loading: true,
        };
        return { channelId, cwd: channel.cwd, id: channel.sessionMenu.id, page: 0, cursor: null };
      });
    },
    /** 一次只接收相邻页请求；重复点击和伪造的菜单、消息或页码不会触发查询。 */
    turnSessionPage(
      channelId: number,
      content: Extract<IncomingMessage["content"], { type: "sessionPage" }>,
    ) {
      const channel = context.read().channels.find((item) => item.id === channelId);
      const menu = channel?.sessionMenu;
      if (
        !menu ||
        menu.id !== content.id ||
        menu.expiresAt <= Date.now() ||
        !menu.messages.some((message) => message.messageId === content.messageId)
      )
        return "List expired. Open /list again.";
      if (menu.loading) return "Loading sessions. Please wait.";
      const cursor = menu.cursors[content.page];
      if (
        !Number.isInteger(content.page) ||
        Math.abs(content.page - menu.page) !== 1 ||
        cursor === undefined
      )
        return "Invalid session page. Open /list again.";
      return context.update(() => {
        const current = context.read().channels.find((item) => item.id === channelId);
        if (!current?.sessionMenu) return;
        current.sessionMenu.loading = true;
        return { channelId, cwd: current.cwd, id: menu.id, page: content.page, cursor };
      });
    },
    /** 查询成功后才替换原页；菜单失效时丢弃迟到结果，失败时允许重试当前按钮。 */
    fillSessions(
      channelId: number,
      id: string,
      page: number,
      result: AgentSessionPage | undefined,
      error?: string,
    ) {
      const menu = context.read().channels.find((item) => item.id === channelId)?.sessionMenu;
      if (menu?.id !== id || !menu.loading || menu.expiresAt <= Date.now()) return;
      context.update(() => {
        const channel = context.read().channels.find((item) => item.id === channelId);
        const current = channel?.sessionMenu;
        if (!current) return;
        current.loading = false;
        if (!result) {
          if (!current.messages.length) closeMenu(channelId, "sessionMenu");
          context.enqueueReply(channelId, error ?? "Cannot load sessions. Try /list again.");
          return;
        }
        if (page === 0 && !result.sessions.length) {
          closeMenu(channelId, "sessionMenu");
          context.enqueueReply(channelId, "No sessions yet. Create one with /new [name].");
          return;
        }
        current.page = page;
        current.options = result.sessions.map((session) => ({
          ...session,
          label: `${session.id === channel.sessionId ? "✓ " : ""}${session.label}`,
        }));
        /** 后退后重新沿最新游标向前读取，避免使用已失效的后续页边界。 */
        current.cursors = current.cursors.slice(0, page + 1);
        if (result.nextCursor) current.cursors.push(result.nextCursor);
        const text = `Sessions · Page ${page + 1}\n${result.sessions.length ? "Tap a session to switch." : "No sessions on this page. Go back or refresh with /list."}`;
        const message = current.messages[0];
        if (message) message.text = text;
        context.enqueueReply(channelId, text, {
          sessionMenuId: id,
          ...(message ? { messageId: message.messageId } : {}),
        });
      });
    },
    /** 权限直接展示；模型菜单先保存查询意图，由独立循环补齐选项。 */
    openMenu(channelId: number, kind: "permissions" | "model", modes: readonly AgentOption[] = []) {
      context.update(() => {
        const channel = context.read().channels.find((item) => item.id === channelId);
        if (!channel) return;
        const key = kind === "permissions" ? "permissionMenu" : "modelMenu";
        closeMenu(channelId, key);
        const menu = {
          id: crypto.randomUUID(),
          expiresAt: Date.now() + 600_000,
          options: modes.map(({ id, label }) => ({ id, label })),
          messages: [],
        };
        if (kind === "model") {
          channel.modelMenu = { ...menu, stage: "loading", options: [] };
          return;
        }
        channel.permissionMenu = menu;
        context.enqueueReply(
          channelId,
          `Permissions\nCurrent selection: ${modes.find((mode) => mode.id === channel.permissionMode)?.label ?? channel.permissionMode ?? modes[0]?.label ?? "Not set"}\n\n${modes.map((mode, index) => `${index + 1}. ${mode.label}`).join("\n")}\n\nApplies to future tasks. The current task keeps its permissions. Modes are subject to local configuration.`,
          { permissionMenuId: menu.id },
        );
      });
    },
    /** 只读取本实例处于 loading 阶段的菜单，模型与推理选择不会重复查询。 */
    pendingModels(source: Pick<ChannelIdentity, "platform" | "accountId" | "userId">) {
      const channel = context
        .read()
        .channels.find(
          (channel) =>
            channel.platform === source.platform &&
            channel.accountId === source.accountId &&
            channel.userId === source.userId &&
            channel.modelMenu?.stage === "loading" &&
            channel.modelMenu.expiresAt > Date.now(),
        );
      if (channel?.modelMenu)
        return {
          channelId: channel.id,
          cwd: channel.cwd,
          id: channel.modelMenu.id,
          model: channel.model,
          reasoningEffort: channel.reasoningEffort,
        };
    },
    /** 新菜单、换目录和过期后丢弃旧查询；失败时保留原模型选择。 */
    fillModels(
      channelId: number,
      id: string,
      models: readonly AgentModel[] | undefined,
      current: (AgentOption & { reasoningEffort: string }) | undefined,
    ) {
      const menu = context.read().channels.find((channel) => channel.id === channelId)?.modelMenu;
      if (menu?.id !== id || menu.stage !== "loading" || menu.expiresAt <= Date.now()) return;
      context.update(() => {
        const channel = context.read().channels.find((channel) => channel.id === channelId);
        if (!channel?.modelMenu) return;
        closeMenu(channelId, "modelMenu");
        /** 有效配置只用于展示；查询失败时仅回退到完整的手动选择。 */
        const text = current
          ? `Current: ${current.label} · ${current.reasoningEffort}`
          : channel.model && channel.reasoningEffort
            ? `Current: ${models?.find((model) => model.id === channel.model)?.label ?? channel.model} · ${channel.reasoningEffort}`
            : "Current: Unavailable (try /model again)";
        if (!models?.length) {
          context.enqueueReply(
            channelId,
            `${text}\n${
              models
                ? "No models available. Check agent settings."
                : "Could not load models. Try /model again."
            }`,
          );
          return;
        }
        channel.modelMenu = { ...menu, stage: "model", options: [...models], messages: [] };
        context.enqueueReply(channelId, text, { modelMenuId: id });
      });
    },
    /** 校验聊天、原消息、菜单和有效期；选择不改变已提交任务的快照。 */
    chooseOption(
      channelId: number,
      content: Extract<IncomingMessage["content"], { type: "permissions" | "model" }>,
    ) {
      const channel = context.read().channels.find((item) => item.id === channelId);
      const key = content.type === "permissions" ? "permissionMenu" : "modelMenu";
      const menu = channel?.[key];
      if (
        !menu ||
        menu.id !== content.id ||
        menu.expiresAt <= Date.now() ||
        !menu.messages.some((message) => message.messageId === content.messageId)
      )
        return `Menu expired. Open /${content.type} again.`;
      const option = menu.options[content.optionIndex];
      if (!option)
        return content.type === "permissions"
          ? "Invalid permission option."
          : "Invalid model option.";
      return context.update(() => {
        const current = context.read().channels.find((item) => item.id === channelId);
        if (!current) return;
        if (content.type === "permissions") current.permissionMode = option.id;
        else {
          const model =
            current.modelMenu?.stage === "model"
              ? current.modelMenu.options[content.optionIndex]
              : undefined;
          if (model?.reasoningEfforts.length) {
            /** 第二步更换菜单 ID，旧模型按钮不能被当作推理档位重复提交。 */
            closeMenu(channelId, key, content.messageId);
            const text = `Model: ${model.label}\nChoose reasoning`;
            current.modelMenu = {
              stage: "reasoning",
              id: crypto.randomUUID(),
              expiresAt: menu.expiresAt,
              model: { id: model.id, label: model.label },
              options: model.reasoningEfforts.map((effort) => ({
                id: effort.id,
                label: `${effort.id}${effort.id === model.defaultReasoningEffort ? " (default)" : ""}`,
              })),
              /** 原消息已确认归属，编辑回执返回前也能接收新按钮的选择。 */
              messages: [{ messageId: content.messageId, text }],
            };
            context.enqueueReply(channelId, text, {
              messageId: content.messageId,
              modelMenuId: current.modelMenu.id,
            });
            return "Choose reasoning effort.";
          }
          /** 只有选完第二步才一起保存；无推理选项的模型沿用 Agent 配置。 */
          current.model =
            current.modelMenu?.stage === "reasoning" ? current.modelMenu.model.id : option.id;
          current.reasoningEffort = current.modelMenu?.stage === "reasoning" ? option.id : null;
          context.enqueueReply(
            channelId,
            `✓ ${current.modelMenu?.stage === "reasoning" ? current.modelMenu.model.label : option.label} · ${current.reasoningEffort ?? "Default"}`,
            { messageId: content.messageId },
          );
          closeMenu(channelId, key, content.messageId);
          return "Model saved.";
        }
        closeMenu(channelId, key);
        context.enqueueReply(channelId, `Selected: ${option.label}. Applies to the next task.`);
        return "Permission mode saved.";
      });
    },
  };
}
