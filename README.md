# Tellrun

通过 IM 与服务器上的编码 Agent 对话，提交开发任务、查看进度、处理审批并继续会话。

Tellrun 取自 Tell + Run，意为说出需求、交给 Agent 执行，npm 包名与 CLI 命令均为 `tellrun`。

## 首版目标

- 个人使用，仅授权本人操作。
- 通过 `npm install -g tellrun` 安装，命令行交互配置后在服务器后台运行。
- Telegram 私聊接入，采用长轮询。
- Codex 通过 `app-server` 接入。
- 支持多会话、任务排队、审批、停止和异常恢复。
- 暂不提供项目选择，Tellrun 不设置项目目录白名单。
- 后续逐步接入其他 IM、Claude 等 Agent。

## 文档

- [产品需求文档](docs/prd.md)：范围、交互流程、命令、功能和验收要求。
- [架构与技术选型](docs/architecture.md)：架构图、框架与库、模块、数据模型、协议、恢复和部署方案。

当前已接通 Telegram → Codex app-server → 结果回复，支持指定工作目录、单会话续聊、新建会话、停止、任务去重和重启恢复。配置与运行状态使用 JSON 文件保存；多会话选择、任务排队、进度推送和审批界面尚未接入。

## 安装与使用

先安装 Node.js 24.5.0 或更高版本、Codex，并完成 Codex 登录。CLI、配置向导和 Linux systemd 用户服务管理已接入；本轮未执行 npm 发布，发布后可按以下流程使用。

```sh
npm install -g tellrun
tellrun setup       # 交互配置 Telegram 和 Codex，完成后可直接启动后台服务
tellrun start       # 后续启动
tellrun status      # 查看后台服务状态
tellrun logs        # 查看日志
tellrun logs -f     # 持续跟随日志
tellrun restart     # 重启服务
tellrun stop        # 停止后台服务
```

CLI 采用 Commander，配置向导采用 Clack。Bot Token 使用明文输入，已有配置时留空保留原值。`setup` 校验配置与 Codex 可执行文件后原子保存，取消时保留原配置；可选择立即启动或重启后台服务，并启用开机自启。后续也可使用 `tellrun start --enable` 启用自启。配置、运行状态、单实例锁和服务定义都保存在当前用户的 `~/.tellrun/`，全局 npm 包升级保留这些数据。

后台运行需要 Linux systemd 用户服务。启动时检查并启用用户 linger，确保退出 SSH 后继续运行；权限不足会给出需要在服务器执行的命令。`tellrun run` 提供前台运行，适用于本地调试或外部进程管理器。`tellrun service uninstall` 停止并移除服务，保留配置、状态文件和用户 linger 设置。

使用 nvm 安装 Node.js 时，Tellrun 会把当前 Node 所在目录补到 Codex 子进程的 `PATH` 前面，保证后台启动也能找到 `node`。

尚未发布时，可在源码目录执行 `npm ci`、`npm pack`，再通过 `npm install -g ./tellrun-1.0.1.tgz` 安装本地包。打包自动构建并包含运行依赖声明。升级前停止服务并备份数据，升级后运行 `tellrun restart` 更新 Node 与 CLI 入口路径。具体布局和生命周期见[架构文档](docs/architecture.md#分发与命令行入口)。

## 技术方案

Node.js 24 + TypeScript（ESM）；grammY 接入 Telegram；Node.js 文件接口保存 JSON 配置和状态；Zod 校验配置与状态文件，Pino 输出日志，Biome 负责格式与静态检查。按当前要求，不添加测试文件、测试命令或测试依赖。

使用 Node.js 自带的 npm 管理依赖，提交 `package-lock.json`，通过 `npm ci` 安装。需要 Node.js 24.5.0 或更高版本，以使用[内置代理支持](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)；`.nvmrc` 固定开发环境为 Node.js 24.22.1，使用现有 nvm 切换运行时。

## 目录与扩展

```text
src/
├── cli.ts               # 全局命令与交互配置向导
├── systemd.ts           # systemd 用户服务的启停、状态和日志
├── main.ts              # 组件组装、启动和退出
├── config.ts            # 用户配置、环境变量覆盖与校验
├── logger.ts            # 结构化日志与敏感字段隐藏
├── agents/
│   └── codex.ts         # Codex app-server 连接、续聊、执行和中断
├── im/
│   └── telegram.ts      # Telegram 鉴权、消息转换和发送
├── core/
│   ├── relay.ts         # 命令处理与单任务执行
│   └── types.ts         # 跨模块共用的消息与 Agent 接口
└── storage/
    ├── store.ts         # 状态读写、恢复和单实例锁
    ├── schema.ts        # JSON 状态结构校验
    └── json.ts          # 配置与状态共用的原子写入
```

新增 IM 时，在 `im/` 添加连接器，把授权后的消息转换为 `IncomingMessage` 并调用核心入口。新增 Agent 时，在 `agents/` 实现 `Agent` 的执行和停止接口；审批接口随实际交互能力扩展。核心层不使用 grammY 或 Codex 协议类型，不引入插件注册器、基类或依赖注入框架。

`config.json` 保存 Telegram 凭据、本人 ID、Codex 路径和可选的 `telegram.proxyUrl`。
`state.json` 保存聊天与当前会话、工作目录、任务输入与最终结果、入站去重标识和待发送回复；发送成功或被永久拒绝后移除回复副本。Codex 自己管理完整会话历史，Tellrun 不保存流式文本、思考过程、工具原始输出或 RPC 等待状态。

JSON 更新先写同目录临时文件，刷盘后原子替换。`state.json.lock/` 是临时单实例锁目录；正常退出清理，崩溃后检查原进程已退出再回收。文件损坏或写入失败会停止服务，不自动覆盖成空状态。

## 当前源码开发启动

先安装 nvm，并确保 `codex --version` 可以运行。

```sh
nvm install
nvm use
npm ci
cp .env.example .env
```

编辑 `.env`，填写 `TELEGRAM_BOT_TOKEN` 和本人 `TELEGRAM_OWNER_ID`；用户 ID 必须是十进制正整数。`.env` 已加入 Git 忽略规则。

当前只有以上两项必填配置，也可运行 `node dist/cli.js setup` 写入用户配置。配置与状态分别放在 `~/.tellrun/config.json`、`~/.tellrun/state.json`，开发运行与全局安装使用同一目录和单实例锁。Codex 优先使用 `CODEX_PATH`，其次使用配置文件路径，均未设置时通过 PATH 查找。日志级别固定为 `info`。无需项目清单；会话默认使用服务启动目录，可在 Telegram 中用 `/cwd` 切换，不设置目录白名单。

`telegram.proxyUrl` 为可选配置，由用户按需填写。Telegram 代理优先使用非空 `TELEGRAM_PROXY_URL`，其次使用配置文件中的 `telegram.proxyUrl`；配置文件中空字符串表示明确直连。两处均未指定时，读取运行环境的 `HTTPS_PROXY` / `https_proxy`；使用代理时遵循 `NO_PROXY` / `no_proxy`（小写优先）。代理 URL 不写入服务定义或命令行参数。

```sh
npm run dev
```

启动时会取得单实例锁、加载并校验状态文件、检查 Codex CLI，再核实 Telegram 身份并启动轮询。仅响应配置的本人私聊；发给其他机器人的命令会被忽略，不支持的媒体会收到提示。若已有 Webhook 或出现轮询冲突，服务退出并给出诊断，不自动接管其他部署。

在 Telegram 中直接发送消息即可：

```text
hi
```

未指定工作目录的会话会记住服务启动目录；systemd 服务默认使用当前用户的主目录。需要切换时发送 `/cwd /你的项目绝对路径`，目录变化会开始新会话。后续文本沿用当前 Codex 会话。`/new` 新建会话并保留目录，`/status` 查看状态，`/last` 查看最近结果；`/stop` 停止当前任务并暂停接收，确认结果后用 `/resume` 恢复。当前全局只接受一个未结束任务，忙碌时新消息会明确提示未提交。

连接 Codex 和执行任务期间，Telegram 聊天窗口会显示“正在输入…”并每 4 秒刷新。任务结束或请求停止后不再刷新，提示由 Telegram 自动清除；状态更新失败不影响任务执行和结果回复。

Codex 沿用本机登录、模型配置和终端代理；默认使用工作区写入与按需审批。尚未支持的审批或结构化提问会中断任务并说明原因。CLI 版本检查不代表模型可用，实际调用失败会保存状态并回复。

入站标识、任务和回执作为同一份快照保存，重复 Update 不会再次执行。重启会保留尚未派发的任务；执行中断且结果不确定的任务不会自动重跑，需检查后 `/resume`。关停等待 Agent 结束后释放状态锁。

普通 Telegram 请求连同重试最多等待 15 秒，长轮询最多 40 秒，输入提示单次最多 4 秒且不自动重试。可恢复的发送失败会保留 outbox 并退避重试，429 遵守服务端等待时间；永久拒绝会记录日志并将回复移出队列，任务结果仍可用 `/last` 查看。发送成功但响应丢失时可能重复通知，但不会重跑任务。轮询或存储故障会停止服务，待人工或进程管理器重启。

开发服务本身时使用 `npm run dev`。让 Agent 修改代码时可用 `npm run build && npm start`，避免源码监听重启打断正在执行的任务。

## 本地开发

在项目目录执行：

```sh
npm ci                     # 首次安装依赖
npm run build              # 生成 CLI 入口并设置执行权限
npm link
tellrun --help
tellrun setup
tellrun run
```

Linux 下本地调试时，在 `setup` 中选择仅保存配置，再通过 `tellrun run` 前台运行。

修改 TypeScript 后，重新执行 `npm run build`，再运行命令即可，不用重复 `npm link`。完成首次构建后，也可以单独开一个终端自动编译：

```sh
npx tsc -p tsconfig.build.json --watch
```

自动编译不会重启正在运行的进程，修改后需要手动重启 `tellrun run`。如果只调试业务逻辑，可以直接使用现有的 `npm run dev`，它会监听源码并自动重启。

发布前，使用实际安装包验证文件是否齐全：

```sh
npm pack                         # 已配置自动构建
npm install -g ./tellrun-1.0.1.tgz
tellrun --help
```

压缩包文件名随版本号变化，以 `npm pack` 输出为准。安装压缩包后，全局命令会改用安装包中的代码；继续通过源码调试时，在项目目录重新执行 `npm link`。

## 开发命令

| 命令             | 用途                     |
| ---------------- | ------------------------ |
| `npm run dev`    | 监听源码并重启           |
| `npm run check`  | 格式、静态检查与类型检查 |
| `npm run format` | 格式化并应用安全修复     |
| `npm run build`  | 编译到 `dist/`           |
| `npm start`      | 运行编译产物             |


上述源码开发命令从项目根目录运行，用户配置和运行状态始终保存在用户目录。

已在本机 Node.js 24.22.1、Codex CLI 0.165.0 验证真实回复、跨进程续聊与中断。文件存储验证覆盖去重、单实例锁、重启恢复、损坏文件与写入失败；打包检查确认包含所需编译产物。后台命令仅在隔离命令环境中检查了调用顺序和特殊路径；目标 Linux 的真实 systemd 启停、退出 SSH、开机自启及完整 M0 验证仍待完成。[Codex app-server 官方文档](https://learn.chatgpt.com/docs/app-server)

## 文档位置

设计文档保存在项目的 `docs/` 目录。原始 [产品 Pages 草案](https://chatgpt.com/space/page_8cd777a7402c8191aa928ab888cb8df8) 和 [架构 Pages 草案](https://chatgpt.com/space/page_c0f7aa829c508191b8712e93ee49b06c) 保留，后续本地修改不会自动同步到 Pages。
