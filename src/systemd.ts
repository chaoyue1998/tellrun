import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appDirectory, loadConfig } from "./config.js";
import type { ServiceAction, ServiceOptions } from "./service.js";

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
      `Service ${args[0]} failed. Check tellrun logs or systemctl --user status ${unit} --no-pager -l. Without systemd, use tellrun run.`,
    );
  }
}

/** CLI 与配置向导共用后台生命周期；不加载运行状态或 Telegram 业务入口。 */
export async function manageSystemdService(action: ServiceAction, options: ServiceOptions) {
  /** 系统未运行 systemd 且没有服务定义或注册链接时，卸载无需连接服务管理器。 */
  if (action === "uninstall" && !existsSync("/run/systemd/system")) {
    const userUnits = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "systemd",
      "user",
    );
    const serviceFiles = [
      join(appDirectory, unit),
      join(userUnits, unit),
      join(userUnits, "default.target.wants", unit),
    ];
    /** lstat 同时检查失效链接，避免把残留的自启入口当作从未安装。 */
    if (!serviceFiles.some((path) => lstatSync(path, { throwIfNoEntry: false }))) {
      console.log("No systemd service installed.");
      return;
    }
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
        reject(new Error("Cannot start journalctl. Check your systemd installation.")),
      );
      child.on("close", (code, signal) => {
        if (code === 0 || signal === "SIGINT") resolve();
        else reject(new Error("Cannot read logs. Check journal access permissions."));
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
      console.log("Service not installed. Run tellrun setup or tellrun start.");
    else
      console.log(
        `Service: ${state.ActiveState} / ${state.SubState}\nPID: ${state.MainPID}\nAt boot: ${state.UnitFileState}`,
      );
    return;
  }

  if (action === "stop" || action === "uninstall") {
    if (state.LoadState !== "not-found") await systemctl("stop", unit);
    if (action === "uninstall") {
      if (state.LoadState !== "not-found") await systemctl("disable", unit);
      rmSync(join(appDirectory, unit), { force: true });
      await systemctl("daemon-reload");
      console.log("Service removed. Config, state, and user linger unchanged.");
    } else console.log("Service stopped.");
    return;
  }

  /** 服务不能依赖当前终端临时提供的凭据或相对 Codex 路径。 */
  const config = loadConfig({});
  if (!isAbsolute(config.codexPath) || !existsSync(config.codexPath)) {
    throw new Error("Background mode needs an absolute Codex path. Run tellrun setup.");
  }
  const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (!existsSync(entry))
    throw new Error("CLI build missing. Run npm run build, then node dist/cli.js.");

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
      if (linger.stdout.trim() !== "yes") throw new Error("User lingering is disabled.");
    }
  } catch {
    throw new Error(
      `Enable lingering with sudo loginctl enable-linger ${process.getuid?.()}, then retry tellrun ${action}. Config unchanged.`,
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
    throw new Error("Service failed to stay running. Check tellrun logs.");
  }
  console.log(action === "restart" ? "Service restarted." : "Service started.");
  if (options.enable) console.log("Enabled at boot.");
  console.log(
    "Service will keep running after SSH disconnects. Use tellrun status or tellrun logs.",
  );
}
