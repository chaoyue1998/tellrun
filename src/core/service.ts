import type { Store } from "../storage/index.js";
import type { MessageHandler } from "./types.js";

/** 组装业务入口；只处理统一消息和存储操作，不处理平台协议。 */
export function createRelayService(options: {
  store: Store;
  agent: { name: string; version: string };
}): MessageHandler {
  return async (message) => {
    options.store.touchChannel(message.channel);

    if (message.content.type === "command") {
      switch (message.content.name) {
        case "start":
        case "help":
          return {
            text: "Agent Relay 已连接。\n/status 查看服务状态。\n任务执行尚未启用，普通消息不会创建任务。",
          };
        case "status":
          return {
            text: `服务：已连接\n本地存储：可用\n${options.agent.name} CLI：${options.agent.version}\n任务执行：尚未启用`,
          };
        default:
          return { text: "暂不支持此命令，请使用 /help 查看可用操作。" };
      }
    }

    return { text: "任务执行尚未启用，本条消息未提交执行。" };
  };
}
