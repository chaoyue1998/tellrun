import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import which from "which";
import { appDirectory } from "./config.js";
import { manageService } from "./service.js";

/** 统一移除后台服务；全局安装再卸载 npm 包，源码、本地依赖和用户数据保留。 */
export async function uninstall() {
  const packageDirectory = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  const prefix = dirname(dirname(dirname(packageDirectory)));
  /** Linux、macOS 的 npm 全局包固定放在 <prefix>/lib/node_modules 下。 */
  const globalInstall = packageDirectory === join(prefix, "lib", "node_modules", "tellrun");

  /** 优先使用当前 Node.js 附带的 npm，并让 npm 的 shebang 使用同一 Node.js。 */
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  };
  let npm: string | undefined;
  if (globalInstall) {
    const executable = await which("npm", { path: env.PATH, nothrow: true });
    if (!executable)
      throw new Error("npm not found. Install npm, then run tellrun uninstall again.");
    npm = executable;

    /** 全局安装先核对真实包路径；预检失败时不移除服务，也不卸载其他安装。 */
    try {
      const { stdout } = await promisify(execFile)(npm, ["root", "--global", "--prefix", prefix], {
        env,
        timeout: 10_000,
      });
      if (realpathSync(join(stdout.trim(), "tellrun")) !== packageDirectory)
        throw new Error("Install path mismatch.");
    } catch {
      throw new Error(
        "Cannot check the npm install path. Check npm settings and try again. Service and package unchanged.",
      );
    }
  }

  await manageService("uninstall");
  if (npm) {
    let stderr: string;
    try {
      /** 强制保留无颜色的警告，避免 silent 配置或 ANSI 转义掩盖 npm 清理失败。 */
      ({ stderr } = await promisify(execFile)(
        npm,
        [
          "uninstall",
          "--global",
          "--prefix",
          prefix,
          "--loglevel=warn",
          "--color=false",
          "tellrun",
        ],
        { cwd: prefix, env, timeout: 120_000 },
      ));
    } catch {
      throw new Error(
        `Service removed, but npm uninstall failed. Check permissions and retry with npm directly; the tellrun command may already be removed.\nInstall prefix: ${prefix}\nData kept at: ${appDirectory}`,
      );
    }
    /** npm 可能已将包改名为隐藏目录；清理警告不能被原目录消失掩盖。 */
    if (
      lstatSync(packageDirectory, { throwIfNoEntry: false }) ||
      /\bwarn\s+cleanup\b/i.test(stderr)
    ) {
      throw new Error(
        `Service removed, but npm package cleanup is incomplete. Check for remaining tellrun files, including hidden .tellrun-* entries, in ${dirname(packageDirectory)} and ${join(prefix, "bin")}.\nData kept at: ${appDirectory}`,
      );
    }
    console.log("Tellrun service and npm package removed.");
  } else {
    console.log(
      `Source or local installation kept at ${packageDirectory}. Remove it through your project or package manager if no longer needed.`,
    );
  }
  console.log(`Data kept at ${appDirectory}. Delete this folder yourself if no longer needed.`);
}
