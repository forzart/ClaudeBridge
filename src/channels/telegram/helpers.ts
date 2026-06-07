/** Pure helpers shared between bot.ts and commands.ts — cwd resolution, busy check, session ensure. */
import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import type { SessionManager } from '../../session/manager.js';
import { getCurrentSessionId, setCurrentSessionId } from '../../session/state.js';
import { listAllSessions } from '../../session/resolver.js';

export const CHANNEL = 'telegram';

export interface SessionAlias {
  tag?: string;
  customTitle?: string;
}

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

/** Promise-based sleep used by the rate-limit queue. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Returns the sessionId currently running in this cwd, if any. */
export function getActiveSessionIdForCwd(
  sessionManager: SessionManager,
  cwd: string,
): string | undefined {
  const sessionId = getCurrentSessionId(CHANNEL, cwd);
  if (!sessionId) return undefined;
  return sessionManager.isActive(sessionId) ? sessionId : undefined;
}

/** True if a Claude query is currently running in this cwd. */
export function isBusy(sessionManager: SessionManager, cwd: string): boolean {
  return getActiveSessionIdForCwd(sessionManager, cwd) !== undefined;
}

export interface EnsuredSession {
  sessionId: string;
  created: boolean;
}

/** Returns the stored sessionId for this cwd, creating + persisting a fresh UUID if none exists. */
export function ensureSessionForCwd(cwd: string): EnsuredSession {
  const existing = getCurrentSessionId(CHANNEL, cwd);
  if (existing) {
    return { sessionId: existing, created: false };
  }
  const newId = randomUUID();
  setCurrentSessionId(CHANNEL, cwd, newId);
  return { sessionId: newId, created: true };
}

/** Looks up a session's tag/customTitle for display; returns empty object on error. */
export async function lookupAlias(sessionId: string, cwd: string): Promise<SessionAlias> {
  try {
    const sessions = await listAllSessions(cwd);
    const info = sessions.find((s) => s.sessionId === sessionId);
    if (!info) return {};
    return { tag: info.tag, customTitle: info.customTitle };
  } catch {
    return {};
  }
}
