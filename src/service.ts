import { join } from "node:path";
import { appDirectory } from "./config.js";
import { manageLaunchdService } from "./launchd.js";
import { manageSystemdService } from "./systemd.js";

/** CLI 与两个系统服务后端共用的操作。 */
export type ServiceAction = "start" | "stop" | "restart" | "status" | "logs" | "uninstall";

/** enable 在 Linux 表示开机启动，在 macOS 表示登录时启动。 */
export type ServiceOptions = { enable?: boolean; follow?: boolean };

/** 按当前系统选择后台管理器，不加载任务状态或消息连接。 */
export async function manageService(action: ServiceAction, options: ServiceOptions = {}) {
  if (action === "status")
    console.log(
      `Config: ${join(appDirectory, "config.json")}\nState: ${join(appDirectory, "state.json")}`,
    );
  if (process.platform === "darwin") return manageLaunchdService(action, options);
  if (process.platform === "linux") return manageSystemdService(action, options);
  throw new Error("Background mode requires Linux or macOS. Use tellrun run instead.");
}
