# Agent Relay

通过 IM 与服务器上的编码 Agent 对话，提交开发任务、查看进度、处理审批并继续会话。

## 首版范围

- 个人使用，仅授权本人操作。
- Telegram 私聊接入，采用长轮询。
- Codex 通过 `app-server` 接入。
- 支持多会话、任务排队、审批、停止和异常恢复。
- 暂不提供项目选择，Relay 不设置项目目录白名单。
- 后续逐步接入其他 IM、Claude 等 Agent。

## 文档

- [产品需求文档](docs/prd.md)：范围、交互流程、命令、功能和验收要求。
- [架构与技术选型](docs/architecture.md)：架构图、框架与库、模块、数据模型、协议、恢复和部署方案。

当前已搭建基础框架：配置校验、结构化日志、SQLite 迁移、Telegram 私聊授权和状态命令，以及 Codex CLI 可用性检查。任务执行、会话、队列与审批尚未接入；普通消息会明确提示未提交执行。

## 技术方案

Node.js 24 + TypeScript（ESM）；grammY 接入 Telegram；SQLite、better-sqlite3 和 Drizzle 保存动态状态；Zod 校验配置，Pino 输出日志，Biome 负责格式与静态检查。本轮暂不加入测试框架和测试文件。

使用 Node.js 自带的 npm 管理依赖，提交 `package-lock.json`，通过 `npm ci` 安装。`.nvmrc` 指定 Node.js 24.22.1，使用现有 nvm 切换运行时。

## 目录与扩展

```text
src/
├── main.ts              # 组件组装、启动和退出
├── config.ts            # Telegram 凭据与本人身份校验
├── logger.ts            # 结构化日志与敏感字段隐藏
├── agents/
│   └── codex.ts         # Codex 接入，目前只检查 CLI 版本
├── im/
│   └── telegram.ts      # Telegram 鉴权、消息转换和发送
├── core/
│   ├── service.ts       # 平台无关的命令与业务处理
│   └── types.ts         # 跨模块共用的消息与回复类型
└── storage/
    ├── index.ts         # SQLite 连接、迁移和存储操作
    ├── schema.ts        # 实际使用的数据表
    └── migrate.ts       # 独立迁移入口
migrations/              # SQL 迁移及 Drizzle 元数据
```

新增 IM 时，在 `im/` 添加连接器，把授权后的消息转换为 `IncomingMessage` 并调用核心入口。新增 Agent 时，在 `agents/` 添加对应模块；执行与审批接口在 M0 验证后按实际能力补充。核心层不使用 grammY 或 Codex 协议类型，不引入插件注册器、基类或依赖注入框架。

当前 SQLite 只有 `channels` 业务表，保存平台、机器人账号、聊天 ID、用户 ID 和时间戳，不保存聊天正文。会话、任务、审批、入站去重与发送记录随对应功能再添加。

## 本地启动

先安装 nvm，并确保 `codex --version` 可以运行。

```sh
nvm install
nvm use
npm ci
cp .env.example .env
```

编辑 `.env`，填写 `TELEGRAM_BOT_TOKEN` 和本人 `TELEGRAM_OWNER_ID`。`.env` 已加入 Git 忽略规则。

当前只需要 `.env` 中的两项配置。数据库固定放在 `data/agent-relay.db`，通过 PATH 调用 `codex`，日志级别固定为 `info`。无需项目清单；后续任务执行直接使用指定的工作目录。

```sh
npm run dev
```

启动时会自动迁移数据库、检查 Codex CLI，然后启动 Telegram 长轮询。支持 `/start`、`/help` 和 `/status`，仅响应配置的本人私聊。若已有 Webhook，启动会失败并提示手动处理。

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 监听源码并重启 |
| `npm run check` | 格式、静态检查与类型检查 |
| `npm run format` | 格式化并应用安全修复 |
| `npm run build` | 编译到 `dist/` |
| `npm start` | 运行编译产物 |
| `npm run db:generate -- --name=描述` | 根据表结构生成迁移 |
| `npm run db:migrate` | 应用迁移，无需 Telegram 凭据 |

所有命令从项目根目录运行。运行编译产物时仍需保留项目根目录下的 `migrations/`；生产环境不使用 `drizzle-kit push` 代替迁移。

本轮完成框架与依赖安装；下一步是在目标 Linux 环境完成 Codex app-server 的 M0 协议验证，再接入任务执行链路。[Codex app-server 官方文档](https://learn.chatgpt.com/docs/app-server)

## 文档位置

本地项目目录为 `/Users/sc/Code/agent-relay`，设计文档保存在 `docs/`。原始 [产品 Pages 草案](https://chatgpt.com/space/page_8cd777a7402c8191aa928ab888cb8df8) 和 [架构 Pages 草案](https://chatgpt.com/space/page_c0f7aa829c508191b8712e93ee49b06c) 保留，后续本地修改不会自动同步到 Pages。
