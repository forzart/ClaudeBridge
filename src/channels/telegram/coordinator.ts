/**
 * Per-session message coalescing for one Telegram bot. While a turn runs, a newer
 * message aborts the in-flight turn and is buffered; when the turn ends, the
 * buffered follow-ups run as the next turn (joined by newlines). The first message
 * is never re-sent — it stays in the session's history, so the coalesced turn,
 * which resumes the same session, still sees it.
 */
import type { Context } from 'grammy';
import type { SessionManager } from '../../session/manager.js';

/** Inputs the coordinator hands to a single turn run. */
export interface TurnArgs {
  ctx: Context;
  sessionId: string;
  cwd: string;
  prompt: string;
  controller: AbortController;
}

/** Per-session run state: chat to reply into, cwd, queued follow-ups, and the current turn's abort handle. */
interface Runner {
  ctx: Context;
  cwd: string;
  pending: string[];
  current?: AbortController;
}

/**
 * Coalesces rapid messages per sessionId. Registration with SessionManager is
 * continuous across coalesced turns, so `isActive` (and the commands that gate on
 * it) stays true for the whole run.
 */
export class TurnCoordinator {
  private readonly runners = new Map<string, Runner>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly runTurn: (args: TurnArgs) => Promise<void>,
  ) {}

  /** True when a run-loop owns this session — a follow-up should merge into it, not be rejected as busy. */
  has(sessionId: string): boolean {
    return this.runners.has(sessionId);
  }

  /** Non-blocking. Starts a run-loop for an idle session, or merges into and interrupts the in-flight one. */
  submit(args: { sessionId: string; cwd: string; ctx: Context; prompt: string }): void {
    const runner = this.runners.get(args.sessionId);
    if (runner) {
      runner.pending.push(args.prompt);
      runner.ctx = args.ctx;
      runner.current?.abort();
      return;
    }
    const fresh: Runner = { ctx: args.ctx, cwd: args.cwd, pending: [] };
    this.runners.set(args.sessionId, fresh);
    void this.loop(args.sessionId, fresh, args.prompt).catch(() => undefined);
  }

  /** Aborts the in-flight turn AND drops queued follow-ups, so /abort and shutdown stop the whole run (no drain). */
  abort(sessionId: string): boolean {
    const runner = this.runners.get(sessionId);
    if (!runner) return false;
    runner.pending = [];
    runner.current?.abort();
    return true;
  }

  /** Stops every in-flight run and clears all pending (graceful shutdown). */
  abortAll(): void {
    for (const sessionId of [...this.runners.keys()]) {
      this.abort(sessionId);
    }
  }

  /** Runs turns back-to-back, draining coalesced follow-ups, until the buffer is empty. */
  private async loop(sessionId: string, runner: Runner, firstPrompt: string): Promise<void> {
    let prompt = firstPrompt;
    try {
      for (;;) {
        const controller = new AbortController();
        runner.current = controller;
        this.sessionManager.register(sessionId, controller);
        await this.runTurn({ ctx: runner.ctx, sessionId, cwd: runner.cwd, prompt, controller });
        // Synchronous drain check — no `await` between the turn ending and here, so
        // a follow-up that arrived mid-turn is never dropped.
        if (runner.pending.length === 0) break;
        prompt = runner.pending.join('\n');
        runner.pending = [];
      }
    } finally {
      this.sessionManager.unregister(sessionId);
      this.runners.delete(sessionId);
    }
  }
}
