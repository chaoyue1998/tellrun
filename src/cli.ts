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
  .name("agent-relay")
  .description("通过 Telegram 与服务器上的 Codex 对话")
  .version(
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    "-V, --version",
    "显示版本号",
  )
  .helpOption("-h, --help", "显示帮助")
  .addHelpCommand("help [command]", "查看命令帮助")
  .showHelpAfterError()
  .exitOverride();

program
  .command("setup")
  .description("交互配置并启动后台服务")
  .action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("setup 需要交互终端，请直接在终端运行 agent-relay setup。");
    }
    p.intro("Agent Relay 配置");
    let current: Config | undefined;
    try {
      current = loadConfig();
    } catch {
      if (existsSync(join(appDirectory, "config.json"))) {
        p.log.warn("现有配置无法加载，需要重新填写；完成前保留原文件。");
      }
    }
    p.log.info("配置保存到 ~/.agent-relay/config.json。");
    const answers = await p.group(
      {
        token: () =>
          p.text({
            message: current ? "Telegram Bot Token（留空保留原值）" : "Telegram Bot Token",
            validate: (value) =>
              configSchema.shape.telegram.shape.token.safeParse(
                value?.trim() || current?.telegram.token,
              ).success
                ? undefined
                : "请输入有效的 Bot Token",
          }),
        ownerId: () =>
          p.text({
            message: "本人 Telegram 数字用户 ID",
            initialValue: current ? String(current.telegram.ownerId) : "",
            validate: (value) =>
              configSchema.shape.telegram.shape.ownerId.safeParse(value).success
                ? undefined
                : "请输入十进制正整数用户 ID",
          }),
        codexPath: () =>
          p.text({
            message: "Codex 可执行文件路径或命令名",
            initialValue: current?.codexPath ?? process.env.CODEX_PATH ?? "codex",
            validate: (value) => (value?.trim() ? undefined : "请输入 Codex 路径或命令名"),
          }),
        launch: () =>
          process.platform === "linux"
            ? p.select({
                message: "保存配置后",
                options: [
                  { value: "boot", label: "启动或重启后台服务，并开机自启" },
                  { value: "start", label: "启动或重启后台服务" },
                  { value: "later", label: "仅保存配置" },
                ],
              })
            : Promise.resolve("later"),
      },
      {
        onCancel: () => {
          p.cancel("配置已取消，原配置保持不变。");
          throw new CommanderError(130, "setup.cancelled", "配置已取消");
        },
      },
    );

    /** 命令名按 PATH 查找，指定路径直接检查可执行性。 */
    const executable = await which(answers.codexPath.trim(), { nothrow: true });
    if (!executable)
      throw new Error("未找到可执行的 Codex，请先安装 Codex 或填写正确路径；原配置保持不变。");
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
      throw new Error(
        "Codex CLI 检查失败，请检查可执行权限和运行环境；原配置保持不变。认证与模型连通性需在实际任务中验证。",
      );
    }

    /** 校验完成后在同目录原子替换，取消或失败时不留下半份配置。 */
    mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
    chmodSync(appDirectory, 0o700);
    writeJson(join(appDirectory, "config.json"), config);
    p.outro("配置已保存；如已有服务运行，请用 agent-relay restart 加载新配置。");
    if (answers.launch !== "later")
      await manageService("restart", { enable: answers.launch === "boot" });
    else
      console.log(
        process.platform === "linux"
          ? "运行 agent-relay start 启动后台服务。"
          : "运行 agent-relay run 前台启动；后台管理支持 Linux systemd。",
      );
  });

program
  .command("run")
  .description("前台运行服务")
  .action(async () => {
    await import("./main.js");
  });
program
  .command("start")
  .description("启动后台服务")
  .option("--enable", "同时启用开机自启")
  .action(async (options: { enable?: boolean }) => {
    await manageService("start", options);
  });
program
  .command("stop")
  .description("停止后台服务并等待退出")
  .action(async () => {
    await manageService("stop");
  });
program
  .command("restart")
  .description("更新服务入口并重启，加载新配置或版本")
  .action(async () => {
    await manageService("restart");
  });
program
  .command("status")
  .description("查看后台服务状态与数据路径")
  .action(async () => {
    await manageService("status");
  });
program
  .command("logs")
  .description("查看最近 100 条后台日志")
  .option("-f, --follow", "持续跟随日志")
  .action(async (options: { follow?: boolean }) => {
    await manageService("logs", options);
  });
program
  .command("service")
  .description("管理后台服务安装")
  .command("uninstall")
  .description("停止并卸载服务，保留配置与状态文件")
  .action(async () => {
    await manageService("uninstall");
  });

try {
  /** npm 的 engines 默认只警告；入口显式拒绝缺少内置代理能力的 Node 版本。 */
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 5)) {
    throw new Error(
      `需要 Node.js 24.5.0 或更高版本，当前为 ${process.versions.node}；请切换 Node 后重试。`,
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
        ? "配置校验失败，原配置保持不变。"
        : error instanceof Error
          ? error.message
          : "命令执行失败",
    );
  }
}
