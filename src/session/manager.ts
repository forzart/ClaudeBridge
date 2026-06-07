/** Process-wide tracker of in-flight Claude queries, keyed by sessionId. */
interface ActiveEntry {
  controller: AbortController;
}

/**
 * Tracks running Claude queries keyed by sessionId, so multiple channels
 * (telegram, discord, web) cannot concurrently write to the same JSONL file.
 */
export class SessionManager {
  private active = new Map<string, ActiveEntry>();

  /** Marks sessionId as running with this controller; aborts any prior holder. */
  register(sessionId: string, controller: AbortController): void {
    const existing = this.active.get(sessionId);
    if (existing) {
      existing.controller.abort();
    }
    this.active.set(sessionId, { controller });
  }

  /** True if a query is currently running for this sessionId. */
  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Aborts the running query for sessionId. Returns true if anything was aborted. */
  abort(sessionId: string): boolean {
    const entry = this.active.get(sessionId);
    if (!entry) return false;
    entry.controller.abort();
    this.active.delete(sessionId);
    return true;
  }

  /** Removes the entry without aborting (for the natural end of a query). */
  unregister(sessionId: string): void {
    this.active.delete(sessionId);
  }

  /** Aborts all in-flight queries; used during graceful shutdown. */
  abortAll(): void {
    for (const [, entry] of this.active) {
      entry.controller.abort();
    }
    this.active.clear();
  }

  /** Snapshot of currently-running sessionIds (for diagnostics). */
  getActiveSessionIds(): string[] {
    return [...this.active.keys()];
  }
}
