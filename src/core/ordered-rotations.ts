/** Serializes a dial's async handlers in event arrival order. */
export class OrderedRotations {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, number>();

  enqueue(key: string, task: (isLast: () => boolean) => Promise<void>): Promise<void> {
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);
    const prior = this.#tails.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(async () => {
      try {
        await task(() => this.#pending.get(key) === 1);
      } finally {
        const remaining = (this.#pending.get(key) ?? 1) - 1;
        if (remaining) this.#pending.set(key, remaining);
        else this.#pending.delete(key);
      }
    });
    this.#tails.set(key, run);
    void run.finally(() => {
      if (this.#tails.get(key) === run) this.#tails.delete(key);
    }).catch(() => undefined);
    return run;
  }

  async drain(key: string): Promise<void> {
    await this.#tails.get(key);
  }

  hasPending(key: string): boolean {
    return (this.#pending.get(key) ?? 0) > 0;
  }
}
