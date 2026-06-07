# CLAUDE.md

Project-specific instructions for Claude when working in this codebase.

## Project Overview

ClaudeBridge — Telegram bot that bridges your phone and your desktop Claude Code CLI by resuming the same session per working directory.

## Tech Stack

- TypeScript, ES modules
- grammy (Telegram bot framework)
- @anthropic-ai/claude-agent-sdk (spawns Claude Code CLI as subprocess)
- zod (config validation), pino (logging)
- Node >= 18

## Project Structure

```
ClaudeBridge/
├── src/
│   ├── index.ts                          # Entry: load config, start bot, shutdown
│   ├── config-file.ts                    # Loads ./config.json (zod-validated)
│   ├── agent/
│   │   └── query.ts                      # SDK query() integration (start/resume)
│   ├── session/
│   │   ├── manager.ts                    # AbortController tracking keyed by sessionId
│   │   ├── state.ts                      # ~/.claudebridge/state/sessions.json (per cwd)
│   │   └── resolver.ts                   # Resolve UUID/prefix/tag/customTitle → session
│   └── channels/
│       └── telegram/
│           ├── bot.ts                    # Class, lifecycle, auth gate, handlePrompt, queue
│           ├── commands.ts               # All /command handlers, registerCommands(bot, deps)
│           ├── helpers.ts                # resolveCwd, isBusy, ensureSession, lookupAlias
│           └── formatter.ts              # SDK event → text + tool summaries + 4096 split
├── config.example.json                   # Config template (committed)
└── config.json                           # Actual config (gitignored)
```

## Development Rules

**ALWAYS follow these rules when writing code:**

- TypeScript coding style: `~/.claude/rules/everything-claude-code/typescript/coding-style.md`
- TypeScript security: `~/.claude/rules/everything-claude-code/typescript/security.md`
- TypeScript patterns: `~/.claude/rules/everything-claude-code/typescript/patterns.md`
- Common coding style: `~/.claude/rules/everything-claude-code/common/coding-style.md`
- Common security: `~/.claude/rules/everything-claude-code/common/security.md`
- Git workflow: `~/.claude/rules/everything-claude-code/common/git-workflow.md`

Apply these rules **proactively** — do not wait for user correction.

## Common Commands

```bash
npm install         # install deps
npm run build       # tsc
npm start           # node dist/index.js
npm run dev         # tsx watch src/index.ts
```

Type check: `npx tsc --noEmit`

## Key Behaviors to Know

- **Session per (channel, cwd)** — `services/session-state.ts` persists which sessionId is "current" for each cwd; surviving restarts is the whole point
- **`/cd` auto-loads or creates** — entering a cwd reads state and resumes that session; if no state, creates a new UUID and stores it
- **`/attach` is the bridge to CLI** — when you want to pick up where the desktop CLI left off, run `/attach` (latest) or `/attach <alias>`
- **CLI is the source of truth for session content** — we don't read/write JSONL ourselves; the SDK subprocess does. We just decide which sessionId to resume
- **Tool result rendering** — Telegram only shows tool invocation (`⚒ Read: file.ts`), never the result body; results are noisy and the assistant's next text already summarizes them
- **Single user** — `allowedUserId` is a hard whitelist; other users are silently dropped

## Important Constraints

- **Claude Code CLI must be installed and authenticated** — the SDK spawns `claude` as subprocess
- **Permission mode is `bypassPermissions`** — all tool ops run without prompting; only suitable for trusted/private bots
- **1 concurrent query per bot** — second message during a running query gets "Claude is busy"; use `/abort` to cancel
- **No multi-user, no auth UI** — single owner via numeric Telegram ID
- **Long polling only** — no public HTTPS / webhook configuration

## Adding new commands

1. Add a `handleFoo` function in `channels/telegram/commands.ts` (signature: `async (ctx: Context, deps: CommandDeps) => Promise<void>`)
2. Register it in `registerCommands()`: `bot.command('foo', (ctx) => handleFoo(ctx, deps))`
3. Update the `/help` text in `handleHelp` and the README commands table
4. If the command needs shared logic (path validation, isBusy check, alias lookup), add it to `channels/telegram/helpers.ts` instead of inlining
