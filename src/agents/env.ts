import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

let shellEnvPromise: Promise<NodeJS.ProcessEnv | null> | undefined;

/** 系统服务下仅读取一次用户登录 shell 环境，供多个 Agent 并发初始化复用。 */
function readUserShellEnv(): Promise<NodeJS.ProcessEnv | null> {
  shellEnvPromise ??= promisify(execFile)(
    userInfo().shell || process.env.SHELL || "/bin/sh",
    [
      "-ilc",
      /** Node 路径按 shell 字面量转义；NUL 分隔启动欢迎文字和环境 JSON。 */
      `exec '${process.execPath.replaceAll("'", "'\\''")}' -e 'process.stdout.write("\\0" + JSON.stringify(process.env))'`,
    ],
    { cwd: homedir(), timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1_048_576 },
  )
    .then(({ stdout }) => {
      if (!stdout.includes("\0")) throw new Error("Missing shell environment.");
      return z
        .record(z.string(), z.string())
        .parse(JSON.parse(stdout.slice(stdout.lastIndexOf("\0") + 1)));
    })
    .catch(() => null);
  return shellEnvPromise;
}

/** 为 Agent 子进程构造环境变量；系统服务下补读用户登录 shell 配置，并剥离 Tellrun 私有变量。 */
export async function loadAgentEnv(agentName: string): Promise<{
  env: NodeJS.ProcessEnv;
  unavailableReason?: string;
}> {
  /** 前台保留当前终端的临时 export；仅系统服务需要补读用户 shell 配置。 */
  let env: NodeJS.ProcessEnv = process.env;
  let unavailableReason: string | undefined;
  if (
    process.platform !== "win32" &&
    (process.env.NOTIFY_SOCKET || process.env.TELLRUN_LAUNCHD === "1")
  ) {
    const loaded = await readUserShellEnv();
    if (loaded) {
      env = loaded;
    } else {
      /** 不回传可能含凭据的启动输出，也不回退到缺少代理的服务环境。 */
      unavailableReason = `${agentName} is unavailable: failed to load the user shell environment. Check your shell startup scripts for errors or prompts, then send /restart.`;
    }
  }
  /** 保留 provider 和工具环境，移除 Tellrun 配置及宿主服务通知标识。 */
  env = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(TELEGRAM_|TELLRUN_|CODEX_PATH$|AGY_PATH$|NOTIFY_SOCKET$|INVOCATION_ID$)/.test(key),
    ),
  );
  /** 优先使用用户 PATH 中的 Node；当前运行时仅作为 npm 版 CLI 的后备路径。 */
  env.PATH = [env.PATH, dirname(process.execPath)].filter(Boolean).join(delimiter);
  return unavailableReason ? { env, unavailableReason } : { env };
}
