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

  /**
   * Resolves once every job queued AT THE MOMENT OF THE CALL has settled.
   *
   * The chain map is read once: a job enqueued while we are waiting is not
   * awaited. That is enough for the webhook path, where jobs are only ever
   * queued from the top level, and for tests. It is NOT enough as a general
   * "drain everything" primitive — a shutdown that must not lose work needs
   * to stop accepting new jobs first.
   */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
