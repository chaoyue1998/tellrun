import { Agent } from "node:https";
import { setTimeout } from "node:timers/promises";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, BotError, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { MessageHandler } from "../core/types.js";
import type { Store } from "../storage/store.js";

/** 默认菜单和控制命令识别共用定义，菜单说明统一使用英文。 */
const commands = [
  { command: "start", description: "Show usage instructions" },
  { command: "help", description: "Show available commands" },
  { command: "cwd", description: "Show or change the working directory" },
  { command: "new", description: "Start a new conversation" },
  { command: "model", description: "Select model and reasoning effort for future tasks" },
  { command: "permissions", description: "Select the permission mode for future tasks" },
  { command: "status", description: "Show session and task status" },
  { command: "last", description: "Show the latest task result" },
  { command: "stop", description: "Stop the current task and pause" },
  { command: "resume", description: "Accept new tasks" },
];

/** Telegram 连接器负责鉴权、消息转换与发送，业务逻辑交给统一处理入口。 */
export function createTelegramConnection(
  config: Config["telegram"],
  handleMessage: MessageHandler,
  store: Store,
  logger: Logger,
) {
  /** 默认继承终端代理；显式配置使用优先级更高的小写变量，保留 NO_PROXY 规则。 */
  const agent = new Agent({
    keepAlive: true,
    proxyEnv:
      config.proxyUrl === undefined
        ? process.env
        : config.proxyUrl
          ? { ...process.env, https_proxy: config.proxyUrl }
          : {},
  });
  const bot = new Bot(config.token, {
    client: { timeoutSeconds: 35, baseFetchConfig: { agent } },
  });
  /** 中断初始化、拉取和输入提示；正在处理的消息由 start 等待完成。 */
  const polling = new AbortController();
  let started = false;
  /** 输入提示与流式草稿只发送最新状态，避免自动重发已过期的内容。 */
  bot.api.config.use((prev, method, payload, signal) =>
    ["sendChatAction", "sendMessageDraft", "answerCallbackQuery"].includes(method)
      ? prev(method, payload, signal)
      : autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5, rethrowHttpErrors: true })(
          prev,
          method,
          payload,
          signal,
        ),
  );
  /** 超时覆盖整次调用及重试；grammY 的旧 signal 类型与 Node 原生接口兼容。 */
  bot.api.config.use((prev, method, payload, signal) =>
    prev(
      method,
      payload,
      signal ??
        (AbortSignal.any([
          AbortSignal.timeout(
            method === "getUpdates"
              ? 40_000
              : ["sendChatAction", "sendMessageDraft", "answerCallbackQuery"].includes(method)
                ? 4_000
                : 15_000,
          ),
          ...([
            "getMe",
            "getWebhookInfo",
            "setMyCommands",
            "setChatMenuButton",
            "getUpdates",
            "sendChatAction",
            "sendMessageDraft",
            "answerCallbackQuery",
          ].includes(method)
            ? [polling.signal]
            : []),
        ]) as Parameters<typeof prev>[2]),
    ),
  );

  /** 身份与私聊范围校验必须先于核心层调用。 */
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === "private" && ctx.from?.id === config.ownerId) {
      await next();
    }
  });

  bot.on("message", async (ctx) => {
    let command =
      ctx.message.text === undefined
        ? undefined
        : ctx.message.entities?.find(
            (entity) => entity.type === "bot_command" && entity.offset === 0,
          );
    const [name, target] = command
      ? (ctx.message.text?.slice(1, command.length).split("@") ?? [])
      : [];
    /** 问题回复可包含绝对路径等斜杠文本；已知控制命令仍优先处理。 */
    if (
      ctx.message.reply_to_message?.from?.id === ctx.me.id &&
      !commands.some((item) => item.command === name)
    )
      command = undefined;
    if (command && target !== undefined && target.toLowerCase() !== ctx.me.username?.toLowerCase())
      return;

    await handleMessage({
      channel: {
        platform: "telegram",
        accountId: String(ctx.me.id),
        chatId: String(ctx.chat.id),
        userId: String(ctx.from.id),
      },
      eventId: String(ctx.update.update_id),
      content: command
        ? {
            type: "command",
            name: name ?? "",
            args: ctx.message.text?.slice(command.length).trim() ?? "",
          }
        : ctx.message.text !== undefined
          ? {
              type: "text",
              text: ctx.message.text,
              ...(ctx.message.reply_to_message?.from?.id === ctx.me.id
                ? { replyToMessageId: ctx.message.reply_to_message.message_id }
                : {}),
            }
          : { type: "unsupported" },
    });
  });

  /** 先保存选择，再关闭客户端等待提示；答复回调失败不能撤销或重发已保存的决定。 */
  bot.on("callback_query:data", async (ctx) => {
    const match = ctx.callbackQuery.data.match(
      /^i:([0-9a-f-]{36}):(accept|decline|stop|q(\d+)_(\d+))$/,
    );
    const selection = ctx.callbackQuery.data.match(/^([pm]):([0-9a-f-]{36}):(\d+)$/);
    let reply = "Button expired.";
    if ((match?.[1] || selection?.[2]) && ctx.chat && ctx.callbackQuery.message) {
      reply =
        (await handleMessage({
          channel: {
            platform: "telegram",
            accountId: String(ctx.me.id),
            chatId: String(ctx.chat.id),
            userId: String(ctx.from.id),
          },
          eventId: String(ctx.update.update_id),
          content: selection?.[2]
            ? {
                type: selection[1] === "p" ? "permissions" : "model",
                id: selection[2],
                optionIndex: Number(selection[3]),
                messageId: ctx.callbackQuery.message.message_id,
              }
            : {
                type: "interaction",
                id: match?.[1] ?? "",
                action:
                  match?.[3] !== undefined
                    ? "option"
                    : (match?.[2] as "accept" | "decline" | "stop"),
                messageId: ctx.callbackQuery.message.message_id,
                ...(match?.[3] !== undefined
                  ? { questionIndex: Number(match[3]), optionIndex: Number(match[4]) }
                  : {}),
              },
        })) ?? "Received.";
    }
    /** 回调提示不占用入站循环，慢网络下 /status 和 /stop 仍能立即处理。 */
    void ctx.answerCallbackQuery({ text: reply }).catch((error: unknown) => {
      logger.warn(
        { errorType: error instanceof Error ? error.name : "UnknownError" },
        "Callback acknowledgement failed; saved choice remains valid",
      );
    });
  });

  /** 原始网络错误可能带 Token，只记录类别和错误码。 */
  function logFailure(error: unknown) {
    let cause = error instanceof BotError ? error.error : error;
    if (cause instanceof HttpError) cause = cause.error;
    logger.error(
      {
        updateId: error instanceof BotError ? error.ctx.update.update_id : undefined,
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        errorCode:
          cause instanceof GrammyError
            ? cause.error_code
            : cause instanceof Error && "code" in cause && typeof cause.code === "string"
              ? cause.code
              : undefined,
      },
      cause instanceof GrammyError && cause.error_code === 409
        ? "Telegram polling conflict. Check other instances or webhook."
        : cause instanceof GrammyError && cause.error_code === 401
          ? "Telegram authentication failed. Check bot token."
          : error instanceof HttpError ||
              (error instanceof BotError && error.error instanceof HttpError)
            ? "Telegram connection failed. Check your network or set telegram.proxyUrl in ~/.tellrun/config.json."
            : "Telegram or storage error. Stopping service.",
    );
  }

  return {
    /** 核实机器人身份后才启动任务，初始化不消费 Telegram 消息。 */
    async initialize() {
      try {
        bot.botInfo = await bot.api.getMe();
        if (polling.signal.aborted) return;
        if ((await bot.api.getWebhookInfo()).url) {
          logger.error("Webhook configured. Remove it before starting long polling.");
          throw new Error("Bot has an active webhook.");
        }
        /** 同步默认与私聊命令，覆盖旧机器人优先级更高的私聊菜单。 */
        await bot.api.setMyCommands(commands);
        await bot.api.setMyCommands(commands, { scope: { type: "all_private_chats" } });
        await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
        if (polling.signal.aborted) return;
        return {
          platform: "telegram",
          accountId: String(bot.botInfo.id),
          userId: String(config.ownerId),
        };
      } catch (error) {
        if (polling.signal.aborted && error instanceof HttpError) return;
        logFailure(error);
        throw error;
      }
    },
    /** 接收、回复与输入提示独立运行，慢请求不会阻塞 /stop 的入站处理。 */
    async start() {
      started = true;
      const workers: Promise<void>[] = [];
      try {
        if (polling.signal.aborted) return;
        logger.info({ botId: bot.botInfo.id }, "Telegram polling started");
        workers.push(
          (async () => {
            /** 只有入站状态保存成功才推进确认位置；重投按已保存的事件标识去重。 */
            let offset = 0;
            while (!polling.signal.aborted) {
              const updates = await bot.api.getUpdates({
                offset,
                timeout: 30,
                allowed_updates: ["message", "callback_query"],
              });
              if (polling.signal.aborted) return;
              store.confirmUpdates(String(bot.botInfo.id), offset, updates.length === 0);
              for (const update of updates) {
                if (polling.signal.aborted) return;
                await bot.handleUpdate(update);
                offset = update.update_id + 1;
              }
            }
          })(),
          (async () => {
            /** 草稿最多每秒更新一次；无新内容时每 20 秒续期，最终回复与草稿串行发送。 */
            let nextDraftAt = 0;
            let sentDraft: { taskId: number; text: string; at: number } | undefined;
            while (!polling.signal.aborted) {
              const reply = store.claimReply(String(bot.botInfo.id), String(config.ownerId));
              if (!reply) {
                const draft = store.pendingDraft(String(bot.botInfo.id), String(config.ownerId));
                if (
                  draft &&
                  Date.now() >= nextDraftAt &&
                  (draft.taskId !== sentDraft?.taskId ||
                    draft.text !== sentDraft.text ||
                    Date.now() - sentDraft.at >= 20_000)
                ) {
                  nextDraftAt = Date.now() + 1000;
                  try {
                    await bot.api.sendMessageDraft(Number(draft.chatId), draft.taskId, draft.text);
                    sentDraft = { ...draft, at: Date.now() };
                  } catch (error) {
                    if (polling.signal.aborted) return;
                    if (!(error instanceof HttpError || error instanceof GrammyError)) throw error;
                    if (error instanceof GrammyError && error.error_code === 401) throw error;
                    nextDraftAt =
                      error instanceof GrammyError &&
                      error.error_code >= 400 &&
                      error.error_code < 500 &&
                      error.error_code !== 429
                        ? Number.POSITIVE_INFINITY
                        : Date.now() +
                          (error instanceof GrammyError ? (error.parameters.retry_after ?? 5) : 5) *
                            1000;
                    logger.warn(
                      {
                        errorType: error.name,
                        errorCode: error instanceof GrammyError ? error.error_code : undefined,
                      },
                      "Telegram preview failed; final reply delivery continues",
                    );
                  }
                }
                await setTimeout(100);
                continue;
              }
              try {
                if (reply.messageId) {
                  await bot.api.editMessageText(reply.chatId, reply.messageId, reply.text, {
                    reply_markup: { inline_keyboard: [] },
                  });
                  store.removeReply(reply.id);
                } else {
                  const interaction = reply.interaction;
                  const menu = reply.permissionMenu ?? reply.modelMenu;
                  const sent = await bot.api.sendMessage(reply.chatId, reply.text, {
                    ...(reply.promptEnd && menu?.options.length && menu.expiresAt > Date.now()
                      ? {
                          reply_markup: {
                            inline_keyboard: menu.options.map((option, index) => [
                              {
                                text: `${index + 1}. ${[...option.label].slice(0, 50).join("")}`,
                                callback_data: `${reply.modelMenu ? "m" : "p"}:${menu.id}:${index}`,
                              },
                            ]),
                          },
                        }
                      : reply.promptEnd &&
                          interaction?.status === "pending" &&
                          interaction.expiresAt > Date.now()
                        ? {
                            reply_markup: {
                              inline_keyboard: [
                                ...(interaction.kind === "approval"
                                  ? interaction.choices.map((choice) => [
                                      {
                                        text: choice === "accept" ? "Allow once" : "Decline",
                                        callback_data: `i:${interaction.id}:${choice}`,
                                      },
                                    ])
                                  : (
                                      interaction.questions[reply.questionIndex ?? -1]?.options ??
                                      []
                                    ).map((option, index) => [
                                      {
                                        text: `${index + 1}. ${[...option.label].slice(0, 50).join("")}`,
                                        callback_data: `i:${interaction.id}:q${reply.questionIndex}_${index}`,
                                      },
                                    ])),
                                [{ text: "Stop", callback_data: `i:${interaction.id}:stop` }],
                              ],
                            },
                          }
                        : {}),
                  });
                  store.removeReply(reply.id, {
                    messageId: sent.message_id,
                    text: reply.text,
                    ...(reply.interactionId ? { interactionId: reply.interactionId } : {}),
                    ...(reply.questionIndex !== undefined
                      ? { questionIndex: reply.questionIndex }
                      : {}),
                    ...(reply.promptEnd && reply.permissionMenuId
                      ? { permissionMenuId: reply.permissionMenuId }
                      : {}),
                    ...(reply.promptEnd && reply.modelMenuId
                      ? { modelMenuId: reply.modelMenuId }
                      : {}),
                  });
                }
                /** 普通消息会清除客户端草稿；任务仍执行时允许再次显示最新内容。 */
                sentDraft = undefined;
              } catch (error) {
                if (!(error instanceof HttpError || error instanceof GrammyError)) throw error;
                if (error instanceof GrammyError && error.error_code === 401) throw error;
                const permanent =
                  error instanceof GrammyError &&
                  error.error_code >= 400 &&
                  error.error_code < 500 &&
                  error.error_code !== 429;
                if (permanent) store.removeReply(reply.id);
                else
                  store.retryReply(
                    reply.id,
                    error instanceof GrammyError && error.parameters.retry_after !== undefined
                      ? error.parameters.retry_after
                      : Math.min(60, 2 ** Math.min(reply.attempts, 6)),
                  );
                logger.warn(
                  { outboxId: reply.id, permanent, errorType: error.name },
                  permanent
                    ? "Telegram rejected reply permanently; removed from queue."
                    : "Telegram reply failed; saved for retry",
                );
              }
            }
          })(),
          (async () => {
            /** 输入提示最多持续 5 秒，每 4 秒刷新；仅当前实例已派发的任务显示。 */
            let nextTypingAt = 0;
            while (!polling.signal.aborted) {
              if (
                Date.now() >= nextTypingAt &&
                ["dispatching", "running"].includes(store.activeTask()?.status ?? "") &&
                !store.activeTask()?.interactions.some((item) => item.blocking)
              ) {
                nextTypingAt = Date.now() + 4_000;
                try {
                  await bot.api.sendChatAction(config.ownerId, "typing");
                } catch (error) {
                  if (polling.signal.aborted) return;
                  if (error instanceof GrammyError && error.parameters.retry_after !== undefined)
                    nextTypingAt = Math.max(
                      nextTypingAt,
                      Date.now() + error.parameters.retry_after * 1_000,
                    );
                  logger.warn(
                    {
                      errorType: error instanceof Error ? error.name : "UnknownError",
                      errorCode: error instanceof GrammyError ? error.error_code : undefined,
                    },
                    "Telegram typing update failed; task continues",
                  );
                }
              }
              await setTimeout(250);
            }
          })(),
        );
        await Promise.all(workers);
      } catch (error) {
        if (
          polling.signal.aborted &&
          error instanceof HttpError &&
          error.error instanceof Error &&
          error.error.name === "AbortError"
        )
          return;
        logFailure(error);
        throw error;
      } finally {
        polling.abort();
        await Promise.allSettled(workers);
        agent.destroy();
        started = false;
      }
    },
    /** 停止拉取，不额外发送确认请求；未确认更新允许在重启后重投。 */
    stop() {
      polling.abort();
      if (!started) agent.destroy();
    },
  };
}
