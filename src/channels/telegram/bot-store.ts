/**
 * Single source of truth for each Telegram bot (everything except the token)
 * under ~/.claudebridge/telegram/. The token lives ONLY in tokens.json (0600);
 * every other file references a bot by guid. Platform-namespaced so other
 * platforms (e.g. feishu) get a sibling dir with the same layout later.
 *
 *   ~/.claudebridge/telegram/
 *   ├── tokens.json        { "<guid>": "<bot token>" }   (0600)
 *   └── bots/<guid>.json   { guid, allowedUserId, name?, cwd?, sessionId?, knownCwds[] }
 */
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';

const TELEGRAM_DIR = resolve(homedir(), '.claudebridge', 'telegram');
const TOKENS_PATH = join(TELEGRAM_DIR, 'tokens.json');
const BOTS_DIR = join(TELEGRAM_DIR, 'bots');

const botRecordSchema = z.object({
  guid: z.string().uuid(),
  allowedUserId: z.number().int().positive(),
  name: z.string().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  knownCwds: z.array(z.string()).default([]),
});

/** Everything about one bot except its token (identity + live state). */
export type BotRecord = z.infer<typeof botRecordSchema>;

/** A bot record joined with its token — what the runtime needs to start it. */
export interface LoadedBot extends BotRecord {
  token: string;
}

// ── token file (the only place tokens live) ───────────────────
function readTokens(): Record<string, string> {
  if (!existsSync(TOKENS_PATH)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(TOKENS_PATH, 'utf-8'));
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    // corrupt — treat as empty
  }
  return {};
}

function writeTokens(tokens: Record<string, string>): void {
  mkdirSync(TELEGRAM_DIR, { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// ── bot record files ──────────────────────────────────────────
function recordPath(guid: string): string {
  return join(BOTS_DIR, `${guid}.json`);
}

export function readBot(guid: string): BotRecord | undefined {
  const path = recordPath(guid);
  if (!existsSync(path)) return undefined;
  try {
    return botRecordSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return undefined;
  }
}

function writeBot(record: BotRecord): void {
  mkdirSync(BOTS_DIR, { recursive: true });
  writeFileSync(recordPath(record.guid), JSON.stringify(record, null, 2));
}

// ── lifecycle ─────────────────────────────────────────────────
/** All configured bots joined with their tokens; bots whose token is missing are skipped. */
export function loadBots(): LoadedBot[] {
  if (!existsSync(BOTS_DIR)) return [];
  const tokens = readTokens();
  const loaded: LoadedBot[] = [];
  for (const file of readdirSync(BOTS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const record = readBot(file.slice(0, -'.json'.length));
    if (!record) continue;
    const token = tokens[record.guid];
    if (typeof token === 'string' && token.length > 0) loaded.push({ ...record, token });
  }
  return loaded;
}

/** Creates a new bot (guid record + token). cwd seeds the bot's working dir and known-dirs. */
export function addBot(input: { token: string; allowedUserId: number; cwd: string; name?: string }): BotRecord {
  const record: BotRecord = {
    guid: randomUUID(),
    allowedUserId: input.allowedUserId,
    name: input.name,
    cwd: input.cwd,
    knownCwds: [input.cwd],
  };
  writeBot(record);
  writeTokens({ ...readTokens(), [record.guid]: input.token });
  return record;
}

/** Removes a bot's record and token (delete-bot feature). */
export function removeBot(guid: string): void {
  const path = recordPath(guid);
  if (existsSync(path)) rmSync(path);
  const tokens = readTokens();
  if (guid in tokens) {
    const { [guid]: _removed, ...rest } = tokens;
    writeTokens(rest);
  }
}

// ── per-bot runtime state (cwd / current session / visited dirs) ──
/** Current sessionId for (bot, cwd) — only when cwd is the bot's current directory. */
export function getCurrentSessionId(guid: string, cwd: string): string | undefined {
  const bot = readBot(guid);
  return bot && bot.cwd === cwd ? bot.sessionId : undefined;
}

/** Sets the current session and marks cwd as the bot's current (and known) directory. */
export function setCurrentSessionId(guid: string, cwd: string, sessionId: string): void {
  const bot = readBot(guid);
  if (!bot) return;
  const knownCwds = bot.knownCwds.includes(cwd) ? bot.knownCwds : [...bot.knownCwds, cwd];
  writeBot({ ...bot, cwd, sessionId, knownCwds });
}

/** Forgets the current session (when cwd is current); the next prompt starts fresh. */
export function clearCurrentSessionId(guid: string, cwd: string): void {
  const bot = readBot(guid);
  if (!bot || bot.cwd !== cwd || bot.sessionId === undefined) return;
  const { sessionId: _drop, ...rest } = bot;
  writeBot(rest);
}

/** The bot's current working directory, if any. */
export function getCurrentCwd(guid: string): string | undefined {
  return readBot(guid)?.cwd;
}

/** Sets the bot's current directory; entering a different cwd drops the stale current session. */
export function setCurrentCwd(guid: string, cwd: string): void {
  const bot = readBot(guid);
  if (!bot) return;
  const knownCwds = bot.knownCwds.includes(cwd) ? bot.knownCwds : [...bot.knownCwds, cwd];
  const next: BotRecord = { ...bot, cwd, knownCwds };
  if (bot.cwd !== cwd) delete next.sessionId;
  writeBot(next);
}

/** Every directory the bot has visited, sorted — drives the /cd picker. */
export function getKnownCwds(guid: string): string[] {
  return [...(readBot(guid)?.knownCwds ?? [])].sort();
}

// ── one-time migration from the pre-multi-bot layout ──────────
const LEGACY_STATE_PATH = resolve(homedir(), '.claudebridge', 'state', 'sessions.json');

/** Reads the bootstrap bot's prior cwd/session/knownCwds from the old single-channel state file, if present. */
function readLegacyState(): { cwd?: string; sessionId?: string; knownCwds: string[] } | undefined {
  if (!existsSync(LEGACY_STATE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(LEGACY_STATE_PATH, 'utf-8')) as Record<string, unknown>;
    const t = parsed.telegram as Record<string, unknown> | undefined;
    if (!t) return undefined;
    if (t.sessions && typeof t.sessions === 'object') {
      const sessions = t.sessions as Record<string, string>;
      const cwd = typeof t.cwd === 'string' ? t.cwd : undefined;
      return { cwd, sessionId: cwd ? sessions[cwd] : undefined, knownCwds: Object.keys(sessions) };
    }
    if (Array.isArray(t.knownCwds) || typeof t.sessionId === 'string' || typeof t.cwd === 'string') {
      return {
        cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
        sessionId: typeof t.sessionId === 'string' ? t.sessionId : undefined,
        knownCwds: Array.isArray(t.knownCwds) ? (t.knownCwds.filter((c) => typeof c === 'string') as string[]) : [],
      };
    }
  } catch {
    // ignore corrupt legacy state
  }
  return undefined;
}

/** Imports the legacy single-bot setup (config.json + old state file) as the first bot. No-op once any bot exists. */
export function migrateLegacyConfig(legacy: { botToken: string; allowedUserId: number; cwd: string }): BotRecord | undefined {
  if (loadBots().length > 0) return undefined;
  const prior = readLegacyState();
  const cwd = prior?.cwd ?? legacy.cwd;
  const record: BotRecord = {
    guid: randomUUID(),
    allowedUserId: legacy.allowedUserId,
    name: 'default',
    cwd,
    sessionId: prior?.sessionId,
    knownCwds: prior?.knownCwds.length ? prior.knownCwds : [cwd],
  };
  writeBot(record);
  writeTokens({ ...readTokens(), [record.guid]: legacy.botToken });
  return record;
}
