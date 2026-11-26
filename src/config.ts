import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** CLI 与后台服务共用的用户数据目录，不依赖当前工作目录。 */
export const appDirectory = join(homedir(), ".tellrun");

/** 支持的 Agent 标识；配置、CLI 向导与多 Agent 注册共用此定义。 */
export const agentTypes = ["codex", "agy"] as const;
export type AgentType = (typeof agentTypes)[number];

/** 各 Agent 的展示名称、默认命令与独立路径环境变量。 */
export const agentDefinitions: Record<
  AgentType,
  { name: string; label: string; defaultCommand: string; envVar: "CODEX_PATH" | "AGY_PATH" }
> = {
  codex: { name: "Codex", label: "Codex CLI", defaultCommand: "codex", envVar: "CODEX_PATH" },
  agy: {
    name: "Antigravity",
    label: "Antigravity CLI (agy)",
    defaultCommand: "agy",
    envVar: "AGY_PATH",
  },
};

const agentTypeSchema = z.enum(agentTypes);
const agentEntrySchema = z.strictObject({
  path: z.string().trim().min(1),
});

/** 配置向导与运行入口共用严格校验；仅接受当前完整配置结构。 */
export const configSchema = z
  .strictObject({
    telegram: z.strictObject({
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
      /** 可选代理由用户自行配置；未设置时继承运行环境，空字符串表示直连。 */
      proxyUrl: z
        .string()
        .trim()
        .pipe(z.url({ protocol: /^https?$/ }).or(z.literal("")))
        .optional(),
    }),
    defaultAgent: agentTypeSchema,
    agents: z
      .strictObject({
        codex: agentEntrySchema.optional(),
        agy: agentEntrySchema.optional(),
      })
      .refine((agents) => Boolean(agents.codex || agents.agy), {
        message: "At least one agent must be configured.",
      }),
  })
  .refine((config) => Boolean(config.agents[config.defaultAgent]), {
    message: "defaultAgent must be configured in agents.",
    path: ["defaultAgent"],
  });

/** 读取用户配置，支持环境变量覆盖 Telegram 凭据、各 Agent 路径及默认 Agent。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(appDirectory, "config.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError();
    saved = parsed as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error(
        error instanceof SyntaxError
          ? "Invalid ~/.tellrun/config.json. Run tellrun setup."
          : "Cannot read ~/.tellrun/config.json. Check permissions.",
      );
    }
  }

  const savedTelegram =
    saved.telegram && typeof saved.telegram === "object" && !Array.isArray(saved.telegram)
      ? (saved.telegram as Record<string, unknown>)
      : {};
  const savedAgents =
    saved.agents && typeof saved.agents === "object" && !Array.isArray(saved.agents)
      ? { ...(saved.agents as Record<string, unknown>) }
      : {};

  /** 环境变量覆盖各 Agent 路径；未配置的 Agent 也可直接通过路径环境变量启用。 */
  for (const type of agentTypes) {
    const envPath = env[agentDefinitions[type].envVar]?.trim();
    if (envPath) savedAgents[type] = { path: envPath };
  }

  const envDefault = env.TELLRUN_AGENT?.trim();
  const parsedEnvDefault = envDefault ? agentTypeSchema.safeParse(envDefault) : undefined;
  if (parsedEnvDefault?.success && !savedAgents[parsedEnvDefault.data]) {
    savedAgents[parsedEnvDefault.data] = {
      path: agentDefinitions[parsedEnvDefault.data].defaultCommand,
    };
  }

  const firstConfigured = agentTypes.find((type) => Boolean(savedAgents[type]));
  const proxyUrl =
    env.TELEGRAM_PROXY_URL !== undefined ? env.TELEGRAM_PROXY_URL.trim() : savedTelegram.proxyUrl;
  const candidate: Record<string, unknown> = {
    ...saved,
    telegram: {
      ...savedTelegram,
      token: env.TELEGRAM_BOT_TOKEN ?? savedTelegram.token,
      ownerId: env.TELEGRAM_OWNER_ID ?? savedTelegram.ownerId,
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    },
    defaultAgent: envDefault || saved.defaultAgent || firstConfigured,
    agents: savedAgents,
  };

  const config = configSchema.safeParse(candidate);
  if (!config.success) {
    throw new Error(
      `Invalid config: ${[...new Set(config.error.issues.map((issue) => issue.path.join(".") || "root"))].join(", ")}. Run tellrun setup or check environment variables.`,
    );
  }
  return config.data;
}

/** 返回配置中所有已启用 Agent 的有序列表。 */
export function configuredAgents(config: Config) {
  return agentTypes.flatMap((type) => {
    const entry = config.agents[type];
    return entry ? [{ type, path: entry.path }] : [];
  });
}

/** 应用使用的配置类型，与校验结果保持一致。 */
export type Config = ReturnType<typeof loadConfig>;
