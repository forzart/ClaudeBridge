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
    includePartialMessages: true,
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
