import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { Agent, get } from "node:https";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import which from "which";
import { z } from "zod";

/** 启动时读取本包版本，避免运行中安装新包后误报进程已经升级。 */
export const tellrunVersion = z
  .string()
  .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);

/** 仅查询 npm 的发布标签，不下载或安装包。 */
const registryUrl = "https://registry.npmjs.org/-/package/tellrun/dist-tags";
/** 正式版本逐段比较；严格校验后才能用于版本提示和升级任务。 */
const releaseVersion = z
  .string()
  .max(128)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
/** 总时限包含 DNS、连接与响应体读取，避免慢网络拖住状态查询。 */
const requestTimeoutMs = 3_000;
/** 标签响应很小，限制响应体大小，避免异常服务返回无限内容。 */
const responseLimitBytes = 16_384;

/** 忽略构建元数据；同版本的正式版高于本地预发布版，不建议降级。 */
function isNewerRelease(latest: string) {
  const [current, prerelease] = (tellrunVersion.split("+")[0] ?? "").split("-");
  const installed = releaseVersion.parse(current).split(".").map(BigInt);
  const published = releaseVersion.parse(latest).split(".").map(BigInt);
  for (const [index, part] of published.entries()) {
    const previous = installed[index];
    if (previous !== undefined && part !== previous) return part > previous;
  }
  return prerelease !== undefined;
}

/** 沿用 Telegram 的代理选择；请求结束即释放连接，不记录原始网络错误或凭据。 */
async function readLatestRelease(proxyUrl: string | undefined, signal: AbortSignal) {
  const agent = new Agent({
    proxyEnv:
      proxyUrl === undefined
        ? process.env
        : proxyUrl
          ? { ...process.env, https_proxy: proxyUrl }
          : {},
  });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = get(
        registryUrl,
        { agent, signal, headers: { accept: "application/json" } },
        (response) => {
          response.on("error", reject);
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error("Update check failed."));
            return;
          }
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            text += chunk;
            if (Buffer.byteLength(text) > responseLimitBytes)
              request.destroy(new Error("Update response too large."));
          });
          response.on("end", () => resolve(text));
        },
      );
      request.on("error", reject);
    });
    return z.object({ latest: releaseVersion }).parse(JSON.parse(body)).latest;
  } finally {
    agent.destroy();
  }
}

/** 程序自升级结果：区分已是最新、升级完成和可展示给用户的安全失败诊断。 */
export type UpgradeOutcome =
  | { status: "up-to-date"; current: string }
  | { status: "updated"; previous: string; current: string }
  | { status: "failed"; message: string };

const execFileAsync = promisify(execFile);

/** 构造 npm 子进程环境：绑定当前 Node.js 所在目录，复用代理配置并剥离 Telegram 凭据。 */
function buildNpmEnv(proxyUrl: string | undefined, execPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(TELEGRAM_|TELLRUN_|NOTIFY_SOCKET$|INVOCATION_ID$)/.test(key),
    ),
  );
  env.PATH = [dirname(execPath), env.PATH].filter(Boolean).join(delimiter);
  if (proxyUrl === "") {
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  } else if (proxyUrl) {
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
  }
  return env;
}

/** 从安装目录解析 npm 全局前缀；源码或本地开发安装返回 undefined。 */
function resolveGlobalNpmPrefix(packageDirectory: string, platform = process.platform) {
  if (platform === "win32") {
    const prefix = dirname(dirname(packageDirectory));
    return packageDirectory === join(prefix, "node_modules", "tellrun") ? prefix : undefined;
  }
  const prefix = dirname(dirname(dirname(packageDirectory)));
  return packageDirectory === join(prefix, "lib", "node_modules", "tellrun") ? prefix : undefined;
}

/** 每次状态查询直接检查 npm，并由程序自身执行全局包升级与校验，不依赖外部 Coding Agent。 */
export function createUpdateChecker(
  proxyUrl?: string,
  runtime?: {
    version?: string;
    packageDirectory?: string;
    execPath?: string;
    platform?: NodeJS.Platform;
    checkLatest?: (
      signal: AbortSignal,
    ) => Promise<{ latest: string; available: boolean } | undefined>;
    findNpm?: (pathEnv: string | undefined) => Promise<string | null>;
    runCommand?: (
      file: string,
      args: string[],
      options: {
        cwd?: string;
        env: NodeJS.ProcessEnv;
        timeout: number;
        maxBuffer: number;
        signal: AbortSignal;
      },
    ) => Promise<{ stdout: string; stderr: string }>;
  },
) {
  const currentVersion = runtime?.version ?? tellrunVersion;
  const execPath = runtime?.execPath ?? process.execPath;
  const platform = runtime?.platform ?? process.platform;
  const runCommand =
    runtime?.runCommand ??
    ((file, args, options) => execFileAsync(file, args, { ...options, encoding: "utf8" }));
  const findNpm =
    runtime?.findNpm ??
    ((pathEnv) => which("npm", { ...(pathEnv ? { path: pathEnv } : {}), nothrow: true }));

  /** 成功返回版本信息；失败或取消返回空值，不能把检查失败显示为已是最新版。 */
  async function check(signal: AbortSignal) {
    if (signal.aborted) return undefined;
    if (runtime?.checkLatest) return runtime.checkLatest(signal);
    try {
      const latest = await readLatestRelease(
        proxyUrl,
        AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
      );
      if (signal.aborted) return undefined;
      return { latest, available: isNewerRelease(latest) };
    } catch {
      return undefined;
    }
  }

  /** 校验全局 npm 安装位置、安装最新正式版并执行新二进制冒烟验证，不中断当前进程直到验证通过。 */
  async function upgrade(
    signal: AbortSignal,
    callbacks?: { onDownloading?: (previous: string, latest: string) => void },
  ): Promise<UpgradeOutcome> {
    if (signal.aborted) return { status: "failed", message: "Update cancelled." };
    const update = await check(signal);
    if (signal.aborted) return { status: "failed", message: "Update cancelled." };
    if (!update) {
      return {
        status: "failed",
        message: "Update check unavailable. Check network or proxy, then retry /update.",
      };
    }
    if (!update.available) {
      return { status: "up-to-date", current: currentVersion };
    }

    let packageDirectory: string;
    try {
      packageDirectory = realpathSync(
        runtime?.packageDirectory ?? fileURLToPath(new URL("../", import.meta.url)),
      );
    } catch {
      return {
        status: "failed",
        message: "Cannot resolve Tellrun install directory. Update Tellrun manually in a terminal.",
      };
    }

    const prefix = resolveGlobalNpmPrefix(packageDirectory, platform);
    if (!prefix) {
      return {
        status: "failed",
        message: `Update available (${currentVersion} → ${update.latest}), but Tellrun is running from a source or local installation (${packageDirectory}). Update it manually, then send /restart.`,
      };
    }

    const npmEnv = buildNpmEnv(proxyUrl, execPath);
    const npm = await findNpm(npmEnv.PATH);
    if (!npm) {
      return {
        status: "failed",
        message: "npm not found in PATH. Update Tellrun manually in a terminal.",
      };
    }

    /** 安装前核对真实 npm 全局根路径，避免覆盖或安装到错误前缀。 */
    try {
      const { stdout } = await runCommand(npm, ["root", "--global", "--prefix", prefix], {
        env: npmEnv,
        timeout: 15_000,
        maxBuffer: 65_536,
        signal,
      });
      if (realpathSync(join(stdout.trim(), "tellrun")) !== packageDirectory) {
        throw new Error("Install path mismatch.");
      }
    } catch {
      if (signal.aborted) return { status: "failed", message: "Update cancelled." };
      return {
        status: "failed",
        message:
          "Cannot verify the npm global install path. Service kept running; update manually in a terminal.",
      };
    }

    callbacks?.onDownloading?.(currentVersion, update.latest);

    try {
      await runCommand(
        npm,
        [
          "install",
          "--global",
          "--prefix",
          prefix,
          "--no-audit",
          "--no-fund",
          "--loglevel=warn",
          "--color=false",
          `tellrun@${update.latest}`,
        ],
        {
          cwd: prefix,
          env: npmEnv,
          timeout: 180_000,
          maxBuffer: 4_194_304,
          signal,
        },
      );
    } catch {
      if (signal.aborted) return { status: "failed", message: "Update cancelled." };
      return {
        status: "failed",
        message: `Failed to install tellrun@${update.latest} via npm. Check network, permissions, and Node.js version; service kept running.`,
      };
    }

    /** 重启前核对磁盘上的新版本与新 CLI 入口可执行性，避免坏包导致重启离线。 */
    try {
      const installedVersion = z
        .string()
        .parse(JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")).version);
      if (installedVersion !== update.latest) {
        throw new Error("Installed version mismatch.");
      }
      const entry = join(packageDirectory, "dist", "cli.js");
      if (!existsSync(entry)) throw new Error("Missing dist/cli.js.");
      const { stdout } = await runCommand(execPath, [entry, "--version"], {
        env: npmEnv,
        timeout: 10_000,
        maxBuffer: 4_096,
        signal,
      });
      if (stdout.trim() !== update.latest) {
        throw new Error("CLI version check mismatch.");
      }
    } catch {
      if (signal.aborted) return { status: "failed", message: "Update cancelled." };
      return {
        status: "failed",
        message: `Installed tellrun@${update.latest}, but post-install verification failed. Service kept running; check the installation before restarting.`,
      };
    }

    return { status: "updated", previous: currentVersion, current: update.latest };
  }

  return {
    version: currentVersion,
    check,
    upgrade,
  };
}

/** 核心层只依赖版本与检查接口，不负责网络传输。 */
export type UpdateChecker = ReturnType<typeof createUpdateChecker>;
