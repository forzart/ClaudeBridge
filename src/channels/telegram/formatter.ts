/** Converts SDK events into Telegram-ready chunks: assistant text + tool-call summaries; splits at 4096 chars. */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AssistantMessageEvent {
  type: 'assistant';
  message?: {
    content?: ContentBlock[];
  };
}

export type FormattedChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; text: string };

/** Extracts displayable chunks from an SDK event; returns empty when not an assistant message. */
export function formatSdkEvent(event: SDKMessage): FormattedChunk[] {
  if ((event as AssistantMessageEvent).type !== 'assistant') return [];
  const content = (event as AssistantMessageEvent).message?.content;
  if (!Array.isArray(content)) return [];

  const chunks: FormattedChunk[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      chunks.push({ kind: 'text', text: block.text });
    } else if (block.type === 'tool_use' && block.name) {
      chunks.push({ kind: 'tool', text: formatToolUse(block.name, block.input ?? {}) });
    }
  }
  return chunks;
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
  const summary = summarizeToolInput(name, input);
  return summary ? `⚒ ${name}: ${summary}` : `⚒ ${name}`;
}

const MAX_SUMMARY_LEN = 200;

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const get = (key: string): string | undefined => {
    const v = input[key];
    return typeof v === 'string' ? v : undefined;
  };

  let summary: string | undefined;
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      summary = get('file_path') ?? get('notebook_path');
      break;
    case 'Bash':
      summary = get('command');
      break;
    case 'Glob':
      summary = get('pattern');
      break;
    case 'Grep': {
      const pattern = get('pattern');
      const path = get('path');
      summary = path ? `${pattern} in ${path}` : pattern;
      break;
    }
    case 'WebFetch':
    case 'WebSearch':
      summary = get('url') ?? get('query');
      break;
    case 'Agent':
      summary = get('description') ?? get('subagent_type');
      break;
    default: {
      const firstKey = Object.keys(input)[0];
      if (firstKey) {
        const v = input[firstKey];
        summary = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
  }

  if (!summary) return '';
  return summary.length > MAX_SUMMARY_LEN
    ? summary.slice(0, MAX_SUMMARY_LEN) + '…'
    : summary;
}

const TELEGRAM_MAX_LEN = 4096;

/** Splits text at paragraph/word boundaries so each piece fits Telegram's 4096-char message limit. */
export function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LEN) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MAX_LEN) {
    const slice = remaining.slice(0, TELEGRAM_MAX_LEN);
    const splitAt = Math.max(
      slice.lastIndexOf('\n\n'),
      slice.lastIndexOf('\n'),
      slice.lastIndexOf(' '),
    );
    const cut = splitAt > TELEGRAM_MAX_LEN / 2 ? splitAt : TELEGRAM_MAX_LEN;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
