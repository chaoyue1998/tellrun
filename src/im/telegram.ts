import { Agent } from "node:https";
import { setTimeout } from "node:timers/promises";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, BotError, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { MessageHandler } from "../core/types.js";
import type { Store } from "../storage/index.js";

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
  /** 只中断初始化和拉取；正在处理的消息由 start 等待完成。 */
  const polling = new AbortController();
  let started = false;
  bot.api.config.use(
    autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5, rethrowHttpErrors: true }),
  );
  /** 超时覆盖整次调用及重试；grammY 的旧 signal 类型与 Node 原生接口兼容。 */
  bot.api.config.use((prev, method, payload, signal) =>
    prev(
      method,
      payload,
      signal ??
        (AbortSignal.any([
          AbortSignal.timeout(method === "getUpdates" ? 40_000 : 15_000),
          ...(["getMe", "getWebhookInfo", "getUpdates"].includes(method) ? [polling.signal] : []),
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
    const command =
      ctx.message.text === undefined
        ? undefined
        : ctx.message.entities?.find(
            (entity) => entity.type === "bot_command" && entity.offset === 0,
          );
    const [name, target] = command
      ? (ctx.message.text?.slice(1, command.length).split("@") ?? [])
      : [];
    if (target !== undefined && target.toLowerCase() !== ctx.me.username?.toLowerCase()) return;

    await handleMessage({
      channel: {
        platform: "telegram",
        accountId: String(ctx.me.id),
        chatId: String(ctx.chat.id),
        userId: String(ctx.from.id),
      },
      eventId: String(ctx.update.update_id),
      messageId: String(ctx.message.message_id),
      content: command
        ? {
            type: "command",
            name: name ?? "",
            args: ctx.message.text?.slice(command.length).trim() ?? "",
          }
        : ctx.message.text !== undefined
          ? { type: "text", text: ctx.message.text }
          : { type: "unsupported" },
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    try {
      await ctx.answerCallbackQuery({ text: "此操作尚不可用或已经失效。" });
    } catch (error) {
      /** 过期回调无法再次应答，不应阻断后续消息；其他错误仍向上传递。 */
      if (
        error instanceof GrammyError &&
        error.error_code === 400 &&
        /query is too old|query id is invalid/i.test(error.description)
      ) {
        logger.warn({ updateId: ctx.update.update_id }, "Telegram 按钮回调已过期");
        return;
      }
      throw error;
    }
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
        ? "Telegram 轮询冲突，请检查其他实例或 Webhook"
        : cause instanceof GrammyError && cause.error_code === 401
          ? "Telegram 身份验证失败，请检查 Bot Token"
          : "Telegram 连接或持久化处理失败，服务将停止",
    );
  }

  return {
    /** 核实机器人身份后才启动任务，初始化不消费 Telegram 消息。 */
    async initialize() {
      try {
        bot.botInfo = await bot.api.getMe();
        if (polling.signal.aborted) return;
        if ((await bot.api.getWebhookInfo()).url) {
          logger.error("当前 Bot 已配置 Webhook，请先确认并手动移除后再启用长轮询");
          throw new Error("Bot 已被 Webhook 占用");
        }
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
    /** 接收与发送独立运行，慢回复不会阻塞 /stop 的入站处理。 */
    async start() {
      started = true;
      const workers: Promise<void>[] = [];
      try {
        if (polling.signal.aborted) return;
        logger.info({ botId: bot.botInfo.id }, "Telegram 长轮询已启动");
        workers.push(
          (async () => {
            /** 只有入站事务成功才推进确认位置；重投由数据库唯一约束去重。 */
            let offset = 0;
            while (!polling.signal.aborted) {
              for (const update of await bot.api.getUpdates({
                offset,
                timeout: 30,
                allowed_updates: ["message", "callback_query"],
              })) {
                if (polling.signal.aborted) return;
                await bot.handleUpdate(update);
                offset = update.update_id + 1;
              }
            }
          })(),
          (async () => {
            while (!polling.signal.aborted) {
              const reply = store.pendingReply(String(bot.botInfo.id), String(config.ownerId));
              if (!reply) {
                await setTimeout(250);
                continue;
              }
              try {
                const sent = await bot.api.sendMessage(reply.chatId, reply.text);
                store.sentReply(reply.id, String(sent.message_id));
              } catch (error) {
                if (!(error instanceof HttpError || error instanceof GrammyError)) throw error;
                if (error instanceof GrammyError && error.error_code === 401) throw error;
                const permanent =
                  error instanceof GrammyError &&
                  error.error_code >= 400 &&
                  error.error_code < 500 &&
                  error.error_code !== 429;
                store.retryReply(
                  reply.id,
                  error instanceof GrammyError && error.parameters.retry_after !== undefined
                    ? error.parameters.retry_after
                    : Math.min(60, 2 ** Math.min(reply.attempts, 6)),
                  permanent,
                );
                logger.warn(
                  { outboxId: reply.id, permanent, errorType: error.name },
                  permanent
                    ? "Telegram 拒绝发送回复，结果仍保留在本地"
                    : "Telegram 回复发送失败，已保留并安排重试",
                );
              }
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
