# Tellrun — 通过 Telegram 远程使用 OpenAI Codex

**Tellrun 是可自行部署的 Telegram 机器人，基于 OpenAI Codex CLI 提供远程 AI 编程、持久化会话和流式回复。**

在服务器上运行 Tellrun，即可通过手机或电脑上的 Telegram 提交编码任务、继续对话和查看执行结果，无需一直保持 SSH 终端连接。

[English](https://github.com/chaoyue1998/tellrun/blob/main/README.md) | **简体中文**

[npm](https://www.npmjs.com/package/tellrun) · [GitHub](https://github.com/chaoyue1998/tellrun) · [问题反馈](https://github.com/chaoyue1998/tellrun/issues)

[快速开始](#安装并通过-telegram-使用-codex) · [Telegram 命令](#telegram-命令) · [配置](#配置与数据) · [常见问题](#常见问题)

## 功能

- **远程编码**：在 Telegram 私聊中发送任务，由服务器上的 Codex 执行。
- **连续对话**：保留当前会话上下文，通过 `/cwd` 指定项目目录，通过 `/new` 开始新会话。
- **即时反馈**：显示输入状态与流式回复，执行期间可以继续发送文字补充要求。
- **任务控制**：查看状态和最近结果，停止任务并暂停接收；重启后保留会话与任务记录。
- **审批与提问**：通过按钮处理命令、文件和权限审批；点击选项或明确回复对应问题，多题全部回答后提交。
- **个人部署**：仅响应指定用户的私聊，使用长轮询接收消息，无需配置 Webhook 或开放入站端口。

当前支持 **Telegram + Codex**，面向单用户，每次处理一个任务。多会话列表、独立任务排队、工具进度摘要、图片和文件输入暂未支持。


## 安装并通过 Telegram 使用 Codex

### 1. 准备环境

- **Node.js ≥ 24.5.0**。
- **[Codex CLI](https://github.com/openai/codex)**：在运行 Tellrun 的同一系统用户下安装并完成登录，确认可以在终端正常使用。
- **Telegram Bot Token**：向 [@BotFather](https://t.me/BotFather) 发送 `/newbot`，按提示创建机器人并获取 Token。参见 [Telegram 官方教程](https://core.telegram.org/bots/tutorial#obtain-your-bot-token)。
- **本人 Telegram 数字用户 ID**：不是 `@用户名`，参见[获取方法](#如何获取-telegram-用户-id)。

后台管理需要支持 **systemd 用户服务的 Linux**。本地调试或使用其他进程管理器时，可通过 `tellrun run` 前台运行。

### 2. 安装并配置

```sh
npm install -g tellrun
tellrun setup
```

按向导填写 Bot Token、本人数字用户 ID 和 Codex 命令或可执行文件路径。Linux 下可以在配置完成后直接启动后台服务，并选择开机自启。

如果选择了仅保存配置，之后运行：

```sh
tellrun start --enable
```

前台运行时使用：

```sh
tellrun run
```

### 3. 在 Telegram 中开始对话

打开与机器人的私聊，依次发送以下消息，将示例目录替换为服务器上实际存在的项目绝对路径：

```text
/start
/cwd /home/you/projects/my-app
帮我了解这个项目，说明主要模块和启动方式。
```

之后直接发送文字即可继续当前会话；任务执行中发送的新消息会补充到当前任务。例如：

```text
重点看一下登录流程，先分析问题并给出修改建议。
```

未设置 `/cwd` 时，工作目录默认为服务启动目录；systemd 服务默认使用当前用户的主目录。切换目录会开始新会话。

## Telegram 命令

| 命令                  | 作用                                       |
| --------------------- | ------------------------------------------ |
| `/start`、`/help`     | 查看使用说明                               |
| `/cwd`                | 查看当前工作目录                           |
| `/cwd /absolute/path` | 切换工作目录并开始新会话                   |
| `/new`                | 开始新会话，保留工作目录                   |
| `/status`             | 查看连接、会话、目录和任务状态             |
| `/last`               | 查看最近任务的状态与结果                   |
| `/stop`               | 请求停止当前任务，并暂停接收新任务         |
| `/resume`             | 恢复接收新任务，不会重新执行此前中断的任务 |

切换目录或新建会话前，需要等待当前任务结束。使用 `/stop` 后，先检查最终状态，再发送 `/resume` 和新的任务内容。

## 后台服务

以下命令用于 Linux systemd 用户服务：

| 命令                        | 作用                           |
| --------------------------- | ------------------------------ |
| `tellrun start`             | 启动后台服务                   |
| `tellrun start --enable`    | 启动服务并启用开机自启         |
| `tellrun status`            | 查看服务状态与数据路径         |
| `tellrun logs`              | 查看最近 100 条日志            |
| `tellrun logs -f`           | 持续跟随日志                   |
| `tellrun restart`           | 重启服务，加载新配置或新版本   |
| `tellrun stop`              | 停止后台服务                   |
| `tellrun service uninstall` | 停止并移除服务，保留配置和状态 |

启动时会检查并启用用户 linger，使服务在退出 SSH 后继续运行。若权限不足，CLI 会显示需要在服务器执行的命令。完整命令帮助见 `tellrun --help`。

### 升级

等待当前任务结束后执行：

```sh
tellrun stop
npm install -g tellrun@latest
tellrun restart
```

配置与状态保存在 `~/.tellrun/`，全局包升级会保留这些数据。升级 Node.js 或 Tellrun 后，`restart` 会更新服务使用的 Node 和 CLI 入口路径。

## 配置与数据

运行 `tellrun setup` 创建或更新配置，已有 Bot Token 可留空保留原值。

| 路径                         | 内容                                           |
| ---------------------------- | ---------------------------------------------- |
| `~/.tellrun/config.json`     | Bot Token、授权用户 ID、Codex 路径和可选代理   |
| `~/.tellrun/state.json`      | 当前会话、工作目录、任务输入与结果、交互记录、待发送回复 |
| `~/.tellrun/tellrun.service` | Linux 后台服务定义                             |

Codex 使用同一系统用户的登录和模型配置，完整会话历史由 Codex 管理。Tellrun 不设置项目目录白名单；可访问范围由运行用户权限和 Codex 沙箱共同决定，默认采用工作区写入与按需审批策略。

### 环境变量

前台运行或自行托管进程时，可以使用环境变量覆盖配置：

| 变量                 | 用途                                            |
| -------------------- | ----------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | 机器人 Token                                    |
| `TELEGRAM_OWNER_ID`  | 允许操作机器人的数字用户 ID                     |
| `CODEX_PATH`         | Codex 命令名或可执行文件路径                    |
| `TELEGRAM_PROXY_URL` | Telegram 的 HTTP/HTTPS 代理，非空时覆盖配置文件 |

内置后台服务不会自动读取当前终端的环境变量或项目 `.env`，请使用 `tellrun setup` 保存必要配置。

### Telegram 代理

需要代理时，在已有 `~/.tellrun/config.json` 的 `telegram` 对象中添加 `"proxyUrl": "http://127.0.0.1:7890"`，再重启服务。端口和地址按实际代理调整；设置为 `""` 表示明确直连。

代理优先级为：非空 `TELEGRAM_PROXY_URL` → 配置文件中的 `telegram.proxyUrl` → 运行进程的 `https_proxy` / `HTTPS_PROXY`。使用代理时遵循 `no_proxy` / `NO_PROXY`，同名变量以小写优先。此配置仅影响 Telegram；Codex 使用其进程自身的代理环境。

## 常见问题

### 可以在手机上使用 Codex 编程吗？

可以。先在服务器上安装 Codex CLI 和 Tellrun，再通过手机或电脑上的 Telegram 与机器人私聊。代码读取、修改和命令执行都在服务器上完成，Telegram 用于发送任务、查看回复和继续对话。

### 如何获取 Telegram 用户 ID？

在启动 Tellrun 前，先向新建的机器人发送一条私聊消息，再通过 Telegram 的 [getUpdates](https://core.telegram.org/bots/api#getupdates) 接口查看该消息的 `message.from.id`：

```text
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

将 `<BOT_TOKEN>` 替换为自己的 Token。若 Tellrun 已在运行，先停止服务，避免同时轮询。

### 机器人没有回复怎么办？

确认是在私聊中使用、配置的用户 ID 正确，并查看 `tellrun logs`；前台运行时查看终端输出。同一个 Bot 不能同时由多个轮询实例使用，也不能在已有 Webhook 的情况下启动 Tellrun。

### 任务需要审批时会怎样？

机器人会展示操作内容，并根据请求提供 “Allow once”“Decline”“Stop” 按钮。权限请求的授权仅在本轮有效；拒绝后由 Codex 决定后续方案，停止会暂停接收新任务。文件审批展示路径和差异，缺少详情时只提供拒绝和停止。

结构化问题可点击选项，或使用 Telegram 的“回复”功能回答对应问题；有多个问题时，全部回答后一起提交。限定选项的问题支持回复编号或完整选项文字，允许自定义答案的问题支持自由文字。普通新消息仍补充当前任务，不会被当成审批或问题答案。等待期间可用 `/status` 查看待处理交互，或用 `/stop` 停止。

交互最多等待 10 分钟，运行时给出更短期限时采用该期限。审批或阻塞问题超时会中断任务；非阻塞问题过期时不提交任何选项，任务继续。任务结束、请求取消或服务重启后，旧按钮和问题回复失效，已记录的批准不会自动重发。

敏感输入、MCP 表单／URL 和动态工具交互仍需在本机处理。遇到不支持的请求时会中断并说明原因，检查状态后发送 `/resume` 再提交需要继续的内容。

### 服务重启后会重新执行任务吗？

尚未派发的任务会保留；执行状态不确定的任务不会自动重跑。通过 `/status` 和 `/last` 检查结果后，发送 `/resume` 恢复接收，再发送新消息。

## 本地开发

```sh
git clone https://github.com/chaoyue1998/tellrun.git
cd tellrun
npm ci
npm run build
node dist/cli.js setup
npm run dev
```

在配置向导中选择仅保存配置，再启动开发进程。开发环境与全局安装共用 `~/.tellrun/`，请先停止已有实例。也可参考仓库中的 [.env.example](https://github.com/chaoyue1998/tellrun/blob/main/.env.example)，创建 `.env` 提供开发配置。

| 命令            | 用途                     |
| --------------- | ------------------------ |
| `npm run dev`   | 监听源码并自动重启       |
| `npm run check` | 格式、静态检查与类型检查 |
| `npm run build` | 编译到 `dist/`           |
| `npm start`     | 运行编译产物             |

如果让 Codex 修改 Tellrun 自身，使用 `npm run build` 后执行 `npm start`，避免源码监听重启打断任务。

## 文档与反馈

- [架构与技术选型](https://github.com/chaoyue1998/tellrun/blob/main/docs/architecture.md)：实现、存储和部署细节。
- [产品需求与规划](https://github.com/chaoyue1998/tellrun/blob/main/docs/prd.md)：包含尚未实现的功能，当前能力以本 README 为准。
- [GitHub Issues](https://github.com/chaoyue1998/tellrun/issues)：提交问题或建议，请附上版本、复现步骤和去除凭据后的日志。

## 许可证

[MIT](https://github.com/chaoyue1998/tellrun/blob/main/LICENSE)
