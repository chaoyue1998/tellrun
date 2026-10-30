import type { AgentAttachment } from "../core/types.js";

/** 图片使用原生视觉输入；其他附件提供本地路径，由 Codex 按用户要求读取。 */
export function createCodexInput(prompt: string, attachments: AgentAttachment[] = []) {
  const text = attachments.length
    ? [
        prompt.trim() ||
          "用户上传了附件。请结合当前对话查看；如果没有明确任务，简要说明附件内容并询问用户希望如何处理。",
        "用户上传的本地附件：",
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
      .map((attachment) => ({ type: "localImage" as const, path: attachment.path })),
  ];
}
