/** Thin wrapper around the Claude Agent SDK's query() — spawns Claude Code as a subprocess. */
import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
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
