import type { AgentAttachment } from "../core/types.js";

/** 图片使用原生视觉输入；其他附件提供本地路径，由 Codex 按用户要求读取。 */
export function createCodexInput(
  prompt: string,
  attachments: AgentAttachment[] = [],
) {
  const text = attachments.length
    ? [
        prompt.trim() || "files：",
        ...attachments.map(
          (attachment) =>
            `- ${JSON.stringify(attachment.name)} (${attachment.kind}): ${JSON.stringify(attachment.path)}`,
        ),
      ].join("\n")
    : prompt;
  return [
    { type: "text" as const, text, text_elements: [] },
    ...attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({
        type: "localImage" as const,
        path: attachment.path,
      })),
  ];
}
