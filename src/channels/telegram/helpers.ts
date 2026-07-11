/** Pure helpers shared between bot.ts and commands.ts — cwd resolution, busy check, session ensure. State is per-bot, keyed by the bot's guid. */
import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import type { SessionManager } from '../../session/manager.js';
import { getCurrentSessionId, setCurrentSessionId } from './bot-store.js';
import { getLatestSession } from '../../session/resolver.js';

/** Resolves ~ and validates the path is an existing directory. Relative paths resolve against baseCwd (if given). */
export function resolveCwd(input: string, baseCwd?: string): string {
  let path = input;
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    path = resolve(homedir(), path.slice(2) || '.');
  } else if (!isAbsolute(path)) {
    if (!baseCwd) {
      throw new Error(`Path must be absolute or start with ~/: ${input}`);
    }
    path = resolve(baseCwd, path);
  }
  const normalized = resolve(path);
  if (!existsSync(normalized)) {
    throw new Error(`Directory does not exist: ${normalized}`);
  }
  if (!statSync(normalized).isDirectory()) {
    throw new Error(`Not a directory: ${normalized}`);
  }
  return normalized;
}

/** Safe error-to-message coercion for catch (err: unknown) blocks. */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

/** Shortens a path for display by replacing the home-dir prefix with ~. */
export function prettyPath(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

/** Promise-based sleep used by the rate-limit queue. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Compact token count for display (1234567 -> "1.2M", 152000 -> "152K"). */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Returns the sessionId currently running for this bot's cwd, if any. */
export function getActiveSessionIdForCwd(
  sessionManager: SessionManager,
  botId: string,
  cwd: string,
): string | undefined {
  const sessionId = getCurrentSessionId(botId, cwd);
  if (!sessionId) return undefined;
  return sessionManager.isActive(sessionId) ? sessionId : undefined;
}

/** True if a Claude query is currently running for this bot's cwd. */
export function isBusy(sessionManager: SessionManager, botId: string, cwd: string): boolean {
  return getActiveSessionIdForCwd(sessionManager, botId, cwd) !== undefined;
}

export interface EnsuredSession {
  sessionId: string;
  created: boolean;
}

/** Returns the stored sessionId for this bot+cwd, creating + persisting a fresh UUID if none exists. */
export function ensureSessionForCwd(botId: string, cwd: string): EnsuredSession {
  const existing = getCurrentSessionId(botId, cwd);
  if (existing) {
    return { sessionId: existing, created: false };
  }
  const newId = randomUUID();
  setCurrentSessionId(botId, cwd, newId);
  return { sessionId: newId, created: true };
}

export type AttachedSession =
  | { kind: 'attached-latest'; sessionId: string }
  | { kind: 'created'; sessionId: string };

/**
 * Resolves which session this cwd should use after a /cd:
 * newest session on disk → fresh UUID.
 *
 * Always re-syncs to the most recently modified session in the directory
 * (including ones created by the desktop CLI), rather than sticking to a
 * previously-remembered sessionId. Falls back to a fresh UUID only when the
 * directory has no sessions at all.
 */
export async function attachOrCreateForCwd(botId: string, cwd: string): Promise<AttachedSession> {
  const latest = await getLatestSession(cwd);
  if (latest) {
    setCurrentSessionId(botId, cwd, latest.sessionId);
    return { kind: 'attached-latest', sessionId: latest.sessionId };
  }

  const newId = randomUUID();
  setCurrentSessionId(botId, cwd, newId);
  return { kind: 'created', sessionId: newId };
}
