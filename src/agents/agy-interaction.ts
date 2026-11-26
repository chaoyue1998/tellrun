import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentInteraction } from "../core/types.js";

const toolCallContentItemSchema = z.union([
  z.object({
    type: z.literal("diff"),
    path: z.string().min(1),
    oldText: z.string().nullish(),
    newText: z.string(),
  }),
  z.object({
    type: z.literal("content"),
    content: z.object({
      type: z.string(),
      text: z.string().nullish(),
    }),
  }),
]);

/** ACP session/request_permission 的最小边界校验（对齐官方 ToolCallUpdate）。 */
const permissionRequestSchema = z.object({
  sessionId: z.string().min(1),
  toolCall: z
    .object({
      toolCallId: z.string().nullish(),
      name: z.string().nullish(),
      title: z.string().nullish(),
      kind: z.string().nullish(),
      locations: z
        .array(
          z.object({
            path: z.string().min(1),
            line: z.number().int().nonnegative().nullish(),
          }),
        )
        .nullish(),
      content: z.array(z.unknown()).nullish(),
      args: z.record(z.string(), z.unknown()).nullish(),
      rawInput: z.unknown().optional(),
    })
    .nullish(),
  options: z
    .array(
      z.object({
        optionId: z.string().min(1),
        name: z.string(),
        kind: z.string().nullish(),
      }),
    )
    .min(1),
});

/** ACP 审批应答载荷。 */
export interface AgyApprovalResponse {
  result: { outcome: { outcome: "selected"; optionId: string } };
}

/** 截断超长文本，避免审批载荷超过 IM 单条消息上限。 */
function truncateText(text: string, limit = 2_000) {
  return text.length > limit ? `${text.slice(0, limit)}\n…(truncated)` : text;
}

/** 格式化工具参数、受影响位置与官方 ToolCallUpdate 内容预览（diff / text）。 */
function formatToolDetails(
  toolCall: z.infer<typeof permissionRequestSchema>["toolCall"],
  cwd: string,
) {
  if (!toolCall) return `Directory: ${cwd}\nPermission requested.`;
  const lines: string[] = [];
  const heading = [toolCall.kind, toolCall.name].filter(Boolean).join(" · ");
  if (heading) lines.push(heading);
  lines.push(`Directory: ${cwd}`);
  if (toolCall.title) lines.push(toolCall.title);
  if (toolCall.locations?.length) {
    const paths = toolCall.locations.map((loc) =>
      loc.line != null ? `${loc.path}:${loc.line}` : loc.path,
    );
    lines.push(`Files: ${paths.join(", ")}`);
  }
  const input =
    toolCall.args && Object.keys(toolCall.args).length > 0 ? toolCall.args : toolCall.rawInput;
  if (input !== undefined && input !== null) {
    const command =
      typeof input === "object" && "CommandLine" in input && typeof input.CommandLine === "string"
        ? input.CommandLine
        : typeof input === "object" && "command" in input && typeof input.command === "string"
          ? input.command
          : undefined;
    if (command) {
      if (command !== toolCall.title) lines.push(`Command: ${command}`);
    } else {
      const serialized = typeof input === "string" ? input : JSON.stringify(input, null, 2);
      if (serialized && serialized !== "{}") {
        lines.push(truncateText(serialized));
      }
    }
  }
  if (toolCall.content?.length) {
    const previews: string[] = [];
    for (const rawItem of toolCall.content) {
      const parsed = toolCallContentItemSchema.safeParse(rawItem);
      if (!parsed.success) continue;
      if (parsed.data.type === "diff") {
        const parts = [`Diff: ${parsed.data.path}`];
        if (parsed.data.oldText != null) {
          parts.push(`--- old\n${truncateText(parsed.data.oldText, 800)}`);
        }
        parts.push(`+++ new\n${truncateText(parsed.data.newText, 800)}`);
        previews.push(parts.join("\n"));
      } else if (parsed.data.content.type === "text" && parsed.data.content.text) {
        previews.push(truncateText(parsed.data.content.text, 1_000));
      }
    }
    if (previews.length) {
      lines.push(truncateText(previews.join("\n\n"), 2_000));
    }
  }
  return lines.join("\n");
}

/** 将 ACP 审批请求转换为核心层通用交互；未知请求明确拒绝而非悄悄放行。 */
export function parseAgyInteraction(
  method: string,
  params: unknown,
  cwd: string,
):
  | {
      sessionId: string;
      request: AgentInteraction;
      approvals: Map<string, AgyApprovalResponse>;
    }
  | { error: string; unsupported?: true } {
  if (method !== "session/request_permission") {
    return {
      error: "Unsupported request. Handle locally before sending a new message.",
      unsupported: true,
    };
  }
  const parsed = permissionRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { error: "Invalid permission request from Antigravity." };
  }
  const interaction: AgentInteraction = {
    id: randomUUID(),
    kind: "approval",
    text: formatToolDetails(parsed.data.toolCall, cwd),
    expiresAt: null,
    blocking: true,
    choices: [],
    questions: [],
  };
  const approvals = new Map<string, AgyApprovalResponse>();
  for (const option of parsed.data.options) {
    if (approvals.has(option.optionId)) continue;
    interaction.choices.push({ id: option.optionId, label: option.name || option.optionId });
    approvals.set(option.optionId, {
      result: { outcome: { outcome: "selected", optionId: option.optionId } },
    });
  }
  if (!interaction.choices.length) {
    return { error: "No supported approval options. Handle locally before sending a new message." };
  }
  if (JSON.stringify(interaction).length > 64_000) {
    return { error: "Request too large. Handle locally before sending a new message." };
  }
  return { sessionId: parsed.data.sessionId, request: interaction, approvals };
}
