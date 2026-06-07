/** Looks up Claude sessions for a cwd by full UUID, UUID prefix, tag, or customTitle. */
import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

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

/** One-line human label: short id + alias + summary + relative age. */
export function describeSession(s: SDKSessionInfo): string {
  const shortId = s.sessionId.slice(0, 8);
  const alias = s.tag ? `[${s.tag}]` : s.customTitle ? `"${s.customTitle}"` : '';
  const summary = (s.customTitle ?? s.firstPrompt ?? s.summary ?? '').slice(0, 60);
  const age = formatAge(Date.now() - s.lastModified);
  return [shortId, alias, summary, `(${age})`].filter(Boolean).join(' ');
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
