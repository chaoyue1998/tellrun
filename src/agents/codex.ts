import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** 检查 Codex CLI 可用性；任务执行和审批在完成 M0 协议验证后接入。 */
export async function inspectCodex() {
  const { stdout } = await promisify(execFile)("codex", ["--version"], {
    timeout: 5_000,
    maxBuffer: 4_096,
    /** 版本检查只传入基础运行环境，不继承 Telegram Token 等应用凭据。 */
    env: Object.fromEntries(
      ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
  });

  if (!/^codex-cli \S+$/.test(stdout.trim())) {
    throw new Error("Codex CLI 返回了无法识别的版本信息");
  }
  return { name: "Codex", version: stdout.trim().replace(/^codex-cli /, "") };
}
