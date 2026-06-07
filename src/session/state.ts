/** Persists "current sessionId per (channel, cwd)" to ~/.claudebridge/state/sessions.json. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

const STATE_PATH = resolve(homedir(), '.claudebridge', 'state', 'sessions.json');

type ChannelState = Record<string, string>;
type AllChannelsState = Record<string, ChannelState>;

function read(): AllChannelsState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as AllChannelsState;
  } catch {
    // corrupt file — start fresh
  }
  return {};
}

function write(state: AllChannelsState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Returns the remembered sessionId for (channel, cwd), if any. */
export function getCurrentSessionId(channel: string, cwd: string): string | undefined {
  return read()[channel]?.[cwd];
}

/** Persists sessionId as the current one for (channel, cwd). */
export function setCurrentSessionId(channel: string, cwd: string, sessionId: string): void {
  const state = read();
  if (!state[channel]) state[channel] = {};
  state[channel][cwd] = sessionId;
  write(state);
}

/** Forgets the current sessionId for (channel, cwd); next prompt will create one. */
export function clearCurrentSessionId(channel: string, cwd: string): void {
  const state = read();
  if (state[channel]) {
    delete state[channel][cwd];
    write(state);
  }
}
