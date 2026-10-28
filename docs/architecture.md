# Agent Relay 架构与技术选型

首版采用 Node.js 常驻服务，使用 grammY 接入 Telegram，使用 Codex app-server 执行任务，以 SQLite 保存会话、任务和发送记录。编码任务默认全局串行；状态、审批、补充输入和停止通过独立控制路径处理。

范围与验收见[产品需求文档](prd.md)。本方案面向个人使用，先实现 Telegram + Codex。其他 IM 与 Claude 等 Agent 是后续两个独立的扩展方向。当前已完成基础框架；下文的任务、队列、审批和恢复流程是首版目标，尚未全部实现。

本次评审保留现有技术栈和单进程结构。当前修复集中在消息确认、请求取消、重试边界及故障诊断；入站去重、任务与 outbox 的事务一致性、单实例约束和最小停止能力，作为 M1 首次执行真实任务的前置条件，不能推迟到 M2。

## 核心架构决定

| 决策 | 首版方案 | 原因与边界 |
| --- | --- | --- |
| 服务形态 | 单进程 Node.js，内部按职责分模块 | 个人使用的部署与故障定位成本低 |
| IM 框架 | grammY，Telegram 长轮询 | 入口是 Bot 消息与按钮；无需公网入站接口 |
| HTTP 框架 | 首版无需引入；需要 Webhook 或管理 API 时采用 Fastify | 避免为当前没有的 HTTP 业务增加服务层 |
| Codex 接入 | app-server，stdio 双向 JSON-RPC | 需要完整的会话、审批、问题和中断交互 |
| Codex 进程 | 一个受服务管理的常驻子进程，可承载多个已保存 thread | 首版任务串行，保持进程管理简单 |
| 数据 | SQLite + better-sqlite3 + Drizzle | 保存事务性状态与迁移；无需独立数据库服务 |
| 调度 | SQLite 任务记录 + 单个 Worker | 队列状态可恢复；控制消息不等待编码任务 |
| 消息发送 | 本地 outbox + 进度合并 | Telegram 故障不改变编码任务的执行结果 |
| 部署 | Linux 专用普通用户 + systemd | 管理启动、退出、重启和进程组 |
| 扩展 | 按 Agent、IM、核心业务和存储组织模块，共用必要的消息类型 | 保持职责清晰，不为分层额外引入基类、注册器或重复转发 |

```mermaid
flowchart TB
    TG["Telegram 私聊"]
    subgraph SERVER["Linux 服务器"]
        subgraph APP["Node.js 服务"]
            IN["Telegram 适配"]
            CORE["会话与任务协调"]
            DB[("SQLite")]
            WORKER["串行任务 Worker"]
            RPC["Codex 协议适配"]
            OUT["发送队列与进度合并"]
            IN --> CORE
            CORE --> DB
            DB --> WORKER
            WORKER <--> RPC
            CORE -->|"审批和停止"| RPC
            WORKER --> DB
            DB --> OUT
        end
        CODEX["Codex app-server 子进程"]
        FILES["工作目录与开发工具"]
        RPC <-->|"stdio JSON-RPC"| CODEX
        CODEX <--> FILES
    end
    TG -->|"长轮询"| IN
    OUT -->|"Bot API"| TG
    CODEX <--> MODEL["模型服务"]
```

Telegram 使用长轮询主动接收更新，Bot API 同时提供发送消息及按钮回调能力。[grammY 长轮询说明](https://grammy.dev/guide/deployment-types)

Codex app-server 提供线程、轮次、执行事件与审批交互；官方把需要这些能力的自定义客户端指向 app-server。它目前仍标记为实验性，因此 M0 必须固定 CLI 版本并验证协议，不能只凭类型定义判定兼容。[OpenAI 官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)、[SDK 使用边界](https://learn.chatgpt.com/docs/codex-sdk)

## 框架与库

下列应用依赖已在 2026 年 10 月 28 日安装并固定至 lockfile；Codex 的目标 Linux 协议兼容性仍由 M0 验证。运行时和 Codex 升级分别验证，不在服务启动时自动追随 latest。

| 用途 | 选择 | 版本 / 状态 | 使用方式 |
| --- | --- | --- | --- |
| 运行时 | Node.js | 24.22.1 | `.nvmrc` 指定版本，通过 nvm 切换；ESM，生产运行编译后的 JavaScript |
| 包管理 | npm | 使用 Node.js 自带版本 | 提交 `package-lock.json`，使用 `npm ci` 安装 |
| 语言 | TypeScript | 7.0.2 | strict + NodeNext；类型检查与构建 |
| Telegram | grammy | 1.46.0 | 消息、命令、InlineKeyboard、回调、长轮询 |
| Telegram 重试 | @grammyjs/auto-retry | 2.0.2 | 429、5xx 最多重试两次；网络错误上抛；整次调用另设超时 |
| 数据库驱动 | better-sqlite3 | 13.0.3 | 本地 SQLite，短事务，启用 WAL |
| 数据访问 | drizzle-orm | 0.45.4 | 类型化表结构和查询 |
| 数据库迁移 | drizzle-kit | 0.31.11 | 生成迁移并纳入版本控制 |
| 数据校验 | zod | 4.6.7 | 配置及应用边界数据校验 |
| 日志 | pino | 10.4.0 | JSON 日志、关联标识与脱敏 |
| 开发运行 | tsx | 4.23.15 | 本地监听与调试；生产用 tsc 构建产物 |
| 测试 | 暂不引入 | 未安装 | 本轮仅进行静态检查、类型检查与编译验证 |
| 格式与静态检查 | @biomejs/biome | 2.6.3 | 保持一套格式化与 lint 工具 |
| Codex | Codex CLI | 本机检测到 0.165.0 | 目标 Linux 验证后固定；生成对应协议类型 |

Node.js 24 当前列为 LTS；grammY 提供 Node.js / TypeScript 开发路径。auto-retry 的 `maxDelaySeconds` 限制 Telegram 返回的 `retry_after`，不代表所有请求的总超时。当前安装版本的网络错误重试不消耗 `maxRetryAttempts`，因此显式启用 `rethrowHttpErrors`，并为整次调用设置可取消的截止时间。[Node.js](https://nodejs.org/en/download)、[grammY](https://grammy.dev/guide/getting-started)、[auto-retry](https://grammy.dev/plugins/auto-retry)

Drizzle 支持 better-sqlite3 驱动。当前文档示例包含 RC 安装命令，首版选用上表的稳定发布基线；迁移工具和 ORM 版本配套验证。better-sqlite3 使用同步接口，数据库事务应短小，不能在事务内等待 Codex 或网络。13.0.3 包内已包含常见平台的预编译二进制，目标 Linux 环境仍需验证驱动加载。[Drizzle SQLite](https://orm.drizzle.team/docs/sqlite/get-started-sqlite)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

库版本依据各包的 npm 元数据，可从 [grammy](https://www.npmjs.com/package/grammy)、[Drizzle](https://www.npmjs.com/package/drizzle-orm)、[better-sqlite3](https://www.npmjs.com/package/better-sqlite3)、[TypeScript](https://www.npmjs.com/package/typescript) 等包页面复核。工程配套使用 npm，@types/node 与 Node.js 24 对齐。

首版的应用框架选 grammY。Fastify 留给后续 HTTP 入口；NestJS 的模块和依赖注入体系暂时没有对应需求。Codex 已承担 Agent 执行循环，因此首版直接接入其运行时。SQLite 中的任务记录是队列事实来源，当前规模无需 Redis / BullMQ。

## 模块组织与依赖方向

| 模块 | 职责 |
| --- | --- |
| src/main.ts | 组装组件、数据库迁移、启动和退出；只在这里选择具体 IM 与 Agent |
| src/config.ts、src/logger.ts | Telegram 凭据与本人身份校验、结构化日志 |
| src/im/telegram.ts | grammY 接入、本人验证、入站标准化、回复与连接生命周期 |
| src/agents/codex.ts | Codex 接入；当前只检查 CLI，M0 后补充 app-server 连接与协议转换 |
| src/core/service.ts | 平台无关的命令与业务处理；后续逐步加入会话和任务协调 |
| src/core/types.ts | 实际跨模块复用的来源、消息、回复与处理函数类型 |
| src/storage/index.ts、src/storage/schema.ts | SQLite 连接、自动迁移、表结构和实际需要的存储操作 |
| src/storage/migrate.ts | 独立迁移入口，不依赖 Telegram 凭据 |
| migrations/ | 受版本控制的 SQL 迁移与 Drizzle 元数据 |

Telegram SDK 类型仅在 IM 连接模块使用，Codex RPC 类型仅在 Agent 模块使用。核心层只处理应用自己的消息与回复，通过存储模块暴露的操作读写状态；不直接使用 grammY、Drizzle 或 Codex 协议。IM 来源标识统一为字符串，避免把 Telegram 数字 ID 的假设带到其他平台。

当前依赖关系为 `main → 组件组装`，`im → 统一消息处理入口 → core → 存储操作`。CLI 检查在启动时完成，结果传给核心层用于状态展示。需要任务 Worker、outbox 或协议类型时，在相应目录添加实际模块，不预建空文件或多层接口包装。

按实际复用抽取函数和共享类型，新增前检查现有定义。避免为单一用途拆出多层 Controller / Service / Repository、抽象基类和通用插件注册器；对公开函数、关键逻辑和必要常量添加简洁中文 JSDoc。

## 入站消息与执行流程

以下是 M1 的任务接入要求。当前只处理帮助、状态及未启用提示，仍在入站处理中直接回复；接入真实任务前须把发送改为持久化 outbox，不能沿用直接回复的成功与否决定任务是否接收。

1. grammY 收到 Update，先验证授权用户和私聊范围。

2. 标准化消息保留平台、账号、事件 ID、消息 ID、回复目标和命令参数。使用平台 + 账号 + 事件 ID 去重，在同一 SQLite 事务中保存入站记录、任务及回执发送意图，并在创建任务时固定会话和工作目录快照。重复事件返回已有结果，不重复创建任务。

3. 事务提交后结束入站处理，把耗时执行交给 Worker；不能在 Bot handler 中等待整个 Codex turn。

4. Worker 在事务中把 queued 任务领取为 dispatching，读取该任务在接收时已经固定的会话和工作目录快照。

5. 创建或恢复 Codex thread，发送 turn/start，记录 threadId 和 turnId。

6. 事件更新任务状态，并合并为进度发送意图；完成后保存最终结果和最终通知。

7. delivery 独立发送或编辑 Telegram 消息，按失败类别重试。

入站持久化失败时停止拉取新批次并退出恢复。当前连接器使用 `getUpdates` 和 `handleUpdate` 显式维护 offset，只有处理成功才推进；不使用会自动删除 Webhook 的 `bot.start` 或会确认最后一次尝试消息的 `bot.stop`。收到关停信号后取消读取，等待当前处理结束，不额外确认更新。失败消息和未处理批次保留重投机会，成功但尚未确认的消息也可能重投，因此不能替代 M1 的数据库去重。[Telegram 更新接收规则](https://core.telegram.org/bots/api#getupdates)、[grammY 生命周期](https://grammy.dev/ref/core/bot)

当前会话写入可重复执行，但回复可能重复；还没有入站记录和 outbox。Telegram 不提供无限期保留更新的保证，长期离线后的恢复不能只依赖服务端消息队列。

控制路径包括 /status、/stop、审批回调、明确回复补充问题。它们不进入编码任务队列。等待审批占用当前编码任务槽，但不会占用 Node.js 事件循环。入站处理只做短事务和控制派发，不等待 Codex 完成或普通 Telegram 消息发送，避免慢请求把后续停止指令堵在同一批次中。

切换会话或变更会话工作目录只影响之后创建的任务。每个已接收任务保存自己的 conversation_id 和 cwd，不能在真正执行时重新读取当前会话设置并悄悄换目标。M1 必须定义明确的目录输入方式；未指定目录且会话也未绑定目录时先要求补充，不能隐式使用 Relay 自身目录。接收时校验绝对目录并规范化路径，执行前再次核对；目录缺失或指向改变时停止该任务，不自动换目录，也不增加目录白名单。

全局并发默认 1，待执行队列建议上限 20，满时明确提示并不创建任务。这些是产品初始配置值，不是库的默认值。未来开启并行时，必须增加按可写工作区的互斥；有多个 thread 并不意味着可以同时修改同一目录。

## 会话与数据模型

当前不实现项目列表或项目选择，也不要求 `projects.json`。Relay 不设置项目目录白名单；后续任务执行使用用户指定或当前会话沿用的工作目录。

当前框架仅创建 `channels` 表，保存 platform、account_id、chat_id、user_id 及创建和更新时间，来源组合唯一；不保存聊天正文。下面列出的完整业务表及字段随相关功能逐步实现。

应用 conversation ID 与 Codex thread ID 分开保存。同一个聊天可新建和继续多个 conversation，各自保留 Agent 上下文和工作目录。首版不支持将一个现有会话切换为另一个 Agent。

| 表 | 核心数据与约束 |
| --- | --- |
| channels | platform、account_id、chat_id、user_id、当前会话、queue_paused；来源组合唯一，首版不支持 topic |
| conversations | 应用 ID、来源聊天、cwd、agent_type、agent_session_id、标题和最后使用时间；首版 agent_type 为 codex |
| inbound_updates | platform、account_id、event_id、接收时间及必要标准化内容；组合唯一，用于防重复处理 |
| tasks | conversation_id、来源更新、cwd 快照、输入、status、turn_id、结果、错误及时间；来源更新唯一，重试必须由新事件另建记录并保存原任务 ID |
| interactions | task_id、类型、RPC request ID、进程 generation、操作者、状态、有效期和答案；generation 与 RPC request ID 组合唯一，可保存多个并发请求 |
| outbox | 聊天目标、task_id、发送类别、文本、Telegram message_id、版本、重试时间及状态；业务发送键唯一 |

SQLite 开启 WAL、外键和适当 busy_timeout。同步查询保持短小；按任务状态和创建时间建立领取索引，按会话和时间建立查询索引。Worker 在事务内检查全局活动槽并条件领取任务，不能先查询 queued 后再无条件更新。会话、任务、交互和发送记录使用外键关联；历史清理不能删除仍被引用或尚未完成的记录。

完整 Agent 上下文继续由 Codex 管理。应用保存路由关系、任务输入、最终输出及必要摘要，不把所有 token delta 永久写入数据库。历史查询通过运行时支持的接口完成，避免依赖 Codex 私有数据库格式。

## Codex 协议与生命周期

Node.js 使用内置 child_process.spawn 启动 codex app-server，参数以数组传入且 shell 为 false。使用 stdin/stdout 的 JSONL 承载双向 RPC，线上消息省略 `jsonrpc` 字段；stderr 只提取必要诊断，不把可能含正文或凭据的原始内容直接转存。stdout 不能混入应用日志。

每个连接先发送 `initialize` 并等待响应，再发送 `initialized` 通知，之后才能创建或恢复 thread；普通消息启动 turn；中断通过 turn/interrupt 请求。只根据 turn/completed 的实际状态判定完成、失败或中断。请求超时、进程退出和没有收到事件，都不等价于成功。[协议与生命周期](https://learn.chatgpt.com/docs/app-server)

| 协议工作 | 首版要求 |
| --- | --- |
| 类型 | 由固定版本 CLI 的 generate-ts 生成；应用边界另做必要运行时校验 |
| 请求关联 | 使用请求 ID 关联 Promise；RPC 响应、事件通知、服务端请求分别分发 |
| 多会话路由 | 每次启动生成跨服务重启也不重复的 generation，同时核对 threadId、turnId 和当前 task；尚未拿到 turnId 的早到事件暂存后关联 |
| 事件次序 | 允许通知早于 RPC 响应；终态不能被迟到响应改回 running |
| 文本与工具事件 | 文本增量累积，工具事件转摘要；限制单行、待关联事件和待发送缓冲，处理 stdin 背压；溢出时明确中断，不能静默丢失终态 |
| 未支持请求 | 明确返回不支持并提示用户，不悄悄批准，也不无限等待 |
| 子进程异常 | 清理该 generation 的待响应请求；活动任务进入 interrupted |
| 重新启动子进程 | 仅恢复通信和已保存会话入口；不会自动重发上次 turn/start |

M0 要验证当前运行时的普通文本澄清问题如何呈现。若问题并非结构化事件，按普通回复展示，用户下一条消息自然续聊；不靠关键词猜测并伪造一个权限请求。

Codex 模型、provider 和认证优先沿用服务用户已有配置。应用只覆盖明确设置的选项；模型列表不能作为实际账号可用性的保证。

## 审批与补充输入

每个待处理交互都有独立的应用 ID。Telegram callback_data 只携带短的随机标识和选择，完整 RPC ID 及上下文保存在数据库和当前运行时中。按钮处理同时校验本人身份、聊天来源、任务、进程 generation、有效期和未处理状态。

用户点击后及时答复 callback query，同时以条件更新领取该选择，成功领取后才发送对应 RPC 响应。按钮应答只是关闭客户端等待提示，不是授权提交依据；应答超时或回调过期不能阻止已经持久化的决定转发，也不能触发第二次转发。旧按钮、重复点击或进程已经更换时只提示失效，不向新的任务发送任何答案。[Telegram 按钮回调](https://core.telegram.org/bots/api#callbackquery)

| 交互类型 | 处理方式 |
| --- | --- |
| 命令或文件操作审批 | 根据运行时允许的选项映射允许、拒绝或取消；首版以单次授权为主 |
| 网络或文件系统权限请求 | 仅返回所批准的权限子集，作用域限制到当前请求所允许的范围 |
| 结构化用户问题 | 按 question ID 保存和返回答案；支持选项及明确回复 |
| 未支持的表单、URL 或动态工具请求 | 明确说明限制，返回相应拒绝或不支持结果，提供停止入口 |

具体响应结构以该版本生成的协议为准，不能对所有类型套用同一个 accept / decline 对象。应用默认审批有效期建议 10 分钟；运行时若给出更早的自动解决时限，采用较早期限；请求解决、取消或 turn 结束时立即使对应按钮失效。服务端已解决通知、超时和用户点击发生竞争时，至多转发一个决定。领取成功到 RPC 写入之间发生故障时记录不确定状态，不自动重放批准；重建进程后作废旧交互。

默认拟用工作区可写与按需审批。它保留 Codex 的实际权限判断；应用不会把“全部允许”作为默认运行模式。

## 任务状态与恢复语义

| 状态 | 含义及允许的后续动作 |
| --- | --- |
| queued | 已持久化，尚未向 Codex 派发；可取消或等待领取 |
| dispatching | 即将或已经发送启动请求，执行结果仍可能不确定 |
| running | 已确认执行中 |
| waiting_approval | 存在阻塞执行的待审批请求 |
| waiting_input | 存在阻塞执行的结构化补充问题 |
| cancelling | 已发起停止，尚未确认终止 |
| completed | 运行时明确确认成功完成 |
| failed | 运行时明确返回失败，或应用确认尚未派发执行便发生不可恢复错误 |
| cancelled | 排队任务被取消，或用户停止后收到确定的中断终态 |
| interrupted | 连接或进程故障导致执行状态无法确认 |

普通路径为 queued → dispatching → running → completed / failed。等待交互解决后返回 running；仍有其他阻塞请求时继续等待。非阻塞问题保持 running，并单独显示待回答交互。终态记录不可被迟到事件覆盖。

停止操作把当前聊天的 queue_paused 设为 true，请求中断活动 turn 并作废其待处理按钮。收到实际终态后再更新界面。无法确认退出时，先结束受管理进程组并记录 interrupted；确认没有旧进程继续写入后，才允许恢复后续任务。

正常关停先停止入站轮询、保存已接收数据，再请求活动任务中断并等待退出。异常重启后，queued 记录保留；dispatching、running、waiting_approval、waiting_input 和 cancelling 统一进入 interrupted，旧交互失效。与异常任务相关的队列保持暂停，用户检查已有结果后明确选择继续。

恢复上下文可以使用保存的 Agent 会话 ID；原来的活动 RPC 等待不能跨进程恢复。继续或重试创建新的 task，保留与原任务的关联。

一致性目标是：同一入站事件只创建一个任务，明确的终态只生效一次，结果不确定的执行不自动重放。Telegram、数据库和 Codex 之间没有共同事务，因此不宣称端到端 exactly-once。

尤其在“Codex 已收到 turn/start，但数据库尚未记下 turnId”这一窗口崩溃时，必须保留不确定状态，不能因为没拿到响应就自动重发。

## Telegram 输出与故障恢复

delivery 从 outbox 读取已持久化的发送意图。接收回执、审批和最终结果优先于普通进度；进度只保存最新待发送版本，默认每 2 秒最多编辑一次同一条消息。

首版输出纯文本和 InlineKeyboard，避免流式半段内容导致格式解析失败。长回复按段落和安全长度分块，保证最终内容完整；状态信息只包含用户有用的会话、工作目录、进度与操作，不展示 RPC ID 等内部实现标识。

Telegram 429 按 retry_after 等待；其他可恢复的网络错误使用有限次数退避重试。超过当前尝试上限后保留 outbox，稍后恢复发送。对“已经发送但响应丢失”的场景，Telegram 侧可能出现重复通知，应用不能据此重跑编码任务。

auto-retry 的作用域仅限 Telegram API。当前基础框架的普通请求总时限为 15 秒，长轮询为 40 秒；429、5xx 最多重试两次，`retry_after` 超过 5 秒或网络错误直接上抛，最终以非零状态退出。故障恢复依赖人工或进程管理器重启，尚未实现上一段的 outbox 发送重试。M1 引入 outbox 后由发送记录保存重试时间，耗时等待不占用入站处理。Codex turn/start、审批回传和其他可能产生副作用的操作按各自状态机处理，不使用统一自动重试包装。

进度发送积压不能阻塞 Codex 事件读取。等待审批时遇到 Telegram 断线，保留请求至有效期；恢复后只重发仍有效的交互，不复活过期按钮。

## 配置与部署

当前只要求使用者填写 `.env` 中的 Telegram 凭据和本人 ID。数据库路径、Codex 命令和日志级别采用固定约定，出现实际需求后再增加配置项。

| 配置项 | 保存位置与约束 |
| --- | --- |
| Telegram Bot Token | 服务环境或权限受限的 EnvironmentFile |
| 本人用户 ID | `.env` 中的 TELEGRAM_OWNER_ID；不依赖可修改的 username |
| 工作目录 | 后续由任务或会话指定，不设置目录白名单 |
| Codex 命令 | 通过 PATH 调用 `codex`，沿用服务用户的 CLI 配置 |
| 应用数据库 | `data/agent-relay.db` |
| 日志级别 | 当前固定为 info |
| 队列与交互设置 | 规划默认并发 1、队列上限 20、审批 10 分钟、进度间隔 2 秒；当前未实现，不预建配置项 |

单一 systemd 服务管理应用，使用专用普通 OS 用户，设置 WorkingDirectory、Restart=on-failure 和重启退避。建议 KillMode=control-group，避免父进程退出后旧 Codex 进程继续修改文件；停止等待须覆盖入站处理和子进程退出期限。M1 启动 Worker 前必须取得同一数据库对应的排他运行锁，取得锁后才进行恢复；不能把 Telegram 的 409 冲突当成编码任务互斥。锁的实现随目标 Linux 部署验证，当前尚未提供单实例执行保证。

Codex 子进程只接收必要环境与运行时凭据，不默认继承 Telegram Token。Relay 直接向 Agent 传递任务工作目录，不通过项目清单限制目录；实际文件访问仍沿用 Codex 与 OS 的权限配置。

当前启动检查包括 Telegram 配置、数据库迁移、Codex CLI 版本格式、Telegram 连接和 Webhook 状态，不验证 Codex 认证或模型访问。M0 需在目标 Linux 核实协议与认证，M1 再加入运行时就绪检查。遇到 Webhook 或另一轮询实例时给出明确错误，不自动接管其他部署；401 与 409 分别记录身份和冲突诊断，日志只保留错误类别与错误码。

备份使用 SQLite 在线备份机制，并保留对应 Codex 会话数据；启用 WAL 时不能仅复制一个正在写入的 .db 文件。应用数据库的普通恢复与 Codex 认证凭据管理分别处理。

日志使用 Pino，携带 task_id、conversation_id 和阶段；默认不记录完整 prompt、Token 或原始环境变量。首版通过 /status 和 systemd / journalctl 诊断，暂不提供公网管理接口。

## 后续扩展规则

其他 IM 的新增工作集中在消息与回调标准化、发送与编辑能力、身份绑定和限流。新平台接入后，复用会话、任务、交互和恢复流程；默认新建独立的聊天绑定。跨 IM 共享同一个会话必须通过显式绑定，不能只因用户名相同自动合并。

Claude 等 Agent 的新增工作集中在会话创建或恢复、任务输入、执行事件、审批与停止。计划中的 conversations 表将保存 agent_type 和 agent_session_id；当前数据库尚无这些字段。两种 Agent 的原生上下文不能直接互换，切换运行时应新建会话。

新增 IM 或 Agent 时，先在对应目录新增实现，复用已有消息与业务边界；只有出现实际重复逻辑时再抽取公共接口，并明确能力差异。首版不实现动态加载插件、远程 Worker 集群或通用 Agent 编排。

## 验证与交付标准

以下为后续功能验收目标。按当前要求，不添加测试文件、测试命令或测试依赖；当前通过格式、静态检查、类型检查与构建验证。它们不替代真实 Telegram、Codex 和目标 Linux 环境的协议与故障演练。

| 验证层 | 重点 |
| --- | --- |
| 协议契约 | 初始化、创建与恢复会话、增量事件、审批、问题、中断；固定版本的合法响应结构 |
| 状态与数据库 | 入站唯一键、任务领取、迟到事件、审批竞争、终态不可回退 |
| 故障恢复 | 数据库提交失败、子进程退出、启动响应丢失、父进程重启、旧按钮点击 |
| Telegram | 429、网络错误、长文本、编辑失败、重复 Update、快速回调确认 |
| 控制响应 | Codex 持续运行或等待审批时，状态查询与停止仍可用 |
| 端到端 | 两个临时工作目录、多轮对话、拒绝审批、停止、重启后恢复、连续运行 |

后续验收以这些可观察行为为目标，真实 Codex 端到端验证仅在临时工作区执行。M0 固定 CLI 版本和生成的协议，保存初始化、审批、补充问题和中断的验证记录；M1 再交付带去重、持久化发送、最小停止及不确定状态恢复的执行链路。
