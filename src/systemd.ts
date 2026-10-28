import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appDirectory, loadConfig } from "./config.js";

/** 所有后台命令使用同一个用户服务名，服务定义与配置一起保存。 */
const unit = "tellrun.service";

/** 调用用户服务管理器；只输出固定诊断，避免转发可能包含凭据的原始错误。 */
async function systemctl(...args: string[]) {
  try {
    const { stdout } = await promisify(execFile)("systemctl", ["--user", "--no-pager", ...args], {
      timeout: 90_000,
      maxBuffer: 1_048_576,
    });
    return stdout.trim();
  } catch (error) {
    if (
      args[0] === "show" &&
      error instanceof Error &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      /^LoadState=not-found$/m.test(error.stdout)
    ) {
      return error.stdout.trim();
    }
    throw new Error(
      `systemctl --user ${args[0]} 失败；请确认当前用户可访问 systemd 用户服务，并用 tellrun logs 查看启动错误。不支持用户服务的环境可用 tellrun run 前台运行。`,
    );
  }
}

/** CLI 与配置向导共用后台生命周期；不加载运行状态或 Telegram 业务入口。 */
export async function manageService(
  action: "start" | "stop" | "restart" | "status" | "logs" | "uninstall",
  options: { enable?: boolean; follow?: boolean } = {},
) {
  if (action === "status") {
    console.log(
      `配置：${join(appDirectory, "config.json")}\n状态：${join(appDirectory, "state.json")}`,
    );
  }
  if (process.platform !== "linux") {
    throw new Error("后台管理需要 Linux systemd 用户服务；当前系统可运行 tellrun run。");
  }

  if (action === "logs") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "journalctl",
        [
          "--user",
          "--unit",
          unit,
          "--lines",
          "100",
          "--no-pager",
          ...(options.follow ? ["--follow"] : []),
        ],
        { stdio: "inherit" },
      );
      child.on("error", () =>
        reject(new Error("无法启动 journalctl，请检查 systemd 是否已安装。")),
      );
      child.on("close", (code, signal) => {
        if (code === 0 || signal === "SIGINT") resolve();
        else reject(new Error("读取日志失败，请检查当前用户的 journal 访问权限。"));
      });
    });
    return;
  }

  const state = Object.fromEntries(
    (
      await systemctl(
        "show",
        unit,
        "--property=LoadState,ActiveState,SubState,MainPID,UnitFileState",
      )
    )
      .split("\n")
      .map((line) => line.split("=")),
  );
  if (action === "status") {
    if (state.LoadState === "not-found")
      console.log("后台服务尚未安装，请运行 tellrun setup 或 start。");
    else
      console.log(
        `服务：${state.ActiveState} / ${state.SubState}\nPID：${state.MainPID}\n自启状态：${state.UnitFileState}`,
      );
    return;
  }

  if (action === "stop" || action === "uninstall") {
    if (state.LoadState !== "not-found") await systemctl("stop", unit);
    if (action === "uninstall") {
      if (state.LoadState !== "not-found") await systemctl("disable", unit);
      rmSync(join(appDirectory, unit), { force: true });
      await systemctl("daemon-reload");
      console.log("后台服务已卸载，配置和状态文件已保留；用户 linger 设置保持不变。");
    } else console.log("后台服务已停止。");
    return;
  }

  /** 服务不能依赖当前终端临时提供的凭据或相对 Codex 路径。 */
  const config = loadConfig({});
  if (!isAbsolute(config.codexPath) || !existsSync(config.codexPath)) {
    throw new Error("后台运行需要有效的 Codex 绝对路径，请重新运行 tellrun setup。");
  }
  const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (!existsSync(entry))
    throw new Error("后台服务需要编译产物，请先 npm run build，再运行 dist/cli.js。");

  /** linger 保证退出 SSH 后用户服务管理器仍然存活；失败时不宣称后台设置成功。 */
  try {
    let linger = await promisify(execFile)(
      "loginctl",
      ["show-user", String(process.getuid?.()), "--property=Linger", "--value"],
      { timeout: 5_000 },
    );
    if (linger.stdout.trim() !== "yes") {
      await promisify(execFile)("loginctl", ["enable-linger", String(process.getuid?.())], {
        timeout: 15_000,
      });
      linger = await promisify(execFile)(
        "loginctl",
        ["show-user", String(process.getuid?.()), "--property=Linger", "--value"],
        { timeout: 5_000 },
      );
      if (linger.stdout.trim() !== "yes") throw new Error("linger 未启用");
    }
  } catch {
    throw new Error(
      `无法启用退出 SSH 后持续运行；请在服务器执行 sudo loginctl enable-linger ${process.getuid?.()}，然后重试 tellrun ${action}。配置已保留。`,
    );
  }

  mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
  chmodSync(appDirectory, 0o700);
  const temporary = join(appDirectory, `${unit}.${process.pid}.tmp`);
  try {
    /** 引号保留路径中的空格，转义 %，并用 : 禁止 systemd 对 $ 做变量展开。 */
    writeFileSync(
      temporary,
      [
        "[Unit]",
        "Description=Tellrun",
        "StartLimitIntervalSec=60",
        "StartLimitBurst=5",
        "",
        "[Service]",
        "Type=notify",
        "NotifyAccess=all",
        `ExecStart=${[`:${process.execPath}`, entry, "run"].map((value) => JSON.stringify(value.replaceAll("%", "%%"))).join(" ")}`,
        "WorkingDirectory=%h",
        "UMask=0077",
        "Restart=on-failure",
        "RestartSec=5",
        "KillMode=control-group",
        "TimeoutStartSec=60",
        "TimeoutStopSec=45",
        "StandardOutput=journal",
        "StandardError=journal",
        "SyslogIdentifier=tellrun",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, join(appDirectory, unit));
  } finally {
    rmSync(temporary, { force: true });
  }
  await systemctl("link", join(appDirectory, unit));
  await systemctl("daemon-reload");
  if (options.enable) await systemctl("enable", join(appDirectory, unit));
  await systemctl("reset-failed", unit);
  await systemctl(action, unit);
  if ((await systemctl("is-active", unit)) !== "active") {
    throw new Error("后台服务未能保持运行，请用 tellrun logs 查看原因。");
  }
  console.log(action === "restart" ? "后台服务已重启。" : "后台服务已启动。");
  if (options.enable) console.log("已启用开机自启。");
  console.log("退出 SSH 后服务会继续运行；可用 tellrun status / logs 查看状态与日志。");
}
