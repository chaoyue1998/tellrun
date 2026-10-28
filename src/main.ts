import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCodexAgent } from "./agents/codex.js";
import { loadConfig } from "./config.js";
import { createRelayService } from "./core/service.js";
import { createTelegramConnection } from "./im/telegram.js";
import { createLogger } from "./logger.js";
import { openStore, type Store } from "./storage/index.js";

/** 启动日志在配置校验前可用，避免将无效配置直接输出。 */
const logger = createLogger();
let store: Store | undefined;
let im: ReturnType<typeof createTelegramConnection> | undefined;
let relay: ReturnType<typeof createRelayService> | undefined;
let running: Promise<void>[] = [];
let phase = "配置加载";
let stopping = false;

/** 两种退出信号共用关停入口；主流程等待消息处理和 Agent 退出后关闭数据库。 */
function stop() {
  if (stopping) return;
  stopping = true;
  logger.info("正在停止服务");
  im?.stop();
  relay?.stop();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const config = loadConfig();
  /** 恢复向导保存的执行路径与代理，后台进程无需依赖登录终端。 */
  Object.assign(process.env, config.environment);
  phase = "数据库迁移";
  store = openStore();
  phase = "Agent 可用性检查";
  const agent = await createCodexAgent(config.codexPath);
  logger.info({ agent: agent.name, version: agent.version }, "Agent CLI 可用");

  if (!stopping) {
    relay = createRelayService({ store, agent, logger });
    im = createTelegramConnection(config.telegram, relay.handleMessage, store, logger);
    phase = "IM 连接";
    const source = await im.initialize();
    if (source && !stopping) {
      /** systemctl start 等待实际初始化成功，避免把进程创建误报为服务就绪。 */
      if (process.env.NOTIFY_SOCKET) {
        phase = "后台就绪通知";
        await promisify(execFile)("systemd-notify", ["--ready", "--status=Telegram 已连接"], {
          timeout: 5_000,
        });
      }
      phase = "消息与任务处理";
      running = [im.start(), relay.run(source)];
      await Promise.all(running);
    }
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
    phase === "配置加载" && error instanceof Error
      ? error.message
      : phase === "数据库迁移" &&
          error instanceof Error &&
          "code" in error &&
          error.code === "SQLITE_BUSY"
        ? "数据库已被占用，请检查是否已有 Agent Relay 实例或迁移进程正在运行"
        : "服务启动或运行失败",
  );
} finally {
  im?.stop();
  relay?.stop();
  await Promise.allSettled(running);
  store?.close();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  logger.info("Agent Relay 已退出");
}
