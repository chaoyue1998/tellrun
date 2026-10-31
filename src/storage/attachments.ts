import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { appDirectory } from "../config.js";
import { AttachmentError, maxAttachmentBytes } from "../core/attachments.js";
import type { Attachment, AttachmentLoader } from "../core/types.js";

/** 清理跨平台路径与控制字符，限制 UTF-8 文件名长度，始终写入独立附件目录。 */
function safeFilename(name: string) {
  let filename = basename(name.replaceAll("\\", "/")).replace(/\p{Cc}/gu, "_");
  while (Buffer.byteLength(filename) > 180) filename = filename.slice(0, -1);
  return !filename || filename === "." || filename === ".." ? "attachment" : filename;
}

/** 按文件头识别常见图片；以文件方式发送的图片同样使用视觉输入。 */
async function isImage(path: string) {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return (
      (bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
      (bytesRead >= 3 && header.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) ||
      (bytesRead >= 6 && ["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6))) ||
      (bytesRead >= 12 &&
        header.toString("ascii", 0, 4) === "RIFF" &&
        header.toString("ascii", 8, 12) === "WEBP")
    );
  } finally {
    await file.close();
  }
}

/** 原子保存用户附件；完整文件可跨重启复用，未完成文件在失败或重试时清理。 */
export function createAttachmentLoader(options: {
  directory?: string;
  download: (attachment: Attachment, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
}): AttachmentLoader {
  const directory = options.directory ?? join(appDirectory, "attachments");
  return async (attachments, signal) => {
    const ready = [];
    for (const attachment of attachments) {
      signal.throwIfAborted();
      if (attachment.size !== null && attachment.size > maxAttachmentBytes)
        throw new AttachmentError("Attachment exceeds the 20 MB download limit.");
      /** 标识来自接收记录；校验后才能将它用于目录和临时文件路径。 */
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(attachment.id))
        throw new AttachmentError("Invalid attachment reference. Resend the attachment.");
      const folder = join(directory, attachment.id);
      const path = join(folder, safeFilename(attachment.name));
      const temporary = join(directory, `${attachment.id}.part`);
      let cleanup = false;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await lstat(directory)).isDirectory())
          throw new AttachmentError("Attachment directory is unavailable.");
        await mkdir(folder, { recursive: true, mode: 0o700 });
        if (!(await lstat(folder)).isDirectory())
          throw new AttachmentError("Attachment directory is unavailable.");
        cleanup = true;
        let saved = false;
        try {
          const file = await lstat(path);
          if (!file.isFile() || file.size > maxAttachmentBytes)
            throw new AttachmentError("Saved attachment is invalid. Resend the attachment.");
          saved = true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await rm(temporary, { force: true });
        if (!saved) {
          /** 总时限覆盖文件信息查询、下载和落盘，不占用消息接收循环。 */
          const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
          const source = await options.download(attachment, downloadSignal);
          let bytes = 0;
          await pipeline(
            source,
            new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length;
                callback(
                  bytes > maxAttachmentBytes
                    ? new AttachmentError("Attachment exceeds the 20 MB download limit.")
                    : null,
                  chunk,
                );
              },
            }),
            createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
            { signal: downloadSignal },
          );
          const file = await open(temporary, "r");
          try {
            await file.sync();
          } finally {
            await file.close();
          }
          signal.throwIfAborted();
          await rename(temporary, path);
          /** 文件先落盘再公开路径，目录项也刷盘以保留重启后的附件引用。 */
          if (process.platform !== "win32") {
            const savedDirectory = await open(folder, "r");
            try {
              await savedDirectory.sync();
            } finally {
              await savedDirectory.close();
            }
          }
        }
        const image = await isImage(path);
        if (attachment.kind === "image" && !image)
          throw new AttachmentError("Unsupported or invalid image. Send it as a file instead.");
        ready.push({
          name: attachment.name,
          path,
          kind: image ? ("image" as const) : ("file" as const),
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof AttachmentError) throw error;
        throw new AttachmentError(
          "Cannot download or save attachment. Check network and disk, then resend.",
        );
      } finally {
        if (cleanup) await rm(temporary, { force: true });
      }
    }
    return ready;
  };
}
