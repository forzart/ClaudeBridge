/** Converts SDK events into Telegram-ready chunks: assistant text + tool-call summaries; splits at 4096 chars. */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AssistantMessageEvent {
  type: 'assistant';
  message?: {
    content?: ContentBlock[];
  };
  /** Abnormal-stop code (e.g. 'max_output_tokens', 'rate_limit', 'server_error') when the turn failed. */
  error?: string;
}

interface ResultMessageEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  errors?: string[];
  result?: string;
}

export type FormattedChunk =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'error'; text: string };

/** Extracts displayable chunks from an SDK event; surfaces assistant content plus error/result failures that would otherwise be silent. */
export function formatSdkEvent(event: SDKMessage): FormattedChunk[] {
  const type = (event as { type?: string }).type;
  if (type === 'assistant') return formatAssistantEvent(event as AssistantMessageEvent);
  if (type === 'result') return formatResultEvent(event as ResultMessageEvent);
  return [];
}

/** Text/thinking/tool blocks, plus a trailing error chunk if the assistant message stopped abnormally. */
function formatAssistantEvent(event: AssistantMessageEvent): FormattedChunk[] {
  const chunks: FormattedChunk[] = [];
  const content = event.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        chunks.push({ kind: 'text', text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        chunks.push({ kind: 'thinking', text: formatThinking(block.thinking) });
      } else if (block.type === 'tool_use' && block.name) {
        chunks.push({ kind: 'tool', text: formatToolUse(block.name, block.input ?? {}) });
      }
    }
  }
  if (event.error) {
    chunks.push({ kind: 'error', text: `⚠️ Claude stopped early — ${describeAssistantError(event.error)}.` });
  }
  return chunks;
}

/** Success results only echo the already-streamed final text (dropped); error results are surfaced so a failed turn isn't silent. */
function formatResultEvent(event: ResultMessageEvent): FormattedChunk[] {
  const isError = event.is_error === true || (event.subtype !== undefined && event.subtype !== 'success');
  if (!isError) return [];
  const detail = (event.errors ?? []).filter(Boolean).join('; ');
  const base = describeResultError(event.subtype);
  return [{ kind: 'error', text: detail ? `❌ ${base}: ${detail}` : `❌ ${base}.` }];
}

/** Final assistant text carried by a successful result event — used only as a fallback when nothing streamed. */
export function resultFallbackText(event: SDKMessage): string | undefined {
  const e = event as ResultMessageEvent;
  if (e.type !== 'result' || e.subtype !== 'success') return undefined;
  const text = e.result?.trim();
  return text ? text : undefined;
}

/** Maps an SDKAssistantMessageError code to a human-readable phrase. */
function describeAssistantError(error: string): string {
  switch (error) {
    case 'max_output_tokens':
      return 'it hit the output-token limit and was cut off (try a shorter ask, or /new)';
    case 'rate_limit':
      return 'the API rate-limited the request';
    case 'billing_error':
      return 'a billing error occurred';
    case 'authentication_failed':
      return 'authentication failed';
    case 'oauth_org_not_allowed':
      return 'this organization is not allowed';
    case 'invalid_request':
      return 'the request was invalid';
    case 'server_error':
      return 'the API had a server error';
    default:
      return `it ended with an error (${error})`;
  }
}

/** Maps an SDKResultError subtype to a human-readable phrase. */
function describeResultError(subtype?: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'Run hit the maximum number of turns';
    case 'error_max_budget_usd':
      return 'Run hit the cost budget';
    case 'error_during_execution':
      return 'Run errored during execution';
    case 'error_max_structured_output_retries':
      return 'Run exceeded structured-output retries';
    default:
      return 'Run ended with an error';
  }
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
  const summary = summarizeToolInput(name, input);
  return summary ? `⚒ ${name}: ${summary}` : `⚒ ${name}`;
}

const THINKING_PREVIEW_LEN = 200;

/** One-line truncated preview of a thinking block, shown like a tool summary (💭). */
function formatThinking(thinking: string): string {
  const oneLine = thinking.replace(/\s+/g, ' ').trim();
  return `💭 ${oneLine.length > THINKING_PREVIEW_LEN ? oneLine.slice(0, THINKING_PREVIEW_LEN) + '…' : oneLine}`;
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
