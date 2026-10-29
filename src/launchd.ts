import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appDirectory, loadConfig } from "./config.js";
import type { ServiceAction, ServiceOptions } from "./service.js";
import { acquireLock } from "./storage/lock.js";

/** 当前用户的服务标识；登录入口只链接到本应用保存的定义。 */
const label = "io.github.chaoyue1998.tellrun";

/** 只把明确不存在的服务或登录域视为未加载，不转发原始系统错误。 */
async function launchctl(...args: string[]) {
  try {
    const { stdout } = await promisify(execFile)("/bin/launchctl", args, {
      timeout: 50_000,
      maxBuffer: 4_194_304,
    });
    return stdout;
  } catch (error) {
    if (
      args[0] === "print" &&
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      /Could not find (service|domain)/.test(error.stderr)
    )
      return undefined;
    throw new Error(`launchctl ${args[0]} failed. Check tellrun logs and your login session.`);
  }
}

/** 使用 GUI 登录域运行用户服务；退出终端不停止，注销用户后由 launchd 停止。 */
export async function manageLaunchdService(action: ServiceAction, options: ServiceOptions) {
  const domain = `gui/${process.getuid?.()}`;
  const target = `${domain}/${label}`;
  const plist = join(appDirectory, "tellrun.plist");
  const loginFile = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const readyFile = join(appDirectory, "launchd.ready");
  const logFile = join(appDirectory, "tellrun.log");

  if (action === "logs") {
    if (!existsSync(logFile)) {
      console.log("No service logs yet.");
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "/usr/bin/tail",
        ["-n", "100", ...(options.follow ? ["-F"] : []), logFile],
        {
          stdio: "inherit",
        },
      );
      child.on("error", () => reject(new Error("Cannot open service logs.")));
      child.on("close", (code, signal) => {
        if (code === 0 || signal === "SIGINT") resolve();
        else reject(new Error("Cannot read service logs. Check file permissions."));
      });
    });
    return;
  }

  /** 启停操作串行，避免并发重启删除另一进程刚写入的就绪标记。 */
  let release: (() => void) | undefined;
  if (action !== "status") {
    mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
    chmodSync(appDirectory, 0o700);
    try {
      release = acquireLock(join(appDirectory, "launchd"));
    } catch {
      throw new Error("Service command busy or storage unavailable. Check ~/.tellrun/ and retry.");
    }
  }
  try {
    let enabled = false;
    try {
      if (readlinkSync(loginFile) !== plist) throw new Error("Unrelated login item.");
      enabled = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw new Error(`Login item already exists. Check ${loginFile}.`);
    }
    const state = await launchctl("print", target);
    const pid = Number(state?.match(/^\tpid = (\d+)$/m)?.[1] ?? 0);

    /** 进程存在不代表连接成功；就绪标记必须属于 launchd 当前报告的 PID。 */
    function ready(currentPid: number) {
      if (!currentPid) return false;
      try {
        return readFileSync(readyFile, "utf8") === String(currentPid);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw new Error("Cannot read service readiness. Check ~/.tellrun/ permissions.");
      }
    }

    if (action === "status") {
      console.log(
        `Service: ${ready(pid) ? "running" : pid ? "starting" : state ? "waiting" : existsSync(plist) ? "stopped" : "not installed"}\nPID: ${pid}\nAt login: ${enabled ? "enabled" : "disabled"}\nLogs: ${logFile}`,
      );
      return;
    }

    /** bootout 阻止故障重启，再等待旧进程实际退出，确保重新启动时不会争抢状态锁。 */
    async function unload() {
      if (state) await launchctl("bootout", target);
      const deadline = Date.now() + 50_000;
      while (pid) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") break;
          throw new Error("Cannot confirm service exit. Check tellrun status.");
        }
        if (Date.now() >= deadline)
          throw new Error("Service did not stop in time. Check tellrun status and logs.");
        await setTimeout(100);
      }
      rmSync(readyFile, { force: true });
    }

    if (action === "stop" || action === "uninstall") {
      await unload();
      if (action === "uninstall") {
        if (enabled) rmSync(loginFile);
        rmSync(plist, { force: true });
        console.log("Service removed. Config, state, and logs kept.");
      } else console.log("Service stopped.");
      return;
    }

    const config = loadConfig({});
    if (!isAbsolute(config.codexPath) || !existsSync(config.codexPath))
      throw new Error("Background mode needs an absolute Codex path. Run tellrun setup.");
    const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
    if (!existsSync(entry))
      throw new Error("CLI build missing. Run npm run build, then node dist/cli.js.");
    if (!state && !(await launchctl("print", domain)))
      throw new Error("Log in to the Mac desktop, then retry. Or use tellrun run.");

    const temporary = `${plist}.${process.pid}.tmp`;
    try {
      /** 原生 plutil 转义 XML 路径；凭据留在 config.json，不写入参数或服务环境。 */
      writeFileSync(
        temporary,
        JSON.stringify({
          Label: label,
          ProgramArguments: [process.execPath, entry, "run"],
          WorkingDirectory: homedir(),
          EnvironmentVariables: {
            TELLRUN_LAUNCHD: "1",
            PATH: [
              dirname(process.execPath),
              dirname(config.codexPath),
              "/opt/homebrew/bin",
              "/usr/local/bin",
              "/usr/bin",
              "/bin",
              "/usr/sbin",
              "/sbin",
            ].join(":"),
          },
          RunAtLoad: true,
          KeepAlive: { SuccessfulExit: false },
          ThrottleInterval: 5,
          ExitTimeOut: 45,
          AbandonProcessGroup: false,
          Umask: 0o077,
          StandardOutPath: logFile,
          StandardErrorPath: logFile,
        }),
        { mode: 0o600, flag: "wx" },
      );
      await promisify(execFile)("/usr/bin/plutil", ["-convert", "xml1", temporary], {
        timeout: 5_000,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, plist);
    } finally {
      rmSync(temporary, { force: true });
    }
    writeFileSync(logFile, "", { mode: 0o600, flag: "a" });
    chmodSync(logFile, 0o600);
    if (options.enable && !enabled) {
      mkdirSync(dirname(loginFile), { recursive: true });
      symlinkSync(plist, loginFile);
      enabled = true;
    }
    await launchctl("enable", target);
    if (action === "restart" || !pid) {
      await unload();
      await launchctl("bootstrap", domain, plist);
    }

    /** 等待初始化只读取状态，提前释放控制锁，允许另一终端停止尚未就绪的服务。 */
    release?.();
    release = undefined;

    /** 最多等待一分钟初始化；旧标记或仅有 PID 都不能作为启动成功的依据。 */
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const current = await launchctl("print", target);
      if (!current) throw new Error("Service exited before it was ready. Check tellrun logs.");
      if (ready(Number(current.match(/^\tpid = (\d+)$/m)?.[1] ?? 0))) {
        console.log(action === "restart" ? "Service restarted." : "Service started.");
        console.log(
          `At login: ${enabled ? "enabled" : "disabled"}. Use tellrun status or tellrun logs.`,
        );
        return;
      }
      await setTimeout(250);
    }
    throw new Error("Service not ready. Check tellrun logs.");
  } finally {
    release?.();
  }
}
