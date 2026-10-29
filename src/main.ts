import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCodexAgent } from "./agents/codex.js";
import { loadConfig } from "./config.js";
import { createRelayService } from "./core/relay.js";
import { createTelegramConnection } from "./im/telegram.js";
import { createLogger } from "./logger.js";
import { openStore, type Store } from "./storage/store.js";

/** 启动日志在配置校验前可用，避免将无效配置直接输出。 */
const logger = createLogger();
let store: Store | undefined;
let im: ReturnType<typeof createTelegramConnection> | undefined;
let relay: ReturnType<typeof createRelayService> | undefined;
let running: Promise<void>[] = [];
let phase = "Loading config";
let stopping = false;

/** 两种退出信号共用关停入口；主流程等待消息处理和 Agent 退出后释放状态锁。 */
function stop() {
  if (stopping) return;
  stopping = true;
  logger.info("Stopping service");
  im?.stop();
  relay?.stop();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const config = loadConfig();
  phase = "Loading state";
  store = openStore();
  phase = "Checking agent";
  const agent = await createCodexAgent(config.codexPath);
  logger.info({ agent: agent.name, version: agent.version }, "Agent CLI ready");

  if (!stopping) {
    relay = createRelayService({ store, agent });
    im = createTelegramConnection(config.telegram, relay.handleMessage, store, logger);
    phase = "Connecting Telegram";
    const source = await im.initialize();
    if (source && !stopping) {
      /** systemctl start 等待实际初始化成功，避免把进程创建误报为服务就绪。 */
      if (process.env.NOTIFY_SOCKET) {
        phase = "Notifying systemd";
        await promisify(execFile)("systemd-notify", ["--ready", "--status=Telegram connected"], {
          timeout: 5_000,
        });
      }
      phase = "Processing messages";
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
        error instanceof Error &&
        "code" in error &&
        (typeof error.code === "string" || typeof error.code === "number")
          ? error.code
          : undefined,
    },
    (phase === "Loading config" || phase === "Loading state") && error instanceof Error
      ? error.message
      : "Service failed",
  );
} finally {
  im?.stop();
  relay?.stop();
  await Promise.allSettled(running);
  store?.close();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  logger.info("Tellrun stopped");
}
