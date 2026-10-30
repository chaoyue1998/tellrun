import { readFileSync } from "node:fs";
import { Agent, get } from "node:https";
import { fileURLToPath } from "node:url";
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
/** 成功缓存一小时，失败一分钟后允许重试，均只保存在内存中。 */
const cacheDurationMs = { success: 60 * 60_000, failure: 60_000 };
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

/** 状态查询共享缓存与在途请求；使用服务退出信号取消网络检查，不阻止正常使用。 */
export function createUpdateChecker(proxyUrl?: string) {
  let cached: { latest: string; available: boolean } | undefined;
  let nextCheckAt = 0;
  let pending: Promise<typeof cached> | undefined;

  return {
    version: tellrunVersion,
    /** 把当前实例和有效缓存交给 Agent 核对；只生成任务说明，不在消息服务中执行升级。 */
    upgradePrompt() {
      return [
        "请检查并升级当前运行的 Tellrun，目标是 npm latest 指向的最新正式版本。",
        `当前运行版本：${tellrunVersion}`,
        `Tellrun 安装目录：${JSON.stringify(fileURLToPath(new URL("../", import.meta.url)))}`,
        `运行 Tellrun 的 Node.js：${JSON.stringify(process.execPath)}`,
        ...(cached && Date.now() < nextCheckAt
          ? [`最近检查到的 npm latest 版本：${cached.latest}；执行前重新核对。`]
          : []),
        "先确认实际安装位置、服务启动方式、最新正式版本及 Node.js 兼容性；没有更新的正式版时只报告检查结果，不降级。",
        "npm 全局安装的升级流程是 tellrun stop、npm install -g tellrun@<核对后的版本>、tellrun restart；使用当前实例对应的 Node.js/npm 和安装前缀。其他安装方式按实际部署处理，保留未提交改动。",
        "请实际完成升级，沿用当前权限与审批流程。仅升级 Tellrun，保留用户配置、会话和任务状态，不改动无关项目或升级 Codex、Node.js。",
        "当前任务由独立的 Codex 后台执行，Tellrun 重启后可重新连接；保持 Codex 后台运行。",
        "停服前准备好安装、重启及失败恢复的完整步骤，并完成所需审批，避免停服后还要通过 Telegram 请求审批。如果无法安排服务恢复，保持服务在线并说明阻碍。",
        "完成后核对安装版本、服务状态与 Telegram 连接，报告升级前后版本和验证结果；失败时说明原因及恢复情况。",
      ].join("\n");
    },
    /** 成功返回版本信息；失败或取消返回空值，不能把检查失败显示为已是最新版。 */
    check(signal: AbortSignal): Promise<typeof cached> {
      if (signal.aborted) return Promise.resolve(undefined);
      if (pending) return pending;
      if (Date.now() < nextCheckAt) return Promise.resolve(cached);
      pending = (async () => {
        try {
          const latest = await readLatestRelease(
            proxyUrl,
            AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
          );
          if (signal.aborted) return undefined;
          cached = { latest, available: isNewerRelease(latest) };
          nextCheckAt = Date.now() + cacheDurationMs.success;
          return cached;
        } catch {
          if (!signal.aborted) {
            cached = undefined;
            nextCheckAt = Date.now() + cacheDurationMs.failure;
          }
          return undefined;
        } finally {
          pending = undefined;
        }
      })();
      return pending;
    },
  };
}

/** 核心层只依赖版本与检查接口，不负责网络传输。 */
export type UpdateChecker = ReturnType<typeof createUpdateChecker>;
