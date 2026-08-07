/**
 * Serialises work within one dialog, runs different dialogs in parallel.
 *
 * Two answers to the same chat computed at once would arrive in the wrong
 * order and read as a mess. A job that throws is logged by its own caller and
 * must not block the rest of the queue.
 */
export class DialogQueue {
  private chains = new Map<string, Promise<void>>();

  enqueue(dialogId: string, job: () => Promise<void>): void {
    const previous = this.chains.get(dialogId) ?? Promise.resolve();
    const next = previous.then(() => job()).catch(() => undefined);
    this.chains.set(dialogId, next);
  }

  /** Resolves once every queued job has settled. Used by tests. */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
