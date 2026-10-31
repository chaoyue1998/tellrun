import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appDirectory } from "../config.js";
import { type State, stateSchema } from "../core/schema.js";
import { writeJson } from "./json.js";
import { acquireLock } from "./lock.js";

/** 取得单实例锁并加载文件；缺失时交由核心层创建初始业务状态。 */
export function openStore(path = join(appDirectory, "state.json")) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (dirname(path) === appDirectory) chmodSync(appDirectory, 0o700);
  const release = acquireLock(path);
  let usable = true;

  try {
    let initialState: State | undefined;
    try {
      const contents = readFileSync(path, "utf8");
      try {
        initialState = stateSchema.parse(JSON.parse(contents));
      } catch {
        throw new Error("Invalid state.json; file unchanged. Check it or restore a backup.");
      }
      chmodSync(path, 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    return {
      initialState,
      /** 校验后原子替换完整快照；写入失败后拒绝继续保存，避免内存与文件分歧。 */
      save(state: State) {
        if (!usable) throw new Error("State storage unavailable. Restart the service.");
        state = stateSchema.parse(state);
        try {
          writeJson(path, state);
        } catch (error) {
          usable = false;
          throw Object.assign(
            new Error("Cannot save state. Check disk space and permissions.", { cause: error }),
            { code: "STATE_WRITE_FAILED" },
          );
        }
      },
      /** 由组装入口等待业务循环退出后释放锁，核心层不管理文件生命周期。 */
      close() {
        usable = false;
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** 文件生命周期接口，不包含任务、交互或消息操作。 */
export type Store = ReturnType<typeof openStore>;
