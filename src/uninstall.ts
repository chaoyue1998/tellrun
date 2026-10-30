import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import which from "which";
import { appDirectory } from "./config.js";
import { manageService } from "./service.js";

/** 先移除后台服务，再从当前安装前缀卸载 npm 包；用户数据始终保留。 */
export async function uninstall() {
  const packageDirectory = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  const prefix = dirname(dirname(dirname(packageDirectory)));
  /** Linux、macOS 的 npm 全局包固定放在 <prefix>/lib/node_modules 下。 */
  if (packageDirectory !== join(prefix, "lib", "node_modules", "tellrun")) {
    throw new Error("This command requires a global npm install.");
  }

  /** 优先使用当前 Node.js 附带的 npm，并让 npm 的 shebang 使用同一 Node.js。 */
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  };
  const npm = await which("npm", { path: env.PATH, nothrow: true });
  if (!npm) throw new Error("npm not found. Install npm, then run tellrun uninstall again.");

  /** 显式指定前缀并核对真实包路径，避免受终端或 npm 配置影响而卸载其他安装。 */
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

  await manageService("uninstall");
  try {
    await promisify(execFile)(npm, ["uninstall", "--global", "--prefix", prefix, "tellrun"], {
      cwd: prefix,
      env,
      timeout: 120_000,
    });
    if (existsSync(packageDirectory)) throw new Error("npm package still exists.");
  } catch {
    throw new Error(
      `Service removed, but npm uninstall failed. Check permissions and retry tellrun uninstall.\nInstall prefix: ${prefix}\nData kept at: ${appDirectory}`,
    );
  }
  console.log("Tellrun service and npm package removed.");
  console.log(`Data kept at ${appDirectory}. Delete this folder yourself if no longer needed.`);
}
