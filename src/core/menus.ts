import type { State } from "./schema.js";
import type { AgentModel, AgentOption, ChannelIdentity, IncomingMessage } from "./types.js";

/** 菜单规则共用业务事务与回复入队；不直接读写文件或调用 IM。 */
export function createMenus(context: {
  read: () => Pick<State, "channels" | "outbox">;
  update: <T>(action: () => T) => T;
  enqueueReply: (
    channelId: number,
    text: string,
    delivery?: Pick<State["outbox"][number], "messageId" | "permissionMenuId" | "modelMenuId">,
  ) => void;
}) {
  /** 清理旧按钮；正在原地更新的消息保留，由下一阶段或确认结果替换。 */
  function closeMenu(
    channelId: number,
    key: "permissionMenu" | "modelMenu",
    keepMessageId?: number,
  ) {
    const state = context.read();
    const channel = state.channels.find((item) => item.id === channelId);
    const menu = channel?.[key];
    if (!channel || !menu) return;
    context.read().outbox = context
      .read()
      .outbox.filter(
        (reply) => reply.permissionMenuId !== menu.id && reply.modelMenuId !== menu.id,
      );
    for (const message of menu.messages)
      if (message.messageId !== keepMessageId)
        context.enqueueReply(channelId, message.text, { messageId: message.messageId });
    channel[key] = null;
  }

  return {
    closeMenu,
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
        return { channelId: channel.id, cwd: channel.cwd, id: channel.modelMenu.id };
    },
    /** 新菜单、换目录和过期后丢弃旧查询；失败时保留原模型选择。 */
    fillModels(channelId: number, id: string, models: readonly AgentModel[] | undefined) {
      const menu = context.read().channels.find((channel) => channel.id === channelId)?.modelMenu;
      if (menu?.id !== id || menu.stage !== "loading" || menu.expiresAt <= Date.now()) return;
      context.update(() => {
        const channel = context.read().channels.find((channel) => channel.id === channelId);
        if (!channel?.modelMenu) return;
        closeMenu(channelId, "modelMenu");
        if (!models?.length) {
          context.enqueueReply(
            channelId,
            `Current: ${channel.model ?? "Default"} · ${channel.reasoningEffort ?? "Default"}\n${
              models
                ? "No models available. Check agent settings."
                : "Could not load models. Try /model again."
            }`,
          );
          return;
        }
        channel.modelMenu = { ...menu, stage: "model", options: [...models], messages: [] };
        context.enqueueReply(
          channelId,
          `Current: ${models.find((model) => model.id === channel.model)?.label ?? channel.model ?? "Default"} · ${channel.reasoningEffort ?? "Default"}`,
          { modelMenuId: id },
        );
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
