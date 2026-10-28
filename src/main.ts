import { inspectCodex } from "./agents/codex.js";
import { loadConfig } from "./config.js";
import { createRelayService } from "./core/service.js";
import { createTelegramConnection } from "./im/telegram.js";
import { createLogger } from "./logger.js";
import { openStore, type Store } from "./storage/index.js";

/** 启动日志在配置校验前可用，避免将无效配置直接输出。 */
const logger = createLogger();
let store: Store | undefined;
let im: ReturnType<typeof createTelegramConnection> | undefined;
let phase = "配置加载";
let stopping = false;

/** 两种退出信号共用关停入口；主流程等待 im.start 完成后再关闭数据库。 */
function stop() {
  if (stopping) return;
  stopping = true;
  logger.info("正在停止服务");
  im?.stop();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const config = loadConfig();
  phase = "数据库迁移";
  store = openStore();
  phase = "Agent 可用性检查";
  const agent = await inspectCodex();
  logger.info({ agent: agent.name, version: agent.version }, "Agent CLI 可用，任务执行尚未接入");

  if (!stopping) {
    im = createTelegramConnection(config.telegram, createRelayService({ store, agent }), logger);
    phase = "IM 连接与轮询";
    await im.start();
  }
} catch (error) {
  process.exitCode = 1;
  logger.fatal(
    {
      phase,
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorCode:
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined,
    },
    phase === "配置加载" && error instanceof Error ? error.message : "服务启动或运行失败",
  );
} finally {
  store?.close();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  logger.info("Agent Relay 已退出");
}
