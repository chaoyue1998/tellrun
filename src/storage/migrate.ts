import { createLogger } from "../logger.js";
import { openStore } from "./index.js";

/** 独立迁移无需 Telegram 凭据，便于部署前检查数据库。 */
const logger = createLogger();

try {
  openStore().close();
  logger.info("数据库迁移完成");
} catch (error) {
  process.exitCode = 1;
  logger.fatal(
    {
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorCode:
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined,
    },
    "数据库迁移失败，请检查路径权限和迁移文件",
  );
}
