import { randomInt } from "node:crypto";
import { Agent } from "node:https";
import { setTimeout } from "node:timers/promises";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, BotError, type Context, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { AttachmentError } from "../core/attachments.js";
import type { CoreState } from "../core/state.js";
import type { MessageHandler } from "../core/types.js";
import {
  createTelegramAttachmentLoader,
  sendTelegramAttachment,
  telegramAttachments,
} from "./telegram-files.js";

/** 默认菜单和控制命令识别共用定义，菜单说明统一使用英文。 */
const commands = [
  { command: "start", description: "Show usage instructions" },
  { command: "help", description: "Show available commands" },
  { command: "cwd", description: "Show or change the working directory" },
  { command: "new", description: "Create a new session with an optional name" },
  { command: "list", description: "Show up to 10 recent sessions with switch buttons" },
  { command: "model", description: "Select model and reasoning effort for future tasks" },
  { command: "permissions", description: "Select the permission mode for future tasks" },
  { command: "cron", description: "List, create, enable, disable, or delete scheduled tasks" },
  { command: "status", description: "Show status and check for updates" },
  { command: "update", description: "Ask Codex to upgrade Tellrun" },
  { command: "restart", description: "Restart Tellrun and reload configuration" },
  { command: "last", description: "Show the latest task result" },
  { command: "stop", description: "Stop the current task and pause" },
  { command: "resume", description: "Accept new tasks" },
];

/** 初始化操作可安全重复；与长轮询一起由连接循环负责退避重试。 */
const connectionMethods = new Set([
  "getMe",
  "getWebhookInfo",
  "setMyCommands",
  "setChatMenuButton",
  "getUpdates",
]);
/** 即时提示不重试过期内容，统一使用短超时并随连接关停。 */
const transientMethods = new Set(["sendChatAction", "sendRichMessageDraft", "answerCallbackQuery"]);
/** 文件上传需要更长时限，关停时保留队列供下次发送。 */
const uploadMethods = new Set(["sendPhoto", "sendDocument"]);
/** 普通连接故障最多退避 30 秒；Telegram 的 retry_after 可以要求等待更久。 */
const maxConnectionRetryDelayMs = 30_000;

/** Telegram 连接器负责鉴权、消息转换与发送，业务逻辑交给统一处理入口。 */
export function createTelegramConnection(
  config: Config["telegram"],
  handleMessage: MessageHandler,
  /** 连接器只确认入站、读取投递状态和保存回执，不直接操作任务、审批或菜单。 */
  state: Pick<
    CoreState,
    | "confirmUpdates"
    | "claimReply"
    | "pendingDraft"
    | "removeReply"
    | "retryReply"
    | "replyRetryAt"
    | "reply"
    | "activeTask"
  >,
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
  /** 底层时限覆盖最长的附件上传，具体请求仍受下方分类超时限制。 */
  const bot = new Bot(config.token, {
    client: { timeoutSeconds: 65, baseFetchConfig: { agent } },
  });
  /** 中断初始化、拉取和输入提示；正在处理的消息由 start 等待完成。 */
  const polling = new AbortController();
  let started = false;
  /** 429 同时暂停文字、附件和即时提示；接收更新不受出站限流阻塞。 */
  let retryAfterAt = 0;
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (connectionMethods.has(method)) return prev(method, payload, signal);
    while (Date.now() < retryAfterAt) {
      try {
        await setTimeout(retryAfterAt - Date.now(), undefined, { signal: signal as AbortSignal });
      } catch (error) {
        throw new HttpError("Telegram rate limit wait interrupted.", error);
      }
    }
    const result = await prev(method, payload, signal);
    if (!result.ok && result.error_code === 429)
      retryAfterAt = Math.max(
        retryAfterAt,
        Date.now() + (result.parameters?.retry_after ?? 5) * 1_000,
      );
    return result;
  });
  /** 连接请求自行重试；输入提示、草稿和回调答复不自动重发过期内容。 */
  bot.api.config.use((prev, method, payload, signal) =>
    connectionMethods.has(method) || transientMethods.has(method)
      ? prev(method, payload, signal)
      : autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5, rethrowHttpErrors: true })(
          prev,
          method,
          payload,
          signal,
        ),
  );
  /** Markdown 被拒绝时保留原文，草稿与正式回复共用同一富消息降级方式。 */
  bot.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (
      !result.ok &&
      result.error_code === 400 &&
      "rich_message" in payload &&
      payload.rich_message?.markdown
    )
      return prev(
        method,
        {
          ...payload,
          rich_message: {
            blocks: [{ type: "paragraph", text: payload.rich_message.markdown }],
          },
        },
        signal,
      );
    return result;
  });
  /** 超时覆盖整次调用及重试；signal 使用当前 grammY 请求接口的类型。 */
  bot.api.config.use((prev, method, payload, signal) =>
    prev(
      method,
      payload,
      signal ??
        (AbortSignal.any([
          AbortSignal.timeout(
            method === "getUpdates"
              ? 40_000
              : uploadMethods.has(method)
                ? 60_000
                : transientMethods.has(method)
                  ? 4_000
                  : 15_000,
          ),
          ...(connectionMethods.has(method) ||
          transientMethods.has(method) ||
          uploadMethods.has(method)
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

  /** 入站排序与消息处理共用命令识别；null 表示不由当前机器人处理。 */
  function telegramCommand(message: NonNullable<Context["message"]>) {
    if (message.chat.type !== "private" || message.from?.id !== config.ownerId) return null;
    const command =
      message.text === undefined
        ? undefined
        : message.entities?.find((entity) => entity.type === "bot_command" && entity.offset === 0);
    const [name, target] = command ? (message.text?.slice(1, command.length).split("@") ?? []) : [];
    /** 问题回复可包含绝对路径等斜杠文本；已知控制命令仍优先处理。 */
    if (
      !command ||
      (message.reply_to_message?.from?.id === bot.botInfo.id &&
        !commands.some((item) => item.command === name))
    )
      return;
    if (target !== undefined && target.toLowerCase() !== bot.botInfo.username?.toLowerCase())
      return null;
    return { name: name ?? "", args: message.text?.slice(command.length).trim() ?? "" };
  }

  bot.on("message", async (ctx) => {
    const command = telegramCommand(ctx.message);
    if (command === null) return;

    const attachments = telegramAttachments(ctx.message);
    await handleMessage({
      channel: {
        platform: "telegram",
        accountId: String(ctx.me.id),
        chatId: String(ctx.chat.id),
        userId: String(ctx.from.id),
      },
      eventId: String(ctx.update.update_id),
      content: command
        ? { type: "command", ...command }
        : ctx.message.text !== undefined
          ? {
              type: "text",
              text: ctx.message.text,
              ...(ctx.message.reply_to_message?.from?.id === ctx.me.id
                ? { replyToMessageId: ctx.message.reply_to_message.message_id }
                : {}),
            }
          : attachments.length
            ? { type: "attachments", text: ctx.message.caption ?? "", attachments }
            : { type: "unsupported" },
    });
  });

  /** 先保存选择，再关闭客户端等待提示；答复回调失败不能撤销或重发已保存的决定。 */
  bot.on("callback_query:data", async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^i:([0-9a-f-]{36}):(a(\d+)|stop|q(\d+)_(\d+))$/);
    const selection = ctx.callbackQuery.data.match(/^([pm]):([0-9a-f-]{36}):(\d+)$/);
    /** 会话按钮作为独立事件交给核心层校验和切换。 */
    const session = ctx.callbackQuery.data.match(/^s:(\S+)$/u);
    let reply = "Button expired.";
    if ((match?.[1] || selection?.[2] || session?.[1]) && ctx.chat && ctx.callbackQuery.message) {
      reply =
        (await handleMessage({
          channel: {
            platform: "telegram",
            accountId: String(ctx.me.id),
            chatId: String(ctx.chat.id),
            userId: String(ctx.from.id),
          },
          eventId: String(ctx.update.update_id),
          content: session?.[1]
            ? { type: "session", id: session[1] }
            : selection?.[2]
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
                      ? "approval"
                      : match?.[4] !== undefined
                        ? "option"
                        : "stop",
                  messageId: ctx.callbackQuery.message.message_id,
                  ...(match?.[3] !== undefined
                    ? { optionIndex: Number(match[3]) }
                    : match?.[4] !== undefined
                      ? { questionIndex: Number(match[4]), optionIndex: Number(match[5]) }
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

  /** 只重试连接请求；消息处理和存储错误由调用方上抛，关停同时取消请求与退避。 */
  async function retryConnection<T>(request: () => Promise<T>) {
    let delay = 1_000;
    let retrying = false;
    while (!polling.signal.aborted) {
      try {
        const result = await request();
        if (polling.signal.aborted) return;
        if (retrying) logger.info("Telegram connection restored");
        return result;
      } catch (error) {
        if (polling.signal.aborted) return;
        if (
          !(
            error instanceof HttpError ||
            (error instanceof GrammyError &&
              (error.error_code === 429 || (error.error_code >= 500 && error.error_code < 600)))
          )
        )
          throw error;
        const retryAfterMs = Math.max(
          delay,
          error instanceof GrammyError ? (error.parameters.retry_after ?? 0) * 1_000 : 0,
        );
        logger.warn(
          {
            errorType: error.name,
            errorCode: error instanceof GrammyError ? error.error_code : undefined,
            retryAfterSeconds: retryAfterMs / 1_000,
          },
          "Telegram connection failed; retrying",
        );
        retrying = true;
        try {
          await setTimeout(retryAfterMs, undefined, { signal: polling.signal });
        } catch (error) {
          if (!polling.signal.aborted) throw error;
        }
        delay = Math.min(delay * 2, maxConnectionRetryDelayMs);
      }
    }
  }

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
    prepareAttachments: createTelegramAttachmentLoader(bot.api, config.token, agent),
    /** 核实机器人身份后才启动任务，初始化不消费 Telegram 消息。 */
    async initialize() {
      try {
        return await retryConnection(async () => {
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
        });
      } catch (error) {
        if (polling.signal.aborted && error instanceof HttpError) return;
        logFailure(error);
        throw error;
      }
    },
    /** 接收、文字、附件与输入提示独立运行，慢上传不阻塞审批和控制回复。 */
    async start() {
      started = true;
      const workers: Promise<void>[] = [];
      try {
        if (polling.signal.aborted) return;
        logger.info({ botId: bot.botInfo.id }, "Telegram polling started");
        /** 回复、草稿和活动提示都限定为本次连接认证的机器人与用户。 */
        const source = {
          platform: "telegram",
          accountId: String(bot.botInfo.id),
          userId: String(config.ownerId),
        };
        retryAfterAt = Math.max(retryAfterAt, state.replyRetryAt(source));
        /** 每 10 秒续期；文本与草稿串行，附件完成后同样使旧草稿失效。 */
        let nextDraftAt = 0;
        let sentDraft: { taskId: number; text: string; at: number } | undefined;
        let draftId = randomInt(1, 2_147_483_647);
        /** 附件可能在草稿请求途中完成，迟到草稿回执不能覆盖这次失效。 */
        let draftRevision = 0;
        /** 已收到的命令先完成本地处理或发起查询，再调度回复、附件和输入提示。 */
        let handlingCommands: Promise<void> | undefined;
        workers.push(
          (async () => {
            /** 只有入站状态保存成功才推进确认位置；重投按已保存的事件标识去重。 */
            let offset = 0;
            while (!polling.signal.aborted) {
              const updates = await retryConnection(() =>
                bot.api.getUpdates({
                  offset,
                  timeout: 30,
                  allowed_updates: ["message", "callback_query"],
                }),
              );
              if (!updates || polling.signal.aborted) return;
              /** 成功拉取才确认旧事件；空响应清理过期记录，数值 offset 规则属于 Telegram。 */
              state.confirmUpdates(
                source,
                (eventId) => updates.length === 0 || Number(eventId) < offset,
              );
              const batch = updates.map((update) => ({
                update,
                command: Boolean(update.message && telegramCommand(update.message)),
              }));
              handlingCommands = (async () => {
                for (const { update, command } of batch) {
                  if (polling.signal.aborted) return;
                  if (command) await bot.handleUpdate(update);
                }
              })();
              await handlingCommands;
              handlingCommands = undefined;
              for (const { update, command } of batch) {
                if (polling.signal.aborted) return;
                if (!command) await bot.handleUpdate(update);
              }
              /** 调整处理顺序后，整批保存成功才能确认最大编号，失败或关停仍可重投。 */
              if (polling.signal.aborted) return;
              offset = updates.reduce(
                (next, update) => Math.max(next, update.update_id + 1),
                offset,
              );
            }
          })(),
          ...(["text", "attachment"] as const).map(async (kind) => {
            while (!polling.signal.aborted) {
              if (handlingCommands) {
                await handlingCommands;
                continue;
              }
              if (Date.now() < retryAfterAt) {
                await setTimeout(100);
                continue;
              }
              const reply = state.claimReply(source, kind);
              if (!reply) {
                if (kind === "attachment") {
                  await setTimeout(100);
                  continue;
                }
                const draft = state.pendingDraft(source);
                /** 超长输出继续续期最近的有效预览，避免停止刷新后整段消失。 */
                if (draft && draft.text.length > 32768 && draft.taskId === sentDraft?.taskId)
                  draft.text = sentDraft.text;
                if (
                  draft &&
                  /** 首次输出已超限时等待最终分段发送，不截取正文。 */
                  draft.text.length <= 32768 &&
                  Date.now() >= nextDraftAt &&
                  (draft.taskId !== sentDraft?.taskId ||
                    draft.text !== sentDraft.text ||
                    Date.now() - sentDraft.at >= 10_000)
                ) {
                  nextDraftAt = Date.now() + 1000;
                  if (draft.taskId !== sentDraft?.taskId || Date.now() - sentDraft.at >= 30_000)
                    draftId = (draftId % 2_147_483_647) + 1;
                  const revision = draftRevision;
                  try {
                    await bot.api.sendRichMessageDraft(Number(draft.chatId), draftId, {
                      markdown: draft.text,
                    });
                    sentDraft = { ...draft, at: revision === draftRevision ? Date.now() : 0 };
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
                const interaction = reply.interaction;
                const menu = reply.permissionMenu ?? reply.modelMenu;
                /** 发送与原地编辑共用按钮；确认结果和旧交互编辑会移除按钮。 */
                const markup =
                  reply.promptEnd && menu?.options.length && menu.expiresAt > Date.now()
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
                    : !reply.messageId &&
                        reply.promptEnd &&
                        interaction?.status === "pending" &&
                        (interaction.expiresAt === null || interaction.expiresAt > Date.now())
                      ? {
                          reply_markup: {
                            inline_keyboard: [
                              ...(interaction.kind === "approval"
                                ? interaction.choices.map((choice, index) => [
                                    {
                                      text: choice.label,
                                      callback_data: `i:${interaction.id}:a${index}`,
                                    },
                                  ])
                                : (
                                    interaction.questions[reply.questionIndex ?? -1]?.options ?? []
                                  ).map((option, index) => [
                                    {
                                      text: `${index + 1}. ${[...option.label].slice(0, 50).join("")}`,
                                      callback_data: `i:${interaction.id}:q${reply.questionIndex}_${index}`,
                                    },
                                  ])),
                              ...(interaction.kind === "question"
                                ? [[{ text: "Stop", callback_data: `i:${interaction.id}:stop` }]]
                                : []),
                            ],
                          },
                        }
                      : { reply_markup: { inline_keyboard: [] } };
                /** 列表分段时只在末段显示按钮，完整会话 ID 不受标题截断影响。 */
                if (reply.promptEnd && reply.sessions?.length)
                  markup.reply_markup.inline_keyboard = reply.sessions.map((session, index) => [
                    {
                      text: `${index + 1}. ${[...session.label].slice(0, 50).join("")}`,
                      callback_data: `s:${session.id}`,
                    },
                  ]);
                let messageId = reply.messageId;
                if (reply.attachment)
                  messageId = (
                    await sendTelegramAttachment(bot.api, reply.chatId, reply.attachment)
                  ).message_id;
                else if (messageId)
                  await bot.api.editMessageText(
                    reply.chatId,
                    messageId,
                    reply.markdown ? { markdown: reply.text } : reply.text,
                    markup,
                  );
                else
                  messageId = (
                    reply.markdown
                      ? await bot.api.sendRichMessage(
                          reply.chatId,
                          { markdown: reply.text },
                          markup,
                        )
                      : await bot.api.sendMessage(reply.chatId, reply.text, markup)
                  ).message_id;
                state.removeReply(
                  reply.id,
                  reply.messageId && !reply.modelMenuId && !reply.permissionMenuId
                    ? undefined
                    : {
                        messageId,
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
                      },
                );
                /** 新消息清除草稿，编辑消息不会；保留有效正文并让下一次恢复换用新 ID。 */
                if (!reply.messageId) {
                  draftRevision++;
                  if (sentDraft) sentDraft.at = 0;
                }
              } catch (error) {
                if (
                  !(
                    error instanceof HttpError ||
                    error instanceof GrammyError ||
                    error instanceof AttachmentError
                  )
                )
                  throw error;
                if (error instanceof GrammyError && error.error_code === 401) throw error;
                const permanent =
                  error instanceof AttachmentError ||
                  (error instanceof GrammyError &&
                    error.error_code >= 400 &&
                    error.error_code < 500 &&
                    error.error_code !== 429);
                if (permanent) {
                  if (reply.attachment)
                    state.reply(
                      reply.channelId,
                      `附件发送失败：${reply.attachment.name}\n${
                        error instanceof AttachmentError
                          ? error.message
                          : "Telegram 拒绝接收附件，原文件仍保留在生成位置。"
                      }`,
                    );
                  state.removeReply(reply.id);
                } else
                  state.retryReply(
                    reply.id,
                    Math.max(
                      Math.ceil((retryAfterAt - Date.now()) / 1_000),
                      error instanceof GrammyError && error.parameters.retry_after !== undefined
                        ? error.parameters.retry_after
                        : Math.min(60, 2 ** Math.min(reply.attempts, 6)),
                    ),
                    retryAfterAt > Date.now(),
                  );
                logger.warn(
                  { outboxId: reply.id, permanent, errorType: error.name },
                  permanent
                    ? "Telegram rejected reply permanently; removed from queue."
                    : "Telegram reply failed; saved for retry",
                );
              }
            }
          }),
          (async () => {
            /** 输入提示最多持续 5 秒，每 4 秒刷新；仅当前实例已派发的任务显示。 */
            let nextTypingAt = 0;
            while (!polling.signal.aborted) {
              if (handlingCommands) {
                await handlingCommands;
                continue;
              }
              if (
                Date.now() >= nextTypingAt &&
                ["dispatching", "running"].includes(state.activeTask(source)?.status ?? "") &&
                !state.activeTask(source)?.interactions.some((item) => item.blocking)
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
