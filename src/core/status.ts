export type RolloutRecord = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

export type InferredRolloutStatus = {
  // "approval" is never produced from rollouts: Codex Desktop does not persist
  // approval requests to the rollout JSONL. The coordinator overlays it from
  // the live Desktop IPC follower instead. The member stays in the union so
  // ThreadSnapshot.phase can carry it through shared types.
  phase: "idle" | "working" | "approval" | "error";
  completedAt?: number;
};

const ERROR_EVENT_TYPES = new Set([
  "stream_error", "task_failed", "turn_failed", "failed"
]);

const TERMINAL_ERROR_EVENT_TYPES = new Set(["task_failed", "turn_failed"]);

function payloadType(record: RolloutRecord): string {
  return typeof record.payload?.type === "string" ? record.payload.type : "";
}

export class RolloutStatusAccumulator {
  #sequence = 0;
  #lastStarted = -1;
  #lastCompleted = -1;
  #lastError = -1;
  #completedAt: number | undefined;

  ingest(record: RolloutRecord): void {
    const index = this.#sequence++;
    const type = payloadType(record);
    if (record.type === "event_msg" && type === "task_started") {
      this.#lastStarted = index;
      this.#lastError = -1;
      this.#completedAt = undefined;
    }
    if (record.type === "event_msg" && type === "task_complete") {
      this.#lastCompleted = index;
      const timestamp = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
      if (Number.isFinite(timestamp)) this.#completedAt = timestamp;
    }
    if (record.type === "event_msg" && type === "turn_aborted") {
      // A user pressing Stop emits turn_aborted(reason="interrupted"). It is a
      // terminal idle state, not a red task failure, and must not stay blue.
      this.#lastCompleted = index;
      this.#completedAt = undefined;
      if (record.payload?.reason !== "interrupted") this.#lastError = index;
    }
    if (record.type === "event_msg" && ERROR_EVENT_TYPES.has(type)) {
      this.#lastError = index;
      if (TERMINAL_ERROR_EVENT_TYPES.has(type)) {
        this.#lastCompleted = index;
        this.#completedAt = undefined;
      }
    }
  }

  snapshot(): InferredRolloutStatus {
    if (this.#lastError >= this.#lastCompleted && this.#lastError > this.#lastStarted) {
      return { phase: "error", ...(this.#completedAt ? { completedAt: this.#completedAt } : {}) };
    }
    if (this.#lastStarted > this.#lastCompleted) return { phase: "working" };
    return { phase: "idle", ...(this.#completedAt ? { completedAt: this.#completedAt } : {}) };
  }
}

export function inferRolloutStatus(records: readonly RolloutRecord[]): InferredRolloutStatus {
  const accumulator = new RolloutStatusAccumulator();
  for (const record of records) accumulator.ingest(record);
  return accumulator.snapshot();
}

export function parseRolloutLines(lines: readonly string[]): InferredRolloutStatus {
  const records: RolloutRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as RolloutRecord;
      if (value && typeof value === "object") records.push(value);
    } catch {
      // The first chunk can start in the middle of a JSONL record; ignore it.
    }
  }
  return inferRolloutStatus(records);
}
