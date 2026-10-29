import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** 取得状态文件的单实例锁，返回仅释放本实例所有权的函数。 */
export function acquireLock(path: string) {
  const lock = `${path}.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  let owned = false;

  /** 只删除本实例的所有权文件；非空目录不能被另一个退出中的实例移除。 */
  function release() {
    if (!owned) return;
    rmSync(join(lock, owner), { force: true });
    owned = false;
    try {
      rmdirSync(lock);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTEMPTY"].includes(String(error.code))
        )
      )
        throw error;
    }
  }

  try {
    /** mkdir 竞争唯一写入者；回收旧锁必须先确认 PID 已退出，再删除该所有权文件。 */
    for (let attempt = 0; attempt < 3 && !owned; attempt++) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        writeFileSync(join(lock, owner), "", { flag: "wx", mode: 0o600 });
        owned = true;
        if (readdirSync(lock).length !== 1) throw new Error("State lock busy. Try again.");
      } catch (error) {
        if (owned || !(error instanceof Error && "code" in error && error.code === "EEXIST"))
          throw error;
        try {
          const owners = readdirSync(lock);
          if (owners.length === 0 && Date.now() - statSync(lock).mtimeMs > 30_000) {
            rmdirSync(lock);
            continue;
          }
          const previous = owners.length === 1 ? owners[0] : undefined;
          const pid = previous?.match(/^([1-9]\d*)-[0-9a-f-]+$/)?.[1];
          if (!previous || !pid)
            throw new Error("State lock initializing or invalid. Check for another instance.");
          try {
            process.kill(Number(pid), 0);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
            /** 只有成功移除旧所有权文件的实例才能回收目录，避免竞争时删除新锁。 */
            unlinkSync(join(lock, previous));
            rmdirSync(lock);
            continue;
          }
          throw new Error("Another Tellrun instance is running. Stop it first.");
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              ["ENOENT", "ENOTEMPTY"].includes(String(error.code))
            )
          )
            throw error;
        }
      }
    }
    if (!owned) throw new Error("Cannot acquire state lock. Try again.");
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
