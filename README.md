# Tellrun — Telegram Bot for OpenAI Codex

**Tellrun is a self-hosted Telegram bot for remote AI coding with OpenAI Codex CLI, persistent sessions, and streaming replies.**

Run Tellrun on your server and use Telegram on your phone or desktop to send coding tasks, continue conversations, and read results without keeping an SSH terminal open.

**English** | [简体中文](https://github.com/chaoyue1998/tellrun/blob/main/README.zh-CN.md)

[npm](https://www.npmjs.com/package/tellrun) · [GitHub](https://github.com/chaoyue1998/tellrun) · [Report an issue](https://github.com/chaoyue1998/tellrun/issues)

[Quick start](#install-and-connect-codex-to-telegram) · [Telegram commands](#telegram-commands) · [Background service](#background-service) · [Configuration](#configuration-and-data) · [FAQ](#faq) · [Local development](#local-development)

## Features

- **Remote coding**: send tasks in a private Telegram chat and let Codex execute them on your server.
- **Continuous conversations**: keep the current conversation context, select a project with `/cwd`, and start fresh with `/new`.
- **Live feedback**: see typing indicators and streaming replies, and send additional instructions while a task is running.
- **Task control**: check status and the latest result, stop a task and pause new work, and retain the current conversation and task state across restarts.
- **Approvals and questions**: use buttons for command, file, and permission approvals; select options or reply directly to questions, with answers submitted after all questions are answered.

## Install and connect Codex to Telegram

### 1. Prerequisites

- **Node.js ≥ 24.5.0**.
- **[Codex CLI](https://github.com/openai/codex)**: install and sign in as the same operating system user that will run Tellrun. Confirm that Codex works in your terminal.

### 2. Install and configure

```sh
npm install -g tellrun
tellrun setup
```

### 3. Start chatting in Telegram

Open a private chat with your bot and send these messages one at a time. Replace the example path with an existing absolute project path on your server:

```text
/start
/cwd /home/you/projects/my-app
Help me understand this project. Explain its main modules and how to run it.
```

Without `/cwd`, the working directory defaults to the directory where the service starts. Background services start in the current user's home directory. Changing directories starts a new conversation.

## Telegram commands

| Command               | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `/start`, `/help`     | Show usage instructions                                      |
| `/cwd`                | Show the current working directory                           |
| `/cwd /absolute/path` | Change the working directory and start a new conversation    |
| `/new`                | Start a new conversation while keeping the working directory |
| `/status`             | Show connection, conversation, directory, and task status    |
| `/last`               | Show the latest finished task's status and result            |
| `/stop`               | Request that the current task stop and pause new tasks       |
| `/resume`             | Accept new tasks again without rerunning an interrupted task |

Wait for the current task to finish before changing directories or starting a new conversation. After `/stop`, check the final status, then send `/resume` followed by your next task.

## Background service

| Command                     | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `tellrun start`             | Start the background service                                            |
| `tellrun start --enable`    | Start and enable automatic startup: at boot on Linux, at login on macOS |
| `tellrun status`            | Show service status and data paths                                      |
| `tellrun logs`              | Show the latest 100 log entries                                         |
| `tellrun logs -f`           | Follow logs                                                             |
| `tellrun restart`           | Restart with the current configuration or installed version             |
| `tellrun stop`              | Stop the background service                                             |
| `tellrun service uninstall` | Stop and remove the service, keeping configuration and state            |
| `tellrun --help`            | Show command help                                                       |

### Upgrade

```sh
tellrun stop
npm install -g tellrun@latest
tellrun restart
```

Configuration and state live in `~/.tellrun/` and are preserved when upgrading the global package. After upgrading Node.js or Tellrun, `restart` updates the Node and CLI paths used by the service.

## Configuration and data

Run `tellrun setup` to create or update your configuration. Leave the Bot Token blank to keep the existing value.

| Path                         | Contents                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `~/.tellrun/config.json`     | Bot Token, authorized user ID, Codex path, and optional proxy                                                             |
| `~/.tellrun/state.json`      | Current conversation, directory, active task, latest result, pending interactions and replies, and unconfirmed update IDs |
| `~/.tellrun/tellrun.service` | Linux background service definition                                                                                       |
| `~/.tellrun/tellrun.plist`   | macOS background service definition                                                                                       |
| `~/.tellrun/tellrun.log`     | macOS service diagnostics; view with `tellrun logs`                                                                       |

Codex uses the same operating system user's authentication and model configuration, and manages its own full conversation history. Tellrun does not maintain a project directory allowlist. Access depends on operating system permissions and the Codex sandbox; Tellrun defaults to workspace write access and approvals on request.

Tellrun keeps only active tasks and each chat's latest result for `/last`. Confirmed update IDs and closed interactions are removed once they are no longer needed; pending replies remain until sent or permanently rejected. Task history stays with Codex; Tellrun logs only service startup, shutdown, and connection or storage diagnostics.

### Configuration parameters

Parameters in `~/.tellrun/config.json`:

| Parameter           | Type                               | Requirement / default behavior                             | Description                                                                                                                 |
| ------------------- | ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `telegram.token`    | String                             | Required; no default                                       | Bot token obtained from BotFather.                                                                                          |
| `telegram.ownerId`  | Positive integer or numeric string | Required; no default                                       | Your numeric Telegram user ID for authorized access, not your `@username`. A numeric value is recommended.                  |
| `telegram.proxyUrl` | String                             | Optional; inherits environment proxy settings when omitted | Supports `http://` or `https://` proxy URLs; set to `""` to connect directly.                                               |
| `codexPath`         | String                             | Optional; defaults to `"codex"`                            | Codex command name or executable path. Names are resolved through `PATH`; `tellrun setup` saves the resolved absolute path. |

Configuration is read when the process starts. Run `tellrun restart` after editing the file manually.

## FAQ

### Why is the bot not replying?

Check that you are using a private chat and that your configured user ID is correct. Inspect `tellrun logs`, or the terminal output if running in the foreground. The same bot cannot be used by multiple polling instances at once, and Tellrun cannot start while the bot has an active webhook.

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

| Command         | Purpose                                          |
| --------------- | ------------------------------------------------ |
| `npm run dev`   | Watch source files and restart automatically     |
| `npm run check` | Run formatting, static analysis, and type checks |
| `npm run build` | Compile to `dist/`                               |
| `npm start`     | Run the compiled application                     |

When asking Codex to modify Tellrun itself, run `npm run build` followed by `npm start` so source changes do not trigger a restart during the task.

## License

[MIT](https://github.com/chaoyue1998/tellrun/blob/main/LICENSE)
