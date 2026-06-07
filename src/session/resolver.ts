/** Looks up Claude sessions for a cwd by full UUID, UUID prefix, tag, or customTitle. */
import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { getLastUserPrompt } from './jsonl.js';

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

/** One-line Telegram HTML label: <code>id</code> [tag] [title] lastPrompt (age). */
export function describeSession(s: SDKSessionInfo): string {
  const shortId = `<code>${s.sessionId.slice(0, 8)}</code>`;
  const parts: string[] = [shortId];
  if (s.tag) parts.push(`<b>[${escapeHtml(s.tag)}]</b>`);
  if (s.customTitle) parts.push(`<i>[${escapeHtml(s.customTitle)}]</i>`);
  const prompt = getLastUserPrompt(s.sessionId) ?? s.firstPrompt ?? s.summary;
  if (prompt) parts.push(escapeHtml(truncate(prompt, 80)));
  parts.push(`<i>(${formatAge(Date.now() - s.lastModified)})</i>`);
  return parts.join(' ');
}

/** Like describeSession but resolves by sessionId; falls back to short id when info is missing. */
export async function describeSessionById(sessionId: string, cwd: string): Promise<string> {
  try {
    const sessions = await listSessions({ dir: cwd });
    const info = sessions.find((s) => s.sessionId === sessionId);
    if (info) return describeSession(info);
  } catch {
    // fall through
  }
  return `<code>${sessionId.slice(0, 8)}</code> <i>(no info yet)</i>`;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export { escapeHtml };

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
