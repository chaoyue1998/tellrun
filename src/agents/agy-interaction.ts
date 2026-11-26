import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentInteraction } from "../core/types.js";

/** ACP session/request_permission 的最小边界校验。 */
const permissionRequestSchema = z.object({
  sessionId: z.string().min(1),
  toolCall: z
    .object({
      toolCallId: z.string().optional(),
      name: z.string().optional(),
      title: z.string().optional(),
      kind: z.string().optional(),
      args: z.record(z.string(), z.unknown()).optional(),
      rawInput: z.unknown().optional(),
    })
    .optional(),
  options: z
    .array(
      z.object({
        optionId: z.string().min(1),
        name: z.string(),
        kind: z.string().optional(),
      }),
    )
    .min(1),
});

/** ACP 审批应答载荷；rejected 标记用于区分拒绝与取消。 */
export interface AgyApprovalResponse {
  result: { outcome: { outcome: "selected"; optionId: string } };
  rejected: boolean;
}

/** 格式化工具参数摘要，控制展示体积，避免超长载荷阻塞 IM 投递。 */
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
        lines.push(
          serialized.length > 2_000 ? `${serialized.slice(0, 2_000)}\n…(truncated)` : serialized,
        );
      }
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
      rejected: Boolean(option.kind?.includes("reject")),
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
