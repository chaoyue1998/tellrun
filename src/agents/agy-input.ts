import { readFileSync } from "node:fs";
import type { AgentAttachment } from "../core/types.js";

/** ACP 内容块；图片通过内联 Base64 传入，其他附件保留本地路径说明。 */
export type AgyContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** 按文件头识别常见图片格式，不依赖扩展名。 */
function detectImageMimeType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii").startsWith("GIF8"))
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

/** 将文本与本地附件转换为 ACP session/prompt 内容块。 */
export function createAgyInput(
  prompt: string,
  attachments: AgentAttachment[] = [],
): AgyContentBlock[] {
  const text = attachments.length
    ? [
        prompt.trim() || "Files:",
        ...attachments.map(
          (attachment) =>
            `- ${JSON.stringify(attachment.name)} (${attachment.kind}): ${JSON.stringify(attachment.path)}`,
        ),
      ].join("\n")
    : prompt;
  const blocks: AgyContentBlock[] = [{ type: "text", text }];
  for (const attachment of attachments) {
    if (attachment.kind !== "image") continue;
    try {
      const bytes = readFileSync(attachment.path);
      const mimeType = detectImageMimeType(bytes);
      if (mimeType) blocks.push({ type: "image", data: bytes.toString("base64"), mimeType });
    } catch {
      /** 图片不可读时保留正文中的本地路径，交由 Agent 按需提示。 */
    }
  }
  return blocks;
}
