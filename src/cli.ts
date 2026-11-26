#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { Command, CommanderError } from "commander";
import which from "which";
import { ZodError } from "zod";
import { createAgent } from "./agents/index.js";
import {
  type AgentType,
  agentDefinitions,
  agentTypes,
  appDirectory,
  type Config,
  configSchema,
  configuredAgents,
  loadConfig,
} from "./config.js";
import { manageService } from "./service.js";
import { writeJson } from "./storage/json.js";
import { uninstall } from "./uninstall.js";
import { tellrunVersion } from "./updates.js";

/** 全局入口只注册命令；业务入口仅在 run 时动态加载。 */
const program = new Command()
  .name("tellrun")
  .description("Chat with AI coding agents via Telegram")
  .version(tellrunVersion, "-V, --version", "Show version")
  .helpOption("-h, --help", "Show help")
  .addHelpCommand("help [command]", "Show command help")
  .showHelpAfterError()
  .exitOverride();

/** 向导取消时统一中止并保留原配置。 */
function requireAnswer<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value) || typeof value === "symbol") {
    p.cancel("Setup cancelled. Config unchanged.");
    throw new CommanderError(130, "setup.cancelled", "Setup cancelled.");
  }
  return value as Exclude<T, symbol>;
}

program
  .command("setup")
  .description("Configure Tellrun and start the service")
  .action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Run tellrun setup in an interactive terminal.");
    }
    p.intro("Tellrun setup");
    let current: Config | undefined;
    try {
      current = loadConfig();
    } catch {
      if (existsSync(join(appDirectory, "config.json"))) {
        p.log.warn("Could not load config. It will be kept until you save.");
      }
    }
    p.log.info("Config: ~/.tellrun/config.json");

    const token = requireAnswer(
      await p.text({
        message: current ? "Telegram bot token (blank to keep)" : "Telegram bot token",
        validate: (value) =>
          configSchema.shape.telegram.shape.token.safeParse(
            value?.trim() || current?.telegram.token,
          ).success
            ? undefined
            : "Enter a valid bot token.",
      }),
    );
    const ownerId = requireAnswer(
      await p.text({
        message: "Your Telegram user ID",
        initialValue: current ? String(current.telegram.ownerId) : "",
        validate: (value) =>
          configSchema.shape.telegram.shape.ownerId.safeParse(value).success
            ? undefined
            : "Enter a positive numeric user ID.",
      }),
    );
    /** 可选 Telegram 代理；默认与占位均为空，留空时不写入配置。 */
    const proxyUrl = requireAnswer(
      await p.text({
        message: "Telegram proxy URL (optional)",
        initialValue: current?.telegram.proxyUrl ?? "",
        validate: (value) =>
          configSchema.shape.telegram.shape.proxyUrl.safeParse(value).success
            ? undefined
            : "Enter a valid http:// or https:// proxy URL, or leave blank.",
      }),
    );

    /** 首次配置时自动检测已安装的 CLI 并默认勾选，支持同时启用多个 Agent。 */
    const detected = await Promise.all(
      agentTypes.map(
        async (type) =>
          [type, await which(agentDefinitions[type].defaultCommand, { nothrow: true })] as const,
      ),
    );
    const detectedMap = new Map(detected);
    const initialEnabled: AgentType[] = current
      ? configuredAgents(current).map((entry) => entry.type)
      : (() => {
          const found = detected.filter(([, path]) => Boolean(path)).map(([type]) => type);
          return found.length ? found : ["codex"];
        })();

    const enabledAgents = requireAnswer(
      await p.multiselect<AgentType>({
        message: "Enabled coding agent CLIs (space to toggle, enter to confirm)",
        initialValues: initialEnabled,
        required: true,
        options: agentTypes.map((type) => {
          const foundPath = detectedMap.get(type);
          return {
            value: type,
            label: agentDefinitions[type].label,
            ...(foundPath ? { hint: foundPath } : {}),
          };
        }),
      }),
    );

    const agentEntries: Partial<Record<AgentType, { path: string }>> = {};
    for (const type of enabledAgents) {
      const definition = agentDefinitions[type];
      const initialValue =
        current?.agents[type]?.path ??
        process.env[definition.envVar]?.trim() ??
        detectedMap.get(type) ??
        definition.defaultCommand;
      const enteredPath = requireAnswer(
        await p.text({
          message: `${definition.label} command or path`,
          initialValue,
          validate: (value) =>
            value?.trim() ? undefined : `Enter a ${definition.label} command or path.`,
        }),
      );
      /** 命令名按 PATH 查找，指定路径直接检查可执行性。 */
      const executable = await which(enteredPath.trim(), { nothrow: true });
      if (!executable)
        throw new Error(`${definition.label} not found. Check its path; config unchanged.`);
      /** 保留稳定入口的软链接，避免升级后仍指向已删除的版本目录。 */
      agentEntries[type] = { path: resolve(executable) };
    }

    const defaultAgent: AgentType =
      enabledAgents.length > 1
        ? requireAnswer(
            await p.select<AgentType>({
              message: "Default coding agent (you can switch anytime with /agent)",
              initialValue:
                current && enabledAgents.includes(current.defaultAgent)
                  ? current.defaultAgent
                  : (enabledAgents[0] ?? "codex"),
              options: enabledAgents.map((type) => ({
                value: type,
                label: agentDefinitions[type].label,
              })),
            }),
          )
        : (enabledAgents[0] ?? "codex");

    const launch = ["linux", "darwin"].includes(process.platform)
      ? requireAnswer(
          await p.select({
            message: "After setup",
            options: [
              {
                value: "boot",
                label:
                  process.platform === "darwin"
                    ? "Start or restart, enable at login"
                    : "Start or restart, enable at boot",
              },
              { value: "start", label: "Start or restart" },
              { value: "later", label: "Save only" },
            ],
          }),
        )
      : "later";

    const trimmedProxyUrl = proxyUrl.trim();
    const config = configSchema.parse({
      telegram: {
        token: token.trim() || current?.telegram.token,
        ownerId,
        ...(trimmedProxyUrl ? { proxyUrl: trimmedProxyUrl } : {}),
      },
      defaultAgent,
      agents: agentEntries,
    });

    for (const entry of configuredAgents(config)) {
      const definition = agentDefinitions[entry.type];
      try {
        const agent = await createAgent(entry.type, entry.path);
        agent.disconnect();
      } catch {
        throw new Error(
          `${definition.label} check failed. Check its path and permissions; config unchanged.`,
        );
      }
    }

    /** 校验完成后在同目录原子替换，取消或失败时不留下半份配置。 */
    mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
    chmodSync(appDirectory, 0o700);
    writeJson(join(appDirectory, "config.json"), config);
    p.outro("Config saved. Run tellrun restart to reload.");
    if (launch !== "later") await manageService("restart", { enable: launch === "boot" });
    else
      console.log(
        ["linux", "darwin"].includes(process.platform)
          ? "Run tellrun start to start the service."
          : "Run tellrun run. Background mode requires Linux or macOS.",
      );
  });

program
  .command("run")
  .description("Run in the foreground")
  .action(async () => {
    await import("./main.js");
  });
program
  .command("start")
  .description("Start the background service")
  .option("--enable", process.platform === "darwin" ? "Enable at login" : "Enable at boot")
  .action(async (options: { enable?: boolean }) => {
    await manageService("start", options);
  });
program
  .command("stop")
  .description("Stop the background service")
  .action(async () => {
    await manageService("stop");
  });
program
  .command("restart")
  .description("Restart with updated config or version")
  .action(async () => {
    await manageService("restart");
  });
program
  .command("status")
  .description("Show service status and data paths")
  .action(async () => {
    await manageService("status");
  });
program
  .command("logs")
  .description("Show the last 100 log entries")
  .option("-f, --follow", "Follow logs")
  .action(async (options: { follow?: boolean }) => {
    await manageService("logs", options);
  });
program
  .command("uninstall")
  .description("Uninstall Tellrun; keep user data")
  .action(async () => {
    await uninstall();
  });

try {
  /** npm 的 engines 默认只警告；入口显式拒绝缺少内置代理能力的 Node 版本。 */
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 5)) {
    throw new Error(
      `Node.js 24.5.0+ required (current: ${process.versions.node}). Upgrade Node.js.`,
    );
  }
  if (process.argv.length <= 2) program.outputHelp();
  else await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else {
    process.exitCode = 1;
    console.error(
      error instanceof ZodError
        ? "Invalid config. Existing config unchanged."
        : error instanceof Error
          ? error.message
          : "Command failed.",
    );
  }
}
