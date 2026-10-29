# Tellrun — 通过 Telegram 远程使用 OpenAI Codex

**Tellrun 是可自行部署的 Telegram 机器人，基于 OpenAI Codex CLI 提供远程 AI 编程、持久化会话和流式回复。**

在服务器上运行 Tellrun，即可通过手机或电脑上的 Telegram 提交编码任务、继续对话和查看执行结果，无需一直保持 SSH 终端连接。

[English](https://github.com/chaoyue1998/tellrun/blob/main/README.md) | **简体中文**

[npm](https://www.npmjs.com/package/tellrun) · [GitHub](https://github.com/chaoyue1998/tellrun) · [问题反馈](https://github.com/chaoyue1998/tellrun/issues)

[快速开始](#安装并通过-telegram-使用-codex) · [Telegram 命令](#telegram-命令) · [终端命令](#终端命令) · [配置](#配置与数据) · [常见问题](#常见问题) · [本地开发](#本地开发)

## 功能

- **远程编码**：在 Telegram 私聊中发送任务，由服务器上的 Codex 执行。
- **连续对话**：保留当前会话上下文，通过 `/cwd` 指定项目目录，通过 `/new` 开始新会话。
- **即时反馈**：显示输入状态与流式回复，执行期间可以继续发送文字补充要求。
- **任务控制**：查看状态和最近结果，停止任务并暂停接收；重启后保留当前会话与任务状态。
- **审批与提问**：通过按钮处理命令、文件和权限审批；点击选项或明确回复对应问题，多题全部回答后提交。

## 安装并通过 Telegram 使用 Codex

### 1. 准备环境

- **Node.js ≥ 24.5.0**。
- **[Codex CLI](https://github.com/openai/codex)**：在运行 Tellrun 的同一系统用户下安装并完成登录，确认可以在终端正常使用。

### 2. 安装并配置

```sh
npm install -g tellrun
tellrun setup
```

### 3. 在 Telegram 中开始对话

打开与机器人的私聊，依次发送以下消息，将示例目录替换为服务器上实际存在的项目绝对路径：

```text
/start
/cwd /home/you/projects/my-app
帮我了解这个项目，说明主要模块和启动方式。
```

未设置 `/cwd` 时，工作目录默认为服务启动目录；后台服务默认使用当前用户的主目录。切换目录会开始新会话。

## Telegram 命令

| 命令                  | 作用                                       |
| --------------------- | ------------------------------------------ |
| `/start`、`/help`     | 查看使用说明                               |
| `/cwd`                | 查看当前工作目录                           |
| `/cwd /absolute/path` | 切换工作目录并开始新会话                   |
| `/new`                | 开始新会话，保留工作目录                   |
| `/status`             | 查看连接、会话、目录和任务状态             |
| `/last`               | 查看最近已结束任务的状态与结果             |
| `/stop`               | 请求停止当前任务，并暂停接收新任务         |
| `/resume`             | 恢复接收新任务，不会重新执行此前中断的任务 |

切换目录或新建会话前，需要等待当前任务结束。使用 `/stop` 后，先检查最终状态，再发送 `/resume` 和新的任务内容。

## 终端命令

在运行 Tellrun 的电脑或服务器上执行以下命令。

| 命令                        | 作用                                             |
| --------------------------- | ------------------------------------------------ |
| `tellrun start`             | 启动后台服务                                     |
| `tellrun start --enable`    | 启动服务并启用自动启动：Linux 开机、macOS 登录时 |
| `tellrun status`            | 查看服务状态与数据路径                           |
| `tellrun logs`              | 查看最近 100 条日志                              |
| `tellrun logs -f`           | 持续跟随日志                                     |
| `tellrun restart`           | 重启服务，加载新配置或新版本                     |
| `tellrun stop`              | 停止后台服务                                     |
| `tellrun service uninstall` | 停止并移除服务，保留配置和状态                   |
| `tellrun --help`            | 查看命令帮助                                     |

### 升级

```sh
tellrun stop
npm install -g tellrun@latest
tellrun restart
```

配置与状态保存在 `~/.tellrun/`，全局包升级会保留这些数据。升级 Node.js 或 Tellrun 后，`restart` 会更新服务使用的 Node 和 CLI 入口路径。

## 配置与数据

运行 `tellrun setup` 创建或更新配置，已有 Bot Token 可留空保留原值。

| 路径                         | 内容                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| `~/.tellrun/config.json`     | Bot Token、授权用户 ID、Codex 路径和可选代理                             |
| `~/.tellrun/state.json`      | 当前会话、工作目录、活动任务、最近结果、待处理交互与回复、未确认事件标识 |
| `~/.tellrun/tellrun.service` | Linux 后台服务定义                                                       |
| `~/.tellrun/tellrun.plist`   | macOS 后台服务定义                                                       |
| `~/.tellrun/tellrun.log`     | macOS 服务诊断日志，可通过 `tellrun logs` 查看                           |

Codex 使用同一系统用户的登录和模型配置，完整会话历史由 Codex 管理。Tellrun 不设置项目目录白名单；可访问范围由运行用户权限和 Codex 沙箱共同决定，默认采用工作区写入与按需审批策略。

Tellrun 只保留活动任务和每个聊天的最近结果，供 `/last` 查看。已确认的去重标识、关闭的交互在不再需要时回收；待发送回复保留到发送成功或永久拒绝。任务历史由 Codex 保存，Tellrun 日志仅用于服务启停、连接和存储故障诊断。

### 配置参数

`~/.tellrun/config.json` 的参数配置：

| 参数                | 类型               | 要求 / 默认行为                | 说明                                                                                       |
| ------------------- | ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `telegram.token`    | 字符串             | 必填，无默认值                 | 从 BotFather 获取的机器人 Token。                                                          |
| `telegram.ownerId`  | 正整数或数字字符串 | 必填，无默认值                 | 本人 Telegram 数字用户 ID，用于授权访问，不是 `@用户名`。建议使用数字形式。                |
| `telegram.proxyUrl` | 字符串             | 可选；省略时继承运行环境的代理 | 支持 `http://` 或 `https://` 代理地址；设为 `""` 时明确直连。                              |
| `codexPath`         | 字符串             | 可选，默认 `"codex"`           | Codex 命令名或可执行文件路径。命令名按 `PATH` 查找；`tellrun setup` 保存解析后的绝对路径。 |

配置在进程启动时读取。手动修改后运行 `tellrun restart`。

## 常见问题

### 机器人没有回复怎么办？

确认是在私聊中使用、配置的用户 ID 正确，并查看 `tellrun logs`；前台运行时查看终端输出。同一个 Bot 不能同时由多个轮询实例使用，也不能在已有 Webhook 的情况下启动 Tellrun。

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

## 许可证

[MIT](https://github.com/chaoyue1998/tellrun/blob/main/LICENSE)
