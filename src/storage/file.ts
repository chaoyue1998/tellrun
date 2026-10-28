import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 配置和状态共用原子写入：同目录临时文件写完整并刷盘后，再替换目标文件。 */
export function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      descriptor = openSync(dirname(path), "r");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
