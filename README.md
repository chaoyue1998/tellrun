<p align="center">
  <img src="docs/assets/tellrun-icon.png" alt="Tellrun icon" width="128" height="128" />
</p>

# Tellrun — Telegram Bot for OpenAI Codex

**Tellrun is a self-hosted Telegram bot for remote AI coding with OpenAI Codex CLI, persistent sessions, and streaming replies.**

Run Tellrun on your server and use Telegram on your phone or desktop to send coding tasks, continue conversations, and read results without keeping an SSH terminal open.

**English** | [简体中文](https://github.com/chaoyue1998/tellrun/blob/main/README.zh-CN.md)

[npm](https://www.npmjs.com/package/tellrun) · [GitHub](https://github.com/chaoyue1998/tellrun) · [Report an issue](https://github.com/chaoyue1998/tellrun/issues)

[Quick start](#install-and-connect-codex-to-telegram) · [Telegram commands](#telegram-commands) · [Terminal commands](#terminal-commands) · [Configuration](#configuration-and-data) · [FAQ](#faq) · [Local development](#local-development)

## Features

- **Remote coding**: send tasks in a private Telegram chat and let Codex execute them on your server.
- **Images and files**: send screenshots, photos, or files with task instructions, including while a task is running.
- **Session management**: select a project with `/cwd`, create named sessions with `/new`, and use the buttons in `/list` to select and resume conversations.
- **Live feedback**: see typing indicators and Markdown streaming replies with headings, lists, tables, and code blocks, and send additional instructions while a task is running.
- **Task control**: check status and the latest result, stop a task and pause new work, and retain the current conversation and task state across restarts.
- **Scheduled tasks**: create five-field cron schedules with `/cron`, using the server timezone, and receive results in Telegram.
- **Approvals and questions**: use buttons for command, file, and permission approvals; select options or reply directly to questions, with answers submitted after all questions are answered.
- **Permission modes**: use `/permissions` to choose one of four Codex modes, saved for subsequent tasks.

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

At startup, Tellrun registers an English command menu. Use the menu button beside the chat input or type `/` to select a command.

| Command               | Purpose                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `/start`, `/help`     | Show usage instructions                                                                      |
| `/cwd`                | Show the current working directory                                                           |
| `/cwd /absolute/path` | Change the working directory and start a new conversation                                    |
| `/new [name]`         | Create and select a session, with an optional name                                           |
| `/list`               | Show up to 10 recent project sessions as buttons; tap to switch                              |
| `/model`              | Show the current selection and choose model and reasoning effort                             |
| `/permissions`        | Choose the permission mode for subsequent tasks                                              |
| `/cron`               | List, create, delete, enable, or disable scheduled tasks                                     |
| `/status`             | Show version updates, connection, directory, session ID, model, permissions, and task status |
| `/update`             | Ask Codex to upgrade Tellrun using the installation details                                  |
| `/restart`            | Restart Tellrun and reload configuration while preserving session and task state             |
| `/last`               | Show the latest finished task's status and result                                            |
| `/stop`               | Request that the current task stop and pause new tasks                                       |
| `/resume`             | Accept new tasks again without rerunning an interrupted task                                 |

Wait for the current task to finish before changing directories, creating a session, or switching sessions. `/list` remains available while a task runs. After `/stop`, check the final status, then send `/resume` followed by your next task.

### Session management

Sessions are stored by Codex. `/list` shows up to 10 non-archived sessions from Tellrun and other Codex clients in the exact current directory, ordered by recent activity, excluding subagents. It displays session buttons and a prompt to tap to switch, with ✓ marking the current session. `/new` without a name uses `New session`; even an empty session is saved. Creating or switching sessions keeps the selected model and permissions. Wait for confirmation before sending a task; if creation cannot be confirmed, check `/list` before retrying.

### Scheduled tasks

For example, check the current project at 09:00 server time every weekday:

```text
/cron add 0 9 * * 1-5 Check the project and report issues
```

Manage schedules with `/cron del <id>`, `/cron enable <id>`, and `/cron disable <id>`. 

## Terminal commands

Run these commands in the terminal on the computer or server running Tellrun.

| Command                     | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `tellrun start`             | Start the background service                                            |
| `tellrun start --enable`    | Start and enable automatic startup: at boot on Linux, at login on macOS |
| `tellrun status`            | Show service status and data paths                                      |
| `tellrun logs`              | Show the latest 100 log entries                                         |
| `tellrun logs -f`           | Follow logs                                                             |
| `tellrun restart`           | Restart with the current configuration or installed version             |
| `tellrun stop`              | Stop the background service                                             |
| `tellrun uninstall`         | Stop and remove the service and global npm package, keeping user data   |
| `tellrun --help`            | Show command help                                                       |

### Upgrade

```sh
tellrun stop
npm install -g tellrun@latest
tellrun restart
```

Configuration and state live in `~/.tellrun/` and are preserved when upgrading the global package. After upgrading Node.js or Tellrun, `restart` updates the Node and CLI paths used by the service.

### Uninstall

```sh
tellrun uninstall
```

Stops and removes the current user's background service, then uninstalls the global npm package from its installation prefix. Configuration, state, attachments, and application logs remain in `~/.tellrun/`; the command reminds you to delete that directory yourself if no longer needed. Linux user linger settings stay unchanged.

This command supports global npm installations on Linux and macOS.

## Configuration and data

Run `tellrun setup` to create or update your configuration. Leave the Bot Token blank to keep the existing value.

| Path                         | Contents                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `~/.tellrun/config.json`     | Bot Token, authorized user ID, Codex path, and optional proxy                                                            |
| `~/.tellrun/state.json`      | Conversation, active task, latest result, schedules and pending triggers, interactions, replies, and deduplication state |
| `~/.tellrun/attachments/`    | Uploaded images and files, stored under unique IDs to prevent filename collisions                                        |
| `~/.tellrun/tellrun.service` | Linux background service definition                                                                                      |
| `~/.tellrun/tellrun.plist`   | macOS background service definition                                                                                      |
| `~/.tellrun/tellrun.log`     | macOS service diagnostics; view with `tellrun logs`                                                                      |

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

Check that you are using a private chat and that your configured user ID is correct. Check whether the machine running Tellrun can reach Telegram. If using a proxy, verify its configuration and connectivity. Inspect `tellrun logs` for errors, or the terminal output if running in the foreground.

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
