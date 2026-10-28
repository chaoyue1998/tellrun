import { z } from "zod";

/** 校验 Telegram 凭据、本人身份和可选代理；错误信息不包含配置值。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const environment = z
    .object({
      TELEGRAM_BOT_TOKEN: z
        .string()
        .trim()
        .regex(/^\d+:[\w-]+$/),
      TELEGRAM_OWNER_ID: z
        .string()
        .trim()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
      TELEGRAM_PROXY_URL: z
        .url({ protocol: /^https?$/ })
        .or(z.literal(""))
        .optional(),
    })
    .safeParse(env);

  if (!environment.success) {
    throw new Error(
      `环境变量无效：${[...new Set(environment.error.issues.map((issue) => issue.path.join(".")))].join("、")}`,
    );
  }

  return {
    telegram: {
      token: environment.data.TELEGRAM_BOT_TOKEN,
      ownerId: environment.data.TELEGRAM_OWNER_ID,
      proxyUrl: environment.data.TELEGRAM_PROXY_URL,
    },
  };
}

/** 应用使用的配置类型，与校验结果保持一致。 */
export type Config = ReturnType<typeof loadConfig>;
