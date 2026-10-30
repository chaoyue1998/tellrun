# Tellrun — 通过 Telegram 远程使用 OpenAI Codex

**Tellrun 是可自行部署的 Telegram 机器人，基于 OpenAI Codex CLI 提供远程 AI 编程、持久化会话和流式回复。**

在服务器上运行 Tellrun，即可通过手机或电脑上的 Telegram 提交编码任务、继续对话和查看执行结果，无需一直保持 SSH 终端连接。

[English](https://github.com/chaoyue1998/tellrun/blob/main/README.md) | **简体中文**

[npm](https://www.npmjs.com/package/tellrun) · [GitHub](https://github.com/chaoyue1998/tellrun) · [问题反馈](https://github.com/chaoyue1998/tellrun/issues)

[快速开始](#安装并通过-telegram-使用-codex) · [Telegram 命令](#telegram-命令) · [终端命令](#终端命令) · [配置](#配置与数据) · [常见问题](#常见问题) · [本地开发](#本地开发)

## 功能

- **远程编码**：在 Telegram 私聊中发送任务，由服务器上的 Codex 执行。
- **图片与文件**：发送截图、照片或文件，并附带任务说明；执行中也可以追加附件。
- **会话管理**：通过 `/cwd` 指定项目目录，用 `/new` 创建命名会话，通过 `/list` 和 `/switch` 查找并继续历史对话。
- **即时反馈**：显示输入状态与流式回复，执行期间可以继续发送文字补充要求。
- **任务控制**：查看状态和最近结果，停止任务并暂停接收；重启后保留当前会话与任务状态。
- **审批与提问**：通过按钮处理命令、文件和权限审批；点击选项或明确回复对应问题，多题全部回答后提交。
- **权限选择**：通过 `/permissions` 选择 Codex 的四种权限模式，选择会保存并用于后续任务。

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

服务启动时自动注册英文命令菜单，可通过聊天输入框旁的菜单按钮或输入 `/` 选择命令。

| 命令                  | 作用                                           |
| --------------------- | ---------------------------------------------- |
| `/start`、`/help`     | 查看使用说明                                   |
| `/cwd`                | 查看当前工作目录                               |
| `/cwd /absolute/path` | 切换工作目录并开始新会话                       |
| `/new [名称]`         | 创建并切换到新会话，名称可省略                 |
| `/list`               | 列出当前项目的会话，标记当前会话               |
| `/switch <id>`        | 使用 `/list` 中的完整 ID 切换会话              |
| `/model`              | 查看当前选择，通过按钮选择模型和推理强度       |
| `/permissions`        | 选择后续任务的权限模式                         |
| `/status`             | 查看版本更新、连接、目录、会话 ID、模型、权限和任务状态 |
| `/update`             | 将 Tellrun 升级信息交给 Codex 执行             |
| `/last`               | 查看最近已结束任务的状态与结果                 |
| `/stop`               | 请求停止当前任务，并暂停接收新任务             |
| `/resume`             | 恢复接收新任务，不会重新执行此前中断的任务     |

切换目录、新建或切换会话前，需要等待当前任务结束；运行中仍可使用 `/list`。使用 `/stop` 后，先检查最终状态，再发送 `/resume` 和新的任务内容。

会话由 Codex 保存。`/list` 按最近更新时间列出工作目录完全一致的未归档会话，包含 Tellrun 和其他 Codex 客户端创建的会话，不包含子 Agent。`/new` 省略名称时使用 `New session`，空会话也会保存。新建和切换会话保留当前模型与权限选择；收到成功确认后再发送任务，创建结果无法确认时先用 `/list` 检查，再决定是否重试。

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
| `~/.tellrun/attachments/`   | 用户上传的图片与文件，按独立标识保存，避免同名覆盖 |
| `~/.tellrun/tellrun.service` | Linux 后台服务定义                                                       |
| `~/.tellrun/tellrun.plist`   | macOS 后台服务定义                                                       |
| `~/.tellrun/tellrun.log`     | macOS 服务诊断日志，可通过 `tellrun logs` 查看                           |

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

确认是在私聊中使用、配置的用户 ID 正确。检查运行 Tellrun 的设备能否正常访问 Telegram；如使用代理，确认代理配置正确且连接可用。查看 `tellrun logs` 排查错误；前台运行时查看终端输出。

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
