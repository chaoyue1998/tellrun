#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { Command, CommanderError } from "commander";
import which from "which";
import { ZodError } from "zod";
import { createCodexAgent } from "./agents/codex.js";
import { appDirectory, type Config, configSchema, loadConfig } from "./config.js";
import { writeJson } from "./storage/json.js";
import { manageService } from "./systemd.js";

/** 全局入口只注册命令；业务入口仅在 run 时动态加载。 */
const program = new Command()
  .name("tellrun")
  .description("Chat with Codex via Telegram")
  .version(
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    "-V, --version",
    "Show version",
  )
  .helpOption("-h, --help", "Show help")
  .addHelpCommand("help [command]", "Show command help")
  .showHelpAfterError()
  .exitOverride();

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
    const answers = await p.group(
      {
        token: () =>
          p.text({
            message: current ? "Telegram bot token (blank to keep)" : "Telegram bot token",
            validate: (value) =>
              configSchema.shape.telegram.shape.token.safeParse(
                value?.trim() || current?.telegram.token,
              ).success
                ? undefined
                : "Enter a valid bot token.",
          }),
        ownerId: () =>
          p.text({
            message: "Your Telegram user ID",
            initialValue: current ? String(current.telegram.ownerId) : "",
            validate: (value) =>
              configSchema.shape.telegram.shape.ownerId.safeParse(value).success
                ? undefined
                : "Enter a positive numeric user ID.",
          }),
        codexPath: () =>
          p.text({
            message: "Codex command or path",
            initialValue: current?.codexPath ?? process.env.CODEX_PATH ?? "codex",
            validate: (value) => (value?.trim() ? undefined : "Enter a Codex command or path."),
          }),
        launch: () =>
          process.platform === "linux"
            ? p.select({
                message: "After setup",
                options: [
                  { value: "boot", label: "Start or restart, enable at boot" },
                  { value: "start", label: "Start or restart" },
                  { value: "later", label: "Save only" },
                ],
              })
            : Promise.resolve("later"),
      },
      {
        onCancel: () => {
          p.cancel("Setup cancelled. Config unchanged.");
          throw new CommanderError(130, "setup.cancelled", "Setup cancelled.");
        },
      },
    );

    /** 命令名按 PATH 查找，指定路径直接检查可执行性。 */
    const executable = await which(answers.codexPath.trim(), { nothrow: true });
    if (!executable) throw new Error("Codex not found. Check its path; config unchanged.");
    const config = configSchema.parse({
      telegram: {
        token: answers.token.trim() || current?.telegram.token,
        ownerId: answers.ownerId,
        proxyUrl: current?.telegram.proxyUrl,
      },
      codexPath: realpathSync(executable),
    });
    try {
      await createCodexAgent(config.codexPath);
    } catch {
      throw new Error("Codex check failed. Check its path and permissions; config unchanged.");
    }

    /** 校验完成后在同目录原子替换，取消或失败时不留下半份配置。 */
    mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
    chmodSync(appDirectory, 0o700);
    writeJson(join(appDirectory, "config.json"), config);
    p.outro("Config saved. Run tellrun restart to reload.");
    if (answers.launch !== "later")
      await manageService("restart", { enable: answers.launch === "boot" });
    else
      console.log(
        process.platform === "linux"
          ? "Run tellrun start to start the service."
          : "Run tellrun run. Background mode requires Linux systemd.",
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
  .option("--enable", "Enable at boot")
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
  .command("service")
  .description("Manage the background service")
  .command("uninstall")
  .description("Remove service; keep config and state")
  .action(async () => {
    await manageService("uninstall");
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
