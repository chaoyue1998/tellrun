import { randomUUID } from "node:crypto";
import { type Agent, get } from "node:https";
import type { Api } from "grammy";
import type { Attachment } from "../core/types.js";
import {
  AttachmentError,
  createAttachmentLoader,
  maxAttachmentBytes,
} from "../storage/attachments.js";

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
