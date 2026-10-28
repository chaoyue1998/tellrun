import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** CLI、后台服务和独立迁移共用的用户数据目录，不依赖当前工作目录。 */
export const appDirectory = join(homedir(), ".agent-relay");

/** 配置向导与运行入口共用校验；只保存后台运行需要的环境。 */
export const configSchema = z.object({
  telegram: z.object({
    token: z
      .string()
      .trim()
      .regex(/^\d+:[\w-]+$/),
    ownerId: z
      .union([
        z.number(),
        z
          .string()
          .trim()
          .regex(/^[1-9]\d*$/)
          .transform(Number),
      ])
      .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
    proxyUrl: z
      .string()
      .trim()
      .pipe(z.url({ protocol: /^https?$/ }).or(z.literal("")))
      .optional(),
  }),
  codexPath: z.string().trim().min(1).default("codex"),
  environment: z
    .object({
      PATH: z.string().optional(),
      CODEX_HOME: z.string().optional(),
      HTTP_PROXY: z.string().optional(),
      HTTPS_PROXY: z.string().optional(),
      ALL_PROXY: z.string().optional(),
      NO_PROXY: z.string().optional(),
      http_proxy: z.string().optional(),
      https_proxy: z.string().optional(),
      all_proxy: z.string().optional(),
      no_proxy: z.string().optional(),
    })
    .default({}),
});

/** 读取用户配置，允许环境变量覆盖 Telegram 与 Codex 入口；诊断不包含配置值。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  let saved: Partial<z.input<typeof configSchema>> = {};
  try {
    saved = JSON.parse(readFileSync(join(appDirectory, "config.json"), "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new SyntaxError();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error(
        error instanceof SyntaxError
          ? "~/.agent-relay/config.json 不是有效的配置对象，请运行 agent-relay setup 重新配置"
          : "无法读取 ~/.agent-relay/config.json，请检查文件权限",
      );
    }
  }

  const config = configSchema.safeParse({
    ...saved,
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN ?? saved.telegram?.token,
      ownerId: env.TELEGRAM_OWNER_ID ?? saved.telegram?.ownerId,
      proxyUrl: env.TELEGRAM_PROXY_URL?.trim() || saved.telegram?.proxyUrl,
    },
    codexPath: env.CODEX_PATH ?? saved.codexPath,
  });
  if (!config.success) {
    throw new Error(
      `配置无效：${[...new Set(config.error.issues.map((issue) => issue.path.join(".")))].join("、")}；请运行 agent-relay setup 或检查环境变量`,
    );
  }
  return config.data;
}

/** 应用使用的配置类型，与校验结果保持一致。 */
export type Config = ReturnType<typeof loadConfig>;
