/** Thin wrapper around the Claude Agent SDK's query() — spawns Claude Code as a subprocess. */
import { query, type Query, type SDKUserMessage, type SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'fs';

export interface NewSessionParams {
  prompt: string;
  sessionId: string;
  cwd: string;
  abortController: AbortController;
}

export interface ResumeSessionParams {
  prompt: string;
  sessionId: string;
  cwd: string;
  abortController: AbortController;
}

export interface QueryHandle {
  sessionId: string;
  generator: Query;
}

function buildCommonOptions(abortController: AbortController): Record<string, unknown> {
  return {
    tools: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    abortController,
    // We render only complete assistant messages (formatSdkEvent ignores partial
    // stream events). Leaving partials on meant the final text block could arrive
    // out of band / one turn late, so a reply "went missing" then surfaced on the
    // next message. Disable partials so each turn's full message is delivered in-band.
    includePartialMessages: false,
  };
}

/** Starts a brand-new session with the given sessionId; ensures cwd exists first. */
export function startNewSession(params: NewSessionParams): QueryHandle {
  mkdirSync(params.cwd, { recursive: true });
  const generator = query({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      sessionId: params.sessionId,
      ...buildCommonOptions(params.abortController),
    },
  });
  return { sessionId: params.sessionId, generator };
}

/** Resumes an existing session by sessionId; CLI loads prior conversation from its JSONL. */
export function resumeSession(params: ResumeSessionParams): QueryHandle {
  const generator = query({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      resume: params.sessionId,
      ...buildCommonOptions(params.abortController),
    },
  });
  return { sessionId: params.sessionId, generator };
}

const CTX_USAGE_TIMEOUT_MS = 15_000;

/**
 * Reads a resumed session's context-window usage WITHOUT running a turn: opens a
 * streaming-input query whose prompt yields nothing, asks the CLI for usage over
 * the control channel, then aborts to tear the subprocess down.
 */
export async function fetchContextUsage(params: {
  sessionId: string;
  cwd: string;
}): Promise<SDKControlGetContextUsageResponse> {
  const abortController = new AbortController();
  const q = query({
    prompt: idleInput(abortController.signal),
    options: {
      cwd: params.cwd,
      resume: params.sessionId,
      ...buildCommonOptions(abortController),
    },
  });
  // Drain the stream in the background so the subprocess initializes and the
  // control channel stays responsive while we ask for usage.
  const drain = (async () => {
    for await (const event of q) {
      void event;
    }
  })();
  drain.catch(() => undefined);
  try {
    return await withTimeout(q.getContextUsage(), CTX_USAGE_TIMEOUT_MS);
  } finally {
    abortController.abort();
    await drain.catch(() => undefined);
  }
}

/** Streaming-input prompt that yields no messages and ends only once aborted. */
async function* idleInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Rejects if the promise doesn't settle within ms — keeps /ctx from hanging on a stuck control channel. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`context-usage request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
