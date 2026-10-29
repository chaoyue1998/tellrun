import { pino } from "pino";

/** 只记录服务启停与故障诊断，不传入任务正文、配置或原始 API 错误。 */
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
