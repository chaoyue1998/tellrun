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

/** 只接受已知命令审批格式；规则内容必须来自当前请求，不能由按钮构造。 */
const commandDecisionSchema = z.union([
  z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  z.strictObject({
    acceptWithExecpolicyAmendment: z.strictObject({
      execpolicy_amendment: z.array(z.string()).min(1),
    }),
  }),
]);

/** 原生审批载荷只保留在当前 Codex 连接中；approved 用于提交前复核文件差异。 */
export interface CodexApprovalResponse {
  result: Record<string, unknown>;
  approved: boolean;
}

/** 转换审批与提问请求；格式错误抛出异常，中断原因交给调用方应答并清理任务。 */
export function parseCodexInteraction(
  method: string,
  value: unknown,
  cwd: string,
  fileChanges: ReadonlyMap<string, z.infer<typeof fileChangesSchema>>,
):
  | {
      request: AgentInteraction;
      approvals: Map<string, CodexApprovalResponse>;
      fileReview?: { itemId: string; changes: string };
    }
  | { error: string; unsupported?: true } {
  const interaction: AgentInteraction = {
    id: randomUUID(),
    kind: "approval",
    text: "",
    expiresAt: null,
    blocking: true,
    choices: [],
    questions: [],
  };
  const approvals = new Map<string, CodexApprovalResponse>();
  let fileReview: { itemId: string; changes: string } | undefined;
  /** 展示选项与完整响应同步登记，核心层只传回选项标识。 */
  function offer(id: string, label: string, result: Record<string, unknown>, approved: boolean) {
    if (approvals.has(id)) return;
    interaction.choices.push({ id, label });
    approvals.set(id, { result, approved });
  }
  /** 原生取消直接回传 Codex，不转换为 Tellrun 的停止和暂停接收。 */
  function offerDecision(decision: z.infer<typeof commandDecisionSchema>, index: number) {
    if (typeof decision === "string") {
      const labels = {
        accept: "Allow once",
        acceptForSession: "Allow for session",
        decline: "Decline",
        cancel: "Cancel",
      };
      offer(decision, labels[decision], { decision }, decision.startsWith("accept"));
    } else {
      interaction.text += `\nCommand rule ${index + 1}: ${JSON.stringify(decision.acceptWithExecpolicyAmendment.execpolicy_amendment)}`;
      offer(`rule-${index}`, `Allow & remember rule ${index + 1}`, { decision }, true);
    }
  }
  if (method === "item/commandExecution/requestApproval") {
    const params = z
      .object({
        turnId: z.string(),
        kind: z.enum(["command", "writeStdin"]),
        command: z.string().nullish(),
        cwd: z.string().nullish(),
        reason: z.string().nullish(),
        networkApprovalContext: z.object({ host: z.string(), protocol: z.string() }).nullish(),
        additionalPermissions: z.unknown().optional(),
        availableDecisions: z.array(z.unknown()),
      })
      .parse(value);
    interaction.text = `${params.kind === "writeStdin" ? "Terminal input" : "Command"}\nDirectory: ${params.cwd ?? cwd}\n${params.command ?? "Command unavailable."}${params.reason ? `\nReason: ${params.reason}` : ""}${params.networkApprovalContext ? `\nNetwork: ${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}` : ""}${params.additionalPermissions ? `\nPermissions: ${JSON.stringify(params.additionalPermissions, null, 2)}` : ""}`;
    /** 只展示当前服务明确提供且客户端支持的决定。 */
    for (const [index, value] of params.availableDecisions.entries()) {
      const parsed = commandDecisionSchema.safeParse(value);
      if (!parsed.success) continue;
      const decision = parsed.data;
      if (
        decision !== "decline" &&
        decision !== "cancel" &&
        !params.command &&
        !params.networkApprovalContext
      )
        continue;
      offerDecision(decision, index);
    }
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
    interaction.text = `File changes\nDirectory: ${cwd}${params.reason ? `\nReason: ${params.reason}` : ""}${params.grantRoot ? `\nWrite access: ${params.grantRoot}` : ""}\n${changes?.length ? changes.map((change) => `${change.kind.type}: ${change.path}${change.kind.move_path ? ` → ${change.kind.move_path}` : ""}\n${change.diff}`).join("\n\n") : "Details unavailable. Decline or cancel."}`;
    for (const decision of ["accept", "acceptForSession", "decline", "cancel"] as const) {
      if (!changes?.length && decision.startsWith("accept")) continue;
      offerDecision(decision, interaction.choices.length);
    }
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
    const permissions = Object.fromEntries(
      Object.entries(params.permissions).filter(([, value]) => value != null),
    );
    interaction.text = `Permissions\nDirectory: ${params.cwd}${params.reason ? `\nReason: ${params.reason}` : ""}\n${JSON.stringify(permissions, null, 2)}`;
    offer("accept", "Allow this turn", { permissions, scope: "turn" }, true);
    offer("acceptForSession", "Allow for session", { permissions, scope: "session" }, true);
    offer("decline", "Decline", { permissions: {}, scope: "turn" }, false);
  } else if (method === "item/tool/requestUserInput" || method === "item/completed") {
    /** 异步问题来自消息通知；稳定问题标识与官方客户端的答案格式保持一致。 */
    if (method === "item/completed")
      value = z
        .object({
          turnId: z.string(),
          item: z.object({
            type: z.literal("agentMessage"),
            id: z.string(),
            delivery: z.literal("async"),
            questions: z.array(
              z.object({ title: z.string(), options: z.array(z.string()).nullish() }),
            ),
          }),
        })
        .transform(({ turnId, item }) => ({
          turnId,
          isBlocking: false,
          questions: item.questions.map((question, index) => ({
            id: JSON.stringify(["request_user_input_async", item.id, index]),
            header: "",
            question: question.title,
            isOther: true,
            isSecret: false,
            options: question.options?.map((label) => ({ label, description: "" })) ?? null,
          })),
        }))
        .parse(value);
    const params = z
      .object({
        turnId: z.string(),
        isBlocking: z.boolean(),
        questions: z
          .array(
            z.object({
              id: z.string().min(1),
              header: z.string(),
              question: z.string(),
              isOther: z.boolean(),
              isSecret: z.boolean(),
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
    /** 只有提问设置本地期限；审批持续等待用户决定。 */
    interaction.expiresAt = Date.now() + 10 * 60_000;
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
  if (interaction.kind === "approval" && !interaction.choices.length)
    return { error: "No supported approval options. Handle locally, then /resume." };
  return {
    request: interaction,
    approvals,
    ...(fileReview ? { fileReview } : {}),
  };
}
