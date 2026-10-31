/** 入站附件的单文件上限；消息校验与附件准备共用，当前采用 20 MB。 */
export const maxAttachmentBytes = 20 * 1024 * 1024;

/** 可直接展示的附件错误；底层实现不能把凭据或原始网络错误传入此类型。 */
export class AttachmentError extends Error {}
