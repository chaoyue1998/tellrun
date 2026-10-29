import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentInteraction } from "../core/types.js";

/** 文件事件与审批提示共用变更格式；审批前必须能展示实际路径与差异。 */
export const fileChangesSchema = z.array(
  z.object({
    path: z.string(),
    kind: z.object({ type: z.enum(["add", "delete", "update"]), move_path: z.string().nullish() }),
    diff: z.string(),
  }),
);

/** 转换审批与提问请求；格式错误抛出异常，中断原因交给调用方应答并清理任务。 */
export function parseCodexInteraction(
  method: string,
  value: unknown,
  cwd: string,
  fileChanges: ReadonlyMap<string, z.infer<typeof fileChangesSchema>>,
):
  | {
      request: AgentInteraction;
      permissions?: Record<string, unknown>;
      fileReview?: { itemId: string; changes: string };
    }
  | { error: string; unsupported?: true } {
  const interaction: AgentInteraction = {
    id: randomUUID(),
    kind: "approval",
    text: "",
    expiresAt: Date.now() + 10 * 60_000,
    blocking: true,
    choices: ["accept", "decline"],
    questions: [],
  };
  let permissions: Record<string, unknown> | undefined;
  let fileReview: { itemId: string; changes: string } | undefined;
  if (method === "item/commandExecution/requestApproval") {
    const params = z
      .object({
        turnId: z.string(),
        kind: z.enum(["command", "writeStdin"]).default("command"),
        command: z.string().nullish(),
        cwd: z.string().nullish(),
        reason: z.string().nullish(),
        networkApprovalContext: z.object({ host: z.string(), protocol: z.string() }).nullish(),
        additionalPermissions: z.unknown().optional(),
        availableDecisions: z.array(z.unknown()).nullish(),
      })
      .parse(value);
    interaction.text = `${params.kind === "writeStdin" ? "Terminal input" : "Command"}\nDirectory: ${params.cwd ?? cwd}\n${params.command ?? "Command unavailable."}${params.reason ? `\nReason: ${params.reason}` : ""}${params.networkApprovalContext ? `\nNetwork: ${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}` : ""}${params.additionalPermissions ? `\nPermissions: ${JSON.stringify(params.additionalPermissions, null, 2)}` : ""}`;
    interaction.choices = interaction.choices.filter(
      (choice) =>
        (params.availableDecisions == null || params.availableDecisions.includes(choice)) &&
        (choice !== "accept" || !!params.command || !!params.networkApprovalContext),
    );
  } else if (method === "item/fileChange/requestApproval") {
    const params = z
      .object({
        turnId: z.string(),
        itemId: z.string(),
        reason: z.string().nullish(),
        grantRoot: z.string().nullish(),
      })
      .parse(value);
    const changes = fileChanges.get(params.itemId);
    if (changes?.length) fileReview = { itemId: params.itemId, changes: JSON.stringify(changes) };
    interaction.text = `File changes\nDirectory: ${cwd}${params.reason ? `\nReason: ${params.reason}` : ""}${params.grantRoot ? `\nWrite access: ${params.grantRoot}` : ""}\n${changes?.length ? changes.map((change) => `${change.kind.type}: ${change.path}${change.kind.move_path ? ` → ${change.kind.move_path}` : ""}\n${change.diff}`).join("\n\n") : "Details unavailable. Decline or stop."}`;
    if (!changes?.length) interaction.choices = ["decline"];
  } else if (method === "item/permissions/requestApproval") {
    const params = z
      .object({
        turnId: z.string(),
        cwd: z.string(),
        reason: z.string().nullish(),
        permissions: z.strictObject({
          network: z.strictObject({ enabled: z.boolean().nullable() }).nullish(),
          fileSystem: z
            .strictObject({
              read: z.array(z.string()).nullable(),
              write: z.array(z.string()).nullable(),
              globScanMaxDepth: z.number().int().nonnegative().optional(),
              entries: z.array(z.unknown()).optional(),
            })
            .nullish(),
        }),
      })
      .parse(value);
    permissions = Object.fromEntries(
      Object.entries(params.permissions).filter(([, value]) => value != null),
    );
    interaction.text = `Permissions (this turn only)\nDirectory: ${params.cwd}${params.reason ? `\nReason: ${params.reason}` : ""}\n${JSON.stringify(permissions, null, 2)}`;
  } else if (method === "item/tool/requestUserInput") {
    const params = z
      .object({
        turnId: z.string(),
        isBlocking: z.boolean().default(true),
        autoResolutionMs: z.number().int().nonnegative().nullish(),
        questions: z
          .array(
            z.object({
              id: z.string().min(1),
              header: z.string(),
              question: z.string(),
              isOther: z.boolean().default(false),
              isSecret: z.boolean().default(false),
              options: z
                .array(z.object({ label: z.string().min(1), description: z.string() }))
                .max(20)
                .nullable(),
            }),
          )
          .min(1)
          .max(20),
      })
      .parse(value);
    if (params.questions.some((question) => question.isSecret))
      return { error: "Secret input unsupported. Handle locally, then /resume." };
    if (new Set(params.questions.map((question) => question.id)).size !== params.questions.length)
      throw new Error("Duplicate question IDs.");
    interaction.kind = "question";
    interaction.blocking = params.isBlocking;
    interaction.choices = [];
    interaction.expiresAt = Math.min(
      interaction.expiresAt,
      Date.now() + (params.autoResolutionMs ?? 10 * 60_000),
    );
    interaction.questions = params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options ?? [],
      allowText: question.isOther || !question.options?.length,
    }));
  } else {
    return { error: "Unsupported request. Handle locally, then /resume.", unsupported: true };
  }
  if (JSON.stringify(interaction).length > 64_000)
    return { error: "Request too large. Handle locally, then /resume." };
  return {
    request: interaction,
    ...(permissions ? { permissions } : {}),
    ...(fileReview ? { fileReview } : {}),
  };
}
