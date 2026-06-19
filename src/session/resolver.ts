/** Looks up Claude sessions for a cwd by full UUID, UUID prefix, tag, or customTitle. */
import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { getLastUserPrompt, getRecentTranscript, type TranscriptMessage } from './jsonl.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedSession {
  sessionId: string;
  matched: 'uuid' | 'prefix' | 'tag' | 'title';
  info: SDKSessionInfo;
}

/** Resolves a user-supplied alias to a concrete session; tries UUID → tag → customTitle → unique prefix. */
export async function resolveSession(
  idOrAlias: string,
  cwd: string,
): Promise<ResolvedSession | null> {
  const sessions = await listSessions({ dir: cwd });
  if (sessions.length === 0) return null;

  const needle = idOrAlias.trim();
  const lower = needle.toLowerCase();

  if (UUID_RE.test(needle)) {
    const match = sessions.find((s) => s.sessionId.toLowerCase() === lower);
    return match ? { sessionId: match.sessionId, matched: 'uuid', info: match } : null;
  }

  const tagMatch = sessions.find((s) => s.tag?.toLowerCase() === lower);
  if (tagMatch) return { sessionId: tagMatch.sessionId, matched: 'tag', info: tagMatch };

  const titleMatch = sessions.find((s) => s.customTitle?.toLowerCase() === lower);
  if (titleMatch) return { sessionId: titleMatch.sessionId, matched: 'title', info: titleMatch };

  const prefixMatches = sessions.filter((s) => s.sessionId.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) {
    return { sessionId: prefixMatches[0].sessionId, matched: 'prefix', info: prefixMatches[0] };
  }

  return null;
}

/** Most-recently-modified session in this cwd, or null if none exist. */
export async function getLatestSession(cwd: string): Promise<SDKSessionInfo | null> {
  const sessions = await listSessions({ dir: cwd });
  if (sessions.length === 0) return null;
  return sessions.sort((a, b) => b.lastModified - a.lastModified)[0];
}

/** All sessions in this cwd, newest first. */
export async function listAllSessions(cwd: string): Promise<SDKSessionInfo[]> {
  const sessions = await listSessions({ dir: cwd });
  return sessions.sort((a, b) => b.lastModified - a.lastModified);
}

export interface SessionRow {
  sessionId: string;
  tag?: string;
  customTitle?: string;
  lastPrompt?: string;
  lastModified?: number;
  isCurrent?: boolean;
}

export function sessionInfoToRow(s: SDKSessionInfo, currentSessionId?: string): SessionRow {
  return {
    sessionId: s.sessionId,
    tag: s.tag,
    customTitle: s.customTitle,
    lastPrompt: getLastUserPrompt(s.sessionId) ?? s.firstPrompt ?? s.summary,
    lastModified: s.lastModified,
    isCurrent: currentSessionId ? s.sessionId === currentSessionId : false,
  };
}

/** One session as two lines: bold "[index] marker shortid · age" + indented last-prompt snippet. */
function sessionEntry(row: SessionRow, index?: number): string {
  const marker = row.isCurrent ? '▸' : '•';
  const id = row.sessionId.slice(0, 8);
  const age = row.lastModified ? ` · ${formatAge(Date.now() - row.lastModified)}` : '';
  const prefix = index !== undefined ? `${index} ` : '';
  const head = `${prefix}${marker} ${id}${age}`;
  const prompt = row.lastPrompt ? truncate(collapse(row.lastPrompt), 50) : '(no messages yet)';
  return `<b>${escapeHtml(head)}</b>\n  ${escapeHtml(prompt)}`;
}

/**
 * Mobile-friendly session list (HTML, not a monospace table). Two lines per
 * session: a bold header (index + marker + short id + age) and the indented
 * last-prompt snippet. Wraps naturally on narrow screens.
 */
export function formatSessionList(rows: SessionRow[]): string {
  return rows.map((r, i) => sessionEntry(r, i + 1)).join('\n');
}

/** A single session's detail (no index prefix) — used by /whoami. */
export function formatSessionDetail(row: SessionRow): string {
  return sessionEntry(row);
}

const VIEW_ROUNDS = 5; // last 5 rounds (user → assistant)
const VIEW_PER_MESSAGE_CAP = 1000; // escaped chars shown per message
const VIEW_CHUNK_CAP = 3800; // < Telegram's 4096, leaving margin for tags

/** Keeps only the last `rounds` user-led rounds (each user message plus the assistant replies that follow it). */
function lastRounds(messages: TranscriptMessage[], rounds: number): TranscriptMessage[] {
  let userSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && ++userSeen === rounds) {
      return messages.slice(i);
    }
  }
  return messages;
}

/** Renders a session's recent transcript into Telegram-HTML chunks (each ≤ 4096), never splitting a message mid-tag. */
export function formatTranscriptChunks(sessionId: string): string[] {
  const messages = lastRounds(getRecentTranscript(sessionId), VIEW_ROUNDS);
  if (messages.length === 0) return [];

  const blocks = messages.map((m) => {
    const who = m.role === 'user' ? '👤 You' : '🤖 Claude';
    let body = escapeHtml(m.text);
    if (body.length > VIEW_PER_MESSAGE_CAP) body = body.slice(0, VIEW_PER_MESSAGE_CAP) + '…';
    return `<b>${who}</b>\n<blockquote>${body}</blockquote>`;
  });

  const chunks: string[] = [];
  let current = `<b>📄 Recent · ${escapeHtml(sessionId.slice(0, 8))}</b>`;
  for (const block of blocks) {
    if (current.length + 1 + block.length > VIEW_CHUNK_CAP) {
      chunks.push(current);
      current = block;
    } else {
      current = `${current}\n${block}`;
    }
  }
  chunks.push(current);
  return chunks;
}

/** Renders a single session as a one-row <pre> table with headers; falls back to id-only if not on disk. */
export async function formatSessionTableById(sessionId: string, cwd: string): Promise<string> {
  try {
    const sessions = await listSessions({ dir: cwd });
    const info = sessions.find((s) => s.sessionId === sessionId);
    if (info) {
      return formatSessionsTable([sessionInfoToRow(info)], { showMarker: false });
    }
  } catch {
    // fall through
  }
  return formatSessionsTable([{ sessionId }], { showMarker: false });
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export { escapeHtml };

interface TableOptions {
  currentSessionId?: string;
  showMarker?: boolean;
}

/** Renders sessions as a Telegram <pre> table with header row: marker | id | tag | title | last prompt | age. */
export function formatSessionsTable(
  rows: SessionRow[],
  opts: TableOptions = {},
): string {
  const showMarker = opts.showMarker !== false;

  const cells = rows.map((r) => ({
    marker: r.isCurrent ? '▸' : ' ',
    id: r.sessionId.slice(0, 8),
    tag: r.tag ?? '',
    title: r.customTitle ?? '',
    prompt: collapse(r.lastPrompt ?? ''),
    age: r.lastModified ? formatAge(Date.now() - r.lastModified) : '',
  }));

  const headers = {
    marker: ' ',
    id: 'ID',
    tag: 'TAG',
    title: 'TITLE',
    prompt: 'LAST PROMPT',
    age: 'AGE',
  };

  const idW = Math.max(8, headers.id.length);
  const tagW = clamp(Math.max(maxLen(cells, 'tag'), headers.tag.length), 0, 12);
  const titleW = clamp(Math.max(maxLen(cells, 'title'), headers.title.length), 0, 18);
  const ageW = clamp(Math.max(maxLen(cells, 'age'), headers.age.length), 3, 6);
  const promptW = clamp(Math.max(maxLen(cells, 'prompt'), headers.prompt.length), 10, 36);

  const hasTag = tagW > 0;
  const hasTitle = titleW > 0;

  const buildRow = (c: typeof headers): string => {
    const parts: string[] = [];
    if (showMarker) parts.push(c.marker);
    parts.push(pad(c.id, idW));
    if (hasTag) parts.push(pad(truncate(c.tag, tagW), tagW));
    if (hasTitle) parts.push(pad(truncate(c.title, titleW), titleW));
    parts.push(pad(truncate(c.prompt, promptW), promptW));
    parts.push(pad(c.age, ageW));
    return parts.join(' ');
  };

  const headerLine = buildRow(headers);
  const sepLine = '-'.repeat(headerLine.length);
  const dataLines = cells.map(buildRow);

  return `<pre>${escapeHtml([headerLine, sepLine, ...dataLines].join('\n'))}</pre>`;
}

function maxLen<K extends string>(rows: Array<Record<K, string>>, key: K): number {
  let max = 0;
  for (const r of rows) max = Math.max(max, r[key].length);
  return max;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + ' '.repeat(width - text.length);
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
