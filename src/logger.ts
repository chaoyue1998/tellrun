import { pino } from "pino";

/** 创建结构化日志；调用方只记录标识和阶段，不传入配置、正文或原始 API 错误。 */
export function createLogger() {
  return pino({
    name: "tellrun",
    level: "info",
    redact: {
      paths: [
        "telegramToken",
        "token",
        "TELEGRAM_BOT_TOKEN",
        "authorization",
        "prompt",
        "*.telegramToken",
        "*.token",
        "*.TELEGRAM_BOT_TOKEN",
        "*.authorization",
        "*.prompt",
      ],
      censor: "[REDACTED]",
    },
  });
}
