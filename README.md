# ClaudeBridge

Bridge between your desktop [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and your phone, via Telegram.

Start a coding session on your desktop CLI. Walk out the door. Pick it up on Telegram with the same context. Walk back to your desk. CLI continues right where the phone left off.

## How it works

```
Desktop CLI ─┐
             ├─▶  Same Claude Code session  (~/.claude/projects/.../*.jsonl)
Telegram   ──┘
```

Both ends read and write the same JSONL session file maintained by Claude Code. ClaudeBridge is a Telegram bot that resumes the right session for the right working directory.

## Features

- **Per-project session memory** — each working directory has its own current session, persisted across restarts
- **Sync with CLI** — entering a directory auto-resumes its most recent session (whether started here or by the desktop CLI)
- **Tool call streaming** — each tool invocation appears as `⚒ Read: file.ts`
- **Typing indicator** — "is typing…" stays visible while Claude is working
- **Single-user whitelist** — only your numeric Telegram ID can talk to the bot
- **Long polling** — no public HTTPS or webhook needed; runs behind any NAT
- **Tap to switch** — `/session` and `/cd` render inline buttons; tap one to switch session or directory

## Commands

| Command | Behavior |
|---|---|
| `/pwd` | Show current working directory |
| `/cd <path>` | Switch working directory |
| `/cd` | Show a directory picker (tap a button to switch) |
| `/session` | List sessions in current cwd; tap a button to switch |
| `/whoami` | Show current directory, session, and run status |
| `/new` | Start a fresh session in current cwd |
| `/abort` | Cancel the running query |
| `/reset` | Forget current session (next message starts fresh) |
| `/help` | List commands |

Any non-command text is sent to Claude as a prompt.

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** installed and authenticated:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```

ClaudeBridge spawns the CLI as a subprocess — it doesn't reimplement Claude Code, it pipes Telegram messages through to whatever your CLI is configured to use (Anthropic API, copilot-api proxy, etc.).

## Setup

```bash
git clone https://github.com/forzart/ClaudeBridge.git
cd ClaudeBridge
npm install
npm run build
```

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token
2. Get your numeric user ID from [@userinfobot](https://t.me/userinfobot)
3. Copy `config.example.json` to `config.json`:

```json
{
  "botToken": "1234567890:AAAA...",
  "allowedUserId": 12345678,
  "cwd": "~"
}
```

| Field | Required | Description |
|---|---|---|
| `botToken` | yes | Token from @BotFather |
| `allowedUserId` | yes | Your numeric Telegram user ID |
| `cwd` | yes | Default working directory (`~` is allowed; must exist) |

4. Start:
```bash
npm start
```

Send any message to the bot — it talks to Claude in the configured `cwd`.

## Typical workflow

```
Desktop:  cd ~/repos/myproject
          claude
          [50 minutes of coding]
          [walk out]

Phone:    /cd ~/repos/myproject     ← auto-resumes the session you just left
          continue with the auth refactor
          ⚒ Read: src/auth.ts
          [Claude continues right where CLI left off]
```

## State

| Path | Purpose |
|---|---|
| `~/.claudebridge/state/sessions.json` | Per-cwd current session ID, keyed by channel |
| `~/.claude/projects/<projectKey>/<sessionId>.jsonl` | Conversation history (maintained by Claude Code) |

## Project Structure

```
src/
├── index.ts                              # Entry: load config, start bot, shutdown
├── config-file.ts                        # Loads ./config.json (zod-validated)
├── agent/
│   └── query.ts                          # SDK query() integration (start / resume)
├── session/
│   ├── manager.ts                        # AbortController tracking, keyed by sessionId
│   ├── state.ts                          # ~/.claudebridge/state/sessions.json read/write
│   └── resolver.ts                       # Resolve UUID / prefix / tag / customTitle
└── channels/
    └── telegram/
        ├── bot.ts                        # Class, lifecycle, auth gate, handlePrompt, queue
        ├── commands.ts                   # All /command handlers
        ├── helpers.ts                    # resolveCwd, isBusy, ensureSession, lookupAlias
        └── formatter.ts                  # SDK event → text + tool summary + 4096 split
```

The `channels/` directory is built to host other clients (Discord, Slack, Feishu) alongside Telegram. Each channel implements its own `bot.ts`, reuses the shared `session/` and `agent/` modules, and registers with the process-wide `SessionManager` so concurrent writes to the same Claude session are mutually excluded.

## Run as a systemd user service

```ini
# ~/.config/systemd/user/claudebridge.service
[Unit]
Description=ClaudeBridge — Telegram bridge for Claude Code
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/ClaudeBridge
ExecStart=/usr/bin/node /path/to/ClaudeBridge/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now claudebridge
journalctl --user -u claudebridge -f
```

## Tech stack

- TypeScript
- [grammy](https://grammy.dev/) — Telegram bot framework
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — spawns Claude Code CLI
- [zod](https://zod.dev/) — config validation
- [pino](https://getpino.io/) — logging

## License

MIT
