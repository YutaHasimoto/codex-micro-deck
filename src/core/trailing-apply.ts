/** Every configuration dial commits 80ms after its last rotation. */
export const TRAILING_APPLY_DELAY_MS = 80;

type TimerHandle = ReturnType<typeof setTimeout>;

type ScheduledEntry<Tag extends string> = {
  generation: number;
  tag: Tag;
  timer: TimerHandle | undefined;
  inFlight: Promise<boolean> | undefined;
};

export type SettledTrailingApply<Tag extends string> = {
  tag: Tag;
  succeeded: boolean;
};

/**
 * Runs only the last scheduled apply for each visible dial. Callers settle an
 * existing entry before a physical press, reload, reset, or a new rotation so
 * a delayed write cannot overtake a newer user action.
 */
export class TrailingApplyScheduler<Tag extends string> {
  readonly #delayMs: number;
  readonly #entries = new Map<string, ScheduledEntry<Tag>>();
  readonly #generations = new Map<string, number>();

  constructor(delayMs = TRAILING_APPLY_DELAY_MS) {
    this.#delayMs = Math.max(0, Math.trunc(delayMs));
  }

  schedule(
    key: string,
    tag: Tag,
    task: () => Promise<boolean>
  ): void {
    this.cancel(key);
    const generation = this.#advanceGeneration(key);
    const entry: ScheduledEntry<Tag> = {
      generation,
      tag,
      timer: undefined,
      inFlight: undefined
    };
    entry.timer = setTimeout(() => {
      if (this.#generations.get(key) !== generation || this.#entries.get(key) !== entry) return;
      entry.timer = undefined;
      const inFlight = Promise.resolve().then(task).catch(() => false);
      entry.inFlight = inFlight;
      void inFlight.then(
        () => this.#finish(key, entry),
        () => this.#finish(key, entry)
      );
    }, this.#delayMs);
    // Keep the plugin alive until the short trailing apply has had a chance
    // to run. Stream Deck owns the process lifecycle, so unref'ing this timer
    // can silently discard the only pending Codex write during an idle gap.
    this.#entries.set(key, entry);
  }

  /** Cancels a task that has not started. An already running write is allowed to finish. */
  cancel(key: string): void {
    this.#advanceGeneration(key);
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!entry.inFlight) this.#entries.delete(key);
  }

  /**
   * Cancels a pending timer or waits for an apply that already started. The
   * result lets a physical press avoid racing the same successful write.
   */
  async cancelAndWait(key: string): Promise<SettledTrailingApply<Tag> | undefined> {
    this.#advanceGeneration(key);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      this.#entries.delete(key);
      return undefined;
    }
    if (!entry.inFlight) {
      this.#entries.delete(key);
      return undefined;
    }
    const succeeded = await entry.inFlight;
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    return { tag: entry.tag, succeeded };
  }

  /** Cancels every pending dial and waits for any writes that already started. */
  async cancelAllAndWait(): Promise<void> {
    while (this.#entries.size > 0) {
      const keys = [...this.#entries.keys()];
      await Promise.all(keys.map((key) => this.cancelAndWait(key)));
    }
  }

  #advanceGeneration(key: string): number {
    const generation = (this.#generations.get(key) ?? 0) + 1;
    this.#generations.set(key, generation);
    return generation;
  }

  #finish(key: string, entry: ScheduledEntry<Tag>): void {
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
  }
}
