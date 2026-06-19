/** Reads Claude session JSONL files directly. Used to extract the last user prompt for display. */
import { readdirSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const PROJECTS_DIR = resolve(homedir(), '.claude', 'projects');

interface JournalEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface TextBlock {
  type: string;
  text?: string;
}

/** Locates the JSONL file for sessionId by scanning ~/.claude/projects/<projectKey>/. */
function findJsonlPath(sessionId: string): string | undefined {
  if (!existsSync(PROJECTS_DIR)) return undefined;
  const projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());
  for (const dir of projectDirs) {
    const candidate = resolve(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Returns the most recent user prompt for sessionId, or undefined if not found.
 * Skips tool_result messages, command artifacts, and synthetic continuation prompts.
 */
export function getLastUserPrompt(sessionId: string): string | undefined {
  const jsonlPath = findJsonlPath(sessionId);
  if (!jsonlPath) return undefined;

  const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as JournalEntry;
      if (entry.type !== 'user') continue;
      const text = extractUserText(entry.message?.content);
      if (text === undefined) continue;
      if (isArtifact(text)) continue;
      return text;
    } catch {
      // unparseable line — skip
    }
  }
  return undefined;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** Returns all user/assistant text messages for sessionId (tool calls/results omitted), oldest first. */
export function getRecentTranscript(sessionId: string): TranscriptMessage[] {
  const jsonlPath = findJsonlPath(sessionId);
  if (!jsonlPath) return [];

  const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      continue;
    }
    if (entry.type === 'user') {
      const text = extractUserText(entry.message?.content);
      if (text === undefined || isArtifact(text)) continue;
      pushMerged(messages, 'user', text);
    } else if (entry.type === 'assistant') {
      const text = extractAssistantText(entry.message?.content);
      if (text === undefined) continue;
      pushMerged(messages, 'assistant', text);
    }
  }
  return messages;
}

/** Appends to the last message when it shares the role, so a turn split across JSONL entries stays one block. */
function pushMerged(messages: TranscriptMessage[], role: 'user' | 'assistant', text: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    messages[messages.length - 1] = { role, text: `${last.text}\n${text}` };
  } else {
    messages.push({ role, text });
  }
}

function extractAssistantText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const blocks = content as TextBlock[];
  const joined = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
  return joined.length > 0 ? joined : undefined;
}

function extractUserText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  // Skip messages whose only block is a tool_result.
  const blocks = content as TextBlock[];
  const textBlock = blocks.find((b) => b.type === 'text' && typeof b.text === 'string');
  return textBlock?.text;
}

const ARTIFACT_PREFIXES = [
  '<command-name>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  'Continue from where you left off',
  'This session is being continued from a previous conversation',
];

function isArtifact(text: string): boolean {
  return ARTIFACT_PREFIXES.some((p) => text.startsWith(p));
}
