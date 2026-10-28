import { Agent } from "node:https";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, BotError, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { MessageHandler } from "../core/types.js";

/** Telegram 连接器负责鉴权、消息转换与发送，业务逻辑交给统一处理入口。 */
export function createTelegramConnection(
  config: Config["telegram"],
  handleMessage: MessageHandler,
  logger: Logger,
) {
  /** 默认继承终端代理；显式配置使用优先级更高的小写变量，保留 NO_PROXY 规则。 */
  const agent = new Agent({
    keepAlive: true,
    proxyEnv: config.proxyUrl ? { ...process.env, https_proxy: config.proxyUrl } : process.env,
  });
  const bot = new Bot(config.token, {
    client: { timeoutSeconds: 35, baseFetchConfig: { agent } },
  });
  /** 只中断初始化和拉取；正在处理的消息由 start 等待完成。 */
  const polling = new AbortController();
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

  bot.on("message:text", async (ctx) => {
    const command = ctx.message.entities?.find(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    );
    const [name, target] = command ? ctx.message.text.slice(1, command.length).split("@") : [];
    if (target !== undefined && target.toLowerCase() !== ctx.me.username?.toLowerCase()) return;

    await ctx.reply(
      (
        await handleMessage({
          channel: {
            platform: "telegram",
            accountId: String(ctx.me.id),
            chatId: String(ctx.chat.id),
            userId: String(ctx.from.id),
          },
          content: command
            ? { type: "command", name: name ?? "" }
            : { type: "text", text: ctx.message.text },
        })
      ).text,
    );
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("当前仅支持文本消息，请使用 /help 查看可用操作。");
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

  return {
    /** 仅成功处理后推进 offset；此 Promise 结束后才能关闭存储。 */
    async start() {
      if (polling.signal.aborted) return;
      try {
        bot.botInfo = await bot.api.getMe();
        if (polling.signal.aborted) return;
        if ((await bot.api.getWebhookInfo()).url) {
          logger.error("当前 Bot 已配置 Webhook，请先确认并手动移除后再启用长轮询");
          throw new Error("Bot 已被 Webhook 占用");
        }
        if (polling.signal.aborted) return;
        logger.info({ botId: bot.botInfo.id }, "Telegram 长轮询已启动");

        /** 自行维护确认位置，避免 bot.stop 确认尚未成功处理的更新。 */
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
      } catch (error) {
        /** 关停只忽略被取消的读取；业务错误即使发生在退出期间也必须上报。 */
        if (polling.signal.aborted && !(error instanceof BotError)) return;
        let cause = error instanceof BotError ? error.error : error;
        /** 网络错误仅记录类型和错误码，原始消息中的 URL 可能包含 Bot Token。 */
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
              : "Telegram 启动或消息处理失败，停止轮询以便恢复",
        );
        throw error;
      } finally {
        agent.destroy();
      }
    },
    /** 停止拉取，不额外发送确认请求；未确认更新允许在重启后重投。 */
    stop() {
      polling.abort();
    },
  };
}
