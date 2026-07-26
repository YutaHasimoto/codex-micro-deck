export type UnreadThreadInput = {
  id: string;
  updatedAt: number;
  phase: "idle" | "working" | "approval" | "error";
  completedAt?: number;
  sourceUnread?: boolean;
  sourceUnreadAt?: number;
};

export type SeenEntry = { seenUpdatedAt: number; unread: boolean };

export class UnreadTracker {
  readonly #entries: Record<string, SeenEntry>;

  constructor(initial: Record<string, SeenEntry> = {}) {
    this.#entries = structuredClone(initial);
  }

  reconcile(thread: UnreadThreadInput): { unread: boolean; changed: boolean } {
    const current = this.#entries[thread.id];
    if (!current) {
      const unread = thread.sourceUnread === true;
      const sourceMarker = thread.sourceUnreadAt ?? thread.updatedAt;
      this.#entries[thread.id] = {
        seenUpdatedAt: Math.max(thread.updatedAt, sourceMarker),
        unread
      };
      return { unread, changed: true };
    }

    const sourceMarker = thread.sourceUnreadAt ?? thread.updatedAt;
    const completedSinceSeen = (thread.sourceUnread === true && sourceMarker > current.seenUpdatedAt)
      || (thread.phase === "idle"
        && thread.completedAt !== undefined
        && thread.completedAt > current.seenUpdatedAt
        && thread.updatedAt > current.seenUpdatedAt);
    if (completedSinceSeen && !current.unread) {
      current.seenUpdatedAt = Math.max(
        current.seenUpdatedAt,
        thread.updatedAt,
        thread.completedAt ?? 0,
        thread.sourceUnread === true ? sourceMarker : 0
      );
      current.unread = true;
      return { unread: true, changed: true };
    }
    return { unread: current.unread, changed: false };
  }

  markSeen(threadId: string, updatedAt: number): boolean {
    const current = this.#entries[threadId];
    if (current && !current.unread && current.seenUpdatedAt >= updatedAt) return false;
    this.#entries[threadId] = {
      seenUpdatedAt: Math.max(updatedAt, current?.seenUpdatedAt ?? 0),
      unread: false
    };
    return true;
  }

  isUnread(threadId: string): boolean {
    return this.#entries[threadId]?.unread === true;
  }

  prune(activeIds: readonly string[], maxEntries = 100): boolean {
    const active = new Set(activeIds);
    const keys = Object.keys(this.#entries);
    if (keys.length <= maxEntries) return false;
    let changed = false;
    let entryCount = keys.length;
    for (const key of keys) {
      if (entryCount <= maxEntries) break;
      if (!active.has(key)) {
        delete this.#entries[key];
        entryCount -= 1;
        changed = true;
      }
    }
    return changed;
  }

  snapshot(): Record<string, SeenEntry> {
    return structuredClone(this.#entries);
  }
}
