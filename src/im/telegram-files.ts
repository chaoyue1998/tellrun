import { randomUUID } from "node:crypto";
import { access, constants, stat } from "node:fs/promises";
import { type Agent, get } from "node:https";
import { type Api, GrammyError, InputFile } from "grammy";
import { AttachmentError, maxAttachmentBytes } from "../core/attachments.js";
import type { AgentAttachment, Attachment } from "../core/types.js";
import { createAttachmentLoader } from "../storage/attachments.js";

/** Telegram 照片上传上限为 10 MB；更大的图片按文件发送。 */
const maxPhotoBytes = 10 * 1024 * 1024;
/** Telegram 官方 Bot API 的单文件上传上限。 */
const maxUploadBytes = 50 * 1024 * 1024;

/** 直接上传 Agent 产物；图片格式或尺寸被拒绝时改发原文件，不额外保存副本。 */
export async function sendTelegramAttachment(
  api: Pick<Api, "sendPhoto" | "sendDocument">,
  chatId: string,
  attachment: AgentAttachment,
) {
  const [file] = await Promise.all([
    stat(attachment.path),
    access(attachment.path, constants.R_OK),
  ]).catch(() => {
    throw new AttachmentError("无法读取附件，请确认原文件仍存在且可读。");
  });
  if (!file.isFile() || file.size === 0) throw new AttachmentError("附件不是有效的非空文件。");
  if (file.size > maxUploadBytes)
    throw new AttachmentError("附件超过 Telegram 的 50 MB 上传上限。");
  if (attachment.kind === "image" && file.size <= maxPhotoBytes) {
    try {
      return await api.sendPhoto(chatId, new InputFile(attachment.path, attachment.name));
    } catch (error) {
      /** 网络错误和限流由持久化队列重试；仅照片被拒绝时尝试文件上传。 */
      if (!(error instanceof GrammyError && error.error_code === 400)) throw error;
    }
  }
  return api.sendDocument(chatId, new InputFile(attachment.path, attachment.name));
}

/** Telegram 每条消息只有一个附件；photo 数组是同一图片的不同尺寸。 */
export function telegramAttachments(message: {
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  document?: { file_id: string; file_size?: number; file_name?: string };
}): Attachment[] {
  const photo = message.photo?.reduce<(typeof message.photo)[number] | undefined>(
    (largest, candidate) =>
      !largest || candidate.width * candidate.height > largest.width * largest.height
        ? candidate
        : largest,
    undefined,
  );
  const file = photo ?? message.document;
  return file
    ? [
        {
          id: randomUUID(),
          fileId: file.file_id,
          name: photo ? "photo.jpg" : (message.document?.file_name ?? "attachment"),
          kind: photo ? "image" : "file",
          size: file.file_size ?? null,
        },
      ]
    : [];
}

/** 复用 Telegram 连接的代理和凭据；下载链接只存在于传输层，不写入状态或回复。 */
export function createTelegramAttachmentLoader(
  api: Pick<Api, "getFile">,
  token: string,
  agent: Agent,
) {
  return createAttachmentLoader({
    async download(attachment, signal) {
      const file = await api.getFile(
        attachment.fileId,
        signal as Parameters<typeof api.getFile>[1],
      );
      if (file.file_size !== undefined && file.file_size > maxAttachmentBytes)
        throw new AttachmentError("Attachment exceeds the 20 MB download limit.");
      if (
        !file.file_path ||
        file.file_path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new AttachmentError("Attachment is unavailable. Resend it to try again.");
      const path = file.file_path.split("/").map(encodeURIComponent).join("/");
      return new Promise((resolve, reject) => {
        const request = get(
          `https://api.telegram.org/file/bot${token}/${path}`,
          { agent, signal },
          (response) => {
            response.on("error", reject);
            if (response.statusCode !== 200) {
              response.destroy();
              reject(new AttachmentError("Attachment download failed. Resend it to try again."));
              return;
            }
            if (Number(response.headers["content-length"]) > maxAttachmentBytes) {
              response.destroy();
              reject(new AttachmentError("Attachment exceeds the 20 MB download limit."));
              return;
            }
            resolve(response);
          },
        );
        request.on("error", reject);
      });
    },
  });
}
