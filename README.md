# Tellrun — Telegram Bot for OpenAI Codex

**Tellrun is a self-hosted Telegram bot for remote AI coding with OpenAI Codex CLI, persistent sessions, and streaming replies.**

Run Tellrun on your server and use Telegram on your phone or desktop to send coding tasks, continue conversations, and read results without keeping an SSH terminal open.

**English** | [简体中文](https://github.com/chaoyue1998/tellrun/blob/main/README.zh-CN.md)

[npm](https://www.npmjs.com/package/tellrun) · [GitHub](https://github.com/chaoyue1998/tellrun) · [Report an issue](https://github.com/chaoyue1998/tellrun/issues)

[Quick start](#install-and-connect-codex-to-telegram) · [Telegram commands](#telegram-commands) · [Configuration](#configuration-and-data) · [FAQ](#faq)

## Features

- **Remote coding**: send tasks in a private Telegram chat and let Codex execute them on your server.
- **Continuous conversations**: keep the current conversation context, select a project with `/cwd`, and start fresh with `/new`.
- **Live feedback**: see typing indicators and streaming replies, and send additional instructions while a task is running.
- **Task control**: check status and recent results, stop a task and pause new work, and retain conversation and task records across restarts.
- **Personal deployment**: only the configured user's private messages are accepted. Long polling requires no webhook or inbound port configuration.

Currently supports **Telegram + Codex** for one user, with one task at a time. A session picker, a queue of separate tasks, approval and structured question interfaces, and image or file input are not yet supported.

The CLI setup wizard and bot status messages are currently in Chinese.

## Install and connect Codex to Telegram

### 1. Prerequisites

- **Node.js ≥ 24.5.0**.
- **[Codex CLI](https://github.com/openai/codex)**: install and sign in as the same operating system user that will run Tellrun. Confirm that Codex works in your terminal.
- **Telegram Bot Token**: send `/newbot` to [@BotFather](https://t.me/BotFather), follow the prompts, and save the token. See the [official Telegram tutorial](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
- **Your numeric Telegram user ID**: this is not your `@username`. See [how to find it](#how-do-i-find-my-telegram-user-id).

Background service management requires **Linux with systemd user services**. Use `tellrun run` in the foreground for local development or with another process manager.

### 2. Install and configure

```sh
npm install -g tellrun
tellrun setup
```

Enter your Bot Token, numeric user ID, and Codex command or executable path. On Linux, the setup wizard can start the background service and optionally enable it at boot.

If you choose to save the configuration without starting the service, run this later:

```sh
tellrun start --enable
```

To run in the foreground instead:

```sh
tellrun run
```

### 3. Start chatting in Telegram

Open a private chat with your bot and send these messages one at a time. Replace the example path with an existing absolute project path on your server:

```text
/start
/cwd /home/you/projects/my-app
Help me understand this project. Explain its main modules and how to run it.
```

Send more text to continue the same conversation. Messages sent while a task is running become additional instructions for that task. For example:

```text
Focus on the login flow. Analyze the problem and suggest changes first.
```

Without `/cwd`, the working directory defaults to the directory where the service starts. The systemd service starts in the current user's home directory. Changing directories starts a new conversation.

## Telegram commands

| Command | Purpose |
| --- | --- |
| `/start`, `/help` | Show usage instructions |
| `/cwd` | Show the current working directory |
| `/cwd /absolute/path` | Change the working directory and start a new conversation |
| `/new` | Start a new conversation while keeping the working directory |
| `/status` | Show connection, conversation, directory, and task status |
| `/last` | Show the latest task's status and result |
| `/stop` | Request that the current task stop and pause new tasks |
| `/resume` | Accept new tasks again without rerunning an interrupted task |

Wait for the current task to finish before changing directories or starting a new conversation. After `/stop`, check the final status, then send `/resume` followed by your next task.

## Background service

These commands manage a Linux systemd user service:

| Command | Purpose |
| --- | --- |
| `tellrun start` | Start the background service |
| `tellrun start --enable` | Start the service and enable it at boot |
| `tellrun status` | Show service status and data paths |
| `tellrun logs` | Show the latest 100 log entries |
| `tellrun logs -f` | Follow logs |
| `tellrun restart` | Restart with the current configuration or installed version |
| `tellrun stop` | Stop the background service |
| `tellrun service uninstall` | Stop and remove the service, keeping configuration and state |

On startup, Tellrun checks and enables user lingering so the service can continue after you disconnect from SSH. If permissions are insufficient, the CLI prints the command to run on your server. Use `tellrun --help` for full CLI help.

### Upgrade

Wait for the current task to finish, then run:

```sh
tellrun stop
npm install -g tellrun@latest
tellrun restart
```

Configuration and state live in `~/.tellrun/` and are preserved when upgrading the global package. After upgrading Node.js or Tellrun, `restart` updates the Node and CLI paths used by the service.

## Configuration and data

Run `tellrun setup` to create or update your configuration. Leave the Bot Token blank to keep the existing value.

| Path | Contents |
| --- | --- |
| `~/.tellrun/config.json` | Bot Token, authorized user ID, Codex path, and optional proxy |
| `~/.tellrun/state.json` | Current conversation, working directory, task inputs and results, and pending replies |
| `~/.tellrun/tellrun.service` | Linux background service definition |

Codex uses the same operating system user's authentication and model configuration, and manages its own full conversation history. Tellrun does not maintain a project directory allowlist. Access depends on operating system permissions and the Codex sandbox; Tellrun defaults to workspace write access and approvals on request.

### Environment variables

When running in the foreground or managing the process yourself, you can override configuration with environment variables:

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token |
| `TELEGRAM_OWNER_ID` | Numeric ID of the user allowed to interact with the bot |
| `CODEX_PATH` | Codex command name or executable path |
| `TELEGRAM_PROXY_URL` | HTTP/HTTPS proxy for Telegram; overrides the configuration file when nonempty |

The built-in background service does not automatically load your current terminal's environment variables or a project's `.env` file. Save the required configuration with `tellrun setup`.

### Telegram proxy

To use a proxy, add `"proxyUrl": "http://127.0.0.1:7890"` to the existing `telegram` object in `~/.tellrun/config.json`, then restart the service. Adjust the address and port to match your proxy. Set it to `""` to explicitly connect directly.

Proxy precedence is: nonempty `TELEGRAM_PROXY_URL` → `telegram.proxyUrl` in the configuration file → the running process's `https_proxy` / `HTTPS_PROXY`. Proxy connections honor `no_proxy` / `NO_PROXY`; lowercase variables take precedence. This setting only affects Telegram. Codex uses its own process's proxy environment.

## FAQ

### Can I use Codex for coding from my phone?

Yes. Install Codex CLI and Tellrun on your server, then chat with your bot through Telegram on your phone or desktop. Code inspection, file edits, and commands run on the server. Telegram is the interface for sending tasks, reading replies, and continuing the conversation.

### How do I find my Telegram user ID?

Before starting Tellrun, send a private message to your new bot. Use Telegram's [getUpdates](https://core.telegram.org/bots/api#getupdates) endpoint and find `message.from.id` for that message:

```text
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

Replace `<BOT_TOKEN>` with your token. If Tellrun is already running, stop it first to avoid polling conflicts.

### Why is the bot not replying?

Check that you are using a private chat and that your configured user ID is correct. Inspect `tellrun logs`, or the terminal output if running in the foreground. The same bot cannot be used by multiple polling instances at once, and Tellrun cannot start while the bot has an active webhook.

### What happens when a task needs approval?

Telegram interfaces for approvals and structured questions are not available yet. Tellrun interrupts the task and explains why. Handle the request locally first, check the task state, then send `/resume` and a new message with the work you want to continue.

### Will tasks run again after a restart?

Tasks that have not been dispatched are retained. Tasks with uncertain execution status are not automatically rerun. Check `/status` and `/last`, then use `/resume` to accept new tasks and send a new message.

## Local development

```sh
git clone https://github.com/chaoyue1998/tellrun.git
cd tellrun
npm ci
npm run build
node dist/cli.js setup
npm run dev
```

Choose to save configuration without starting a background service in the setup wizard, then start the development process. Development and global installations share `~/.tellrun/`, so stop any existing instance first. You can also create a `.env` file using the repository's [.env.example](https://github.com/chaoyue1998/tellrun/blob/main/.env.example) for development configuration.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch source files and restart automatically |
| `npm run check` | Run formatting, static analysis, and type checks |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled application |

When asking Codex to modify Tellrun itself, run `npm run build` followed by `npm start` so source changes do not trigger a restart during the task.

## Documentation and feedback

- [Architecture and technical design](https://github.com/chaoyue1998/tellrun/blob/main/docs/architecture.md) (Chinese): implementation, storage, and deployment details.
- [Product requirements and roadmap](https://github.com/chaoyue1998/tellrun/blob/main/docs/prd.md) (Chinese): includes planned features; this README describes what is currently available.
- [GitHub Issues](https://github.com/chaoyue1998/tellrun/issues): report bugs or suggest improvements. Include versions, reproduction steps, and logs with credentials removed.

## License

[MIT](https://github.com/chaoyue1998/tellrun/blob/main/LICENSE)
