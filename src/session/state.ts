/** Persists per-channel state (current cwd + per-cwd current sessionId) to ~/.claudebridge/state/sessions.json. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

const STATE_PATH = resolve(homedir(), '.claudebridge', 'state', 'sessions.json');

interface ChannelState {
  cwd?: string;
  sessions: Record<string, string>;
}

type AllChannelsState = Record<string, ChannelState>;

/** Migrates the old flat shape `{ telegram: { "/path": "uuid" } }` into the nested shape. */
function migrate(parsed: Record<string, unknown>): AllChannelsState {
  const out: AllChannelsState = {};
  for (const [channel, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if ('sessions' in v && typeof v.sessions === 'object' && v.sessions !== null) {
      out[channel] = {
        cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
        sessions: v.sessions as Record<string, string>,
      };
    } else {
      // Legacy: flat { "/path": "uuid" }
      out[channel] = { sessions: v as Record<string, string> };
    }
  }
  return out;
}

function read(): AllChannelsState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return migrate(parsed as Record<string, unknown>);
    }
  } catch {
    // corrupt file — start fresh
  }
  return {};
}

function write(state: AllChannelsState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function ensureChannel(state: AllChannelsState, channel: string): ChannelState {
  if (!state[channel]) state[channel] = { sessions: {} };
  return state[channel];
}

/** Returns the remembered sessionId for (channel, cwd), if any. */
export function getCurrentSessionId(channel: string, cwd: string): string | undefined {
  return read()[channel]?.sessions[cwd];
}

/** Persists sessionId as the current one for (channel, cwd). */
export function setCurrentSessionId(channel: string, cwd: string, sessionId: string): void {
  const state = read();
  ensureChannel(state, channel).sessions[cwd] = sessionId;
  write(state);
}

/** Forgets the current sessionId for (channel, cwd); next prompt will create one. */
export function clearCurrentSessionId(channel: string, cwd: string): void {
  const state = read();
  if (state[channel]) {
    delete state[channel].sessions[cwd];
    write(state);
  }
}

/** Returns the last cwd the channel was switched to, if any. */
export function getCurrentCwd(channel: string): string | undefined {
  return read()[channel]?.cwd;
}

/** Persists cwd as the channel's current working directory. */
export function setCurrentCwd(channel: string, cwd: string): void {
  const state = read();
  ensureChannel(state, channel).cwd = cwd;
  write(state);
}
