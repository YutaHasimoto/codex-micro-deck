import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  RolloutStatusAccumulator,
  type InferredRolloutStatus,
  type RolloutRecord
} from "../core/status.js";
import type { ThreadSnapshot } from "../types.js";
import { runProcess } from "../system/process.js";

type ThreadRow = {
  id: string;
  title: string;
  rollout_path: string;
  updated_at_ms: number;
};

type RolloutCache = {
  device: number;
  inode: number;
  offset: number;
  accumulator: RolloutStatusAccumulator;
};

// Rollout records can contain large tool payloads or embedded media that are
// irrelevant to the small status machine. Capping a single JSONL record keeps
// one unusual task from exhausting the Stream Deck plugin process.
const MAX_STATUS_RECORD_BYTES = 2 * 1024 * 1024;

export class LocalCodexStateProvider {
  readonly #codexRoot: string;
  readonly #stateDbPath: string;
  readonly #inboxDbPath: string;
  readonly #rolloutCache = new Map<string, RolloutCache>();
  #lastGoodThreads: ThreadSnapshot[] = [];

  constructor(userHome = homedir()) {
    this.#codexRoot = path.resolve(userHome, ".codex");
    this.#stateDbPath = path.join(this.#codexRoot, "state_5.sqlite");
    this.#inboxDbPath = path.join(this.#codexRoot, "sqlite", "codex-dev.db");
  }

  async listRecentThreads(): Promise<ThreadSnapshot[]> {
    try {
      await access(this.#stateDbPath);
    } catch {
      this.#lastGoodThreads = [];
      this.#rolloutCache.clear();
      return [];
    }

    try {
      const rows = await this.#queryRows();
      const inboxUnread = await this.#queryUnreadInbox();
      const threads = await Promise.all(rows.map(async (row): Promise<ThreadSnapshot> => {
        const status: InferredRolloutStatus = await this.#statusForRollout(row.rollout_path)
          .catch(() => this.#cachedStatus(row.rollout_path));
        const sourceUnreadAt = inboxUnread.get(row.id);
        return {
          id: row.id,
          title: row.title,
          rolloutPath: row.rollout_path,
          updatedAt: Number(row.updated_at_ms),
          phase: status.phase,
          ...(status.completedAt ? { completedAt: status.completedAt } : {}),
          ...(sourceUnreadAt !== undefined ? { sourceUnread: true, sourceUnreadAt } : {})
        };
      }));
      this.#pruneCache(new Set(rows.flatMap((row) => {
        const resolved = path.resolve(row.rollout_path);
        return resolved.startsWith(`${this.#codexRoot}${path.sep}`) ? [resolved] : [];
      })));
      this.#lastGoodThreads = threads.map((thread) => ({ ...thread }));
      return threads;
    } catch {
      // session_index.jsonl has no trustworthy source/thread_source metadata.
      // Retaining the last verified snapshot through a transient SQLite/WAL
      // failure prevents all six physical agent assignments from flickering off.
      return this.#lastGoodThreads.map((thread) => ({ ...thread }));
    }
  }

  async #queryRows(): Promise<ThreadRow[]> {
    // `name` was added after the first state_5 schema. Do not fall back to
    // title/preview when it is absent: those fields are commonly the first
    // user message and are not a trustworthy human-facing task name.
    const schema = await runProcess(
      "/usr/bin/sqlite3",
      ["-readonly", "-json", this.#stateDbPath, "PRAGMA table_info(threads);"],
      { timeoutMs: 1500, maxOutputBytes: 64 * 1024 }
    );
    if (schema.exitCode !== 0) throw new Error("Codex state database schema query failed");
    const columns = JSON.parse(schema.stdout || "[]") as Array<{ name?: unknown }>;
    const hasNameColumn = columns.some((column) => column.name === "name");
    const titleExpression = hasNameColumn
      ? "COALESCE(NULLIF(name, ''), 'Untitled')"
      : "'Untitled'";
    const query = `
SELECT
  id,
  substr(${titleExpression}, 1, 240) AS title,
  rollout_path,
  COALESCE(updated_at_ms, updated_at * 1000) AS updated_at_ms
FROM threads
WHERE archived = 0
  AND source = 'vscode'
  AND thread_source = 'user'
ORDER BY recency_at_ms DESC, updated_at_ms DESC
LIMIT 6;
`.trim();
    const result = await runProcess(
      "/usr/bin/sqlite3",
      ["-readonly", "-json", this.#stateDbPath, query],
      { timeoutMs: 3000, maxOutputBytes: 128 * 1024 }
    );
    if (result.exitCode !== 0) throw new Error("Codex state database query failed");
    const value = JSON.parse(result.stdout || "[]") as unknown;
    if (!Array.isArray(value)) throw new Error("Unexpected Codex state database result");
    return value.filter(isThreadRow).slice(0, 6);
  }

  async #queryUnreadInbox(): Promise<Map<string, number>> {
    try {
      await access(this.#inboxDbPath);
      const result = await runProcess(
        "/usr/bin/sqlite3",
        ["-readonly", "-json", this.#inboxDbPath,
          `SELECT thread_id, MAX(created_at) AS created_at
           FROM inbox_items
           WHERE read_at IS NULL AND thread_id IS NOT NULL
           GROUP BY thread_id;`],
        { timeoutMs: 1500, maxOutputBytes: 64 * 1024 }
      );
      if (result.exitCode !== 0) return new Map();
      const rows = JSON.parse(result.stdout || "[]") as Array<{
        thread_id?: unknown;
        created_at?: unknown;
      }>;
      const unread = new Map<string, number>();
      for (const row of rows) {
        if (typeof row.thread_id !== "string") continue;
        const createdAt = normalizeEpochMs(row.created_at);
        if (createdAt !== undefined) unread.set(row.thread_id, createdAt);
      }
      return unread;
    } catch {
      return new Map();
    }
  }

  async #statusForRollout(rolloutPath: string): Promise<ReturnType<RolloutStatusAccumulator["snapshot"]>> {
    const resolved = path.resolve(rolloutPath);
    if (!resolved.startsWith(`${this.#codexRoot}${path.sep}`)) {
      throw new Error("Rollout path is outside the Codex data directory");
    }

    const fileStat = await stat(resolved);
    let cache = this.#rolloutCache.get(resolved);
    if (!cache
      || fileStat.dev !== cache.device
      || fileStat.ino !== cache.inode
      || fileStat.size < cache.offset) {
      cache = {
        device: fileStat.dev,
        inode: fileStat.ino,
        offset: 0,
        accumulator: new RolloutStatusAccumulator()
      };
      this.#rolloutCache.set(resolved, cache);
    }
    if (fileStat.size === cache.offset) return cache.accumulator.snapshot();

    let pendingChunks: Buffer[] = [];
    let pendingLength = 0;
    let pendingTooLarge = false;
    let consumed = 0;
    const stream = createReadStream(resolved, {
      start: cache.offset,
      end: fileStat.size - 1,
      highWaterMark: 256 * 1024
    });
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let lineStart = 0;
      let newline = chunk.indexOf(0x0a, lineStart);
      while (newline !== -1) {
        const tail = chunk.subarray(lineStart, newline);
        let line: string;
        if (pendingTooLarge || pendingLength + tail.length > MAX_STATUS_RECORD_BYTES) {
          line = "";
        } else if (pendingChunks.length) {
          pendingChunks.push(tail);
          line = Buffer.concat(pendingChunks, pendingLength + tail.length).toString("utf8");
        } else {
          line = tail.toString("utf8");
        }
        this.#ingestLine(cache.accumulator, line);
        consumed += pendingLength + tail.length + 1;
        pendingChunks = [];
        pendingLength = 0;
        pendingTooLarge = false;
        lineStart = newline + 1;
        newline = chunk.indexOf(0x0a, lineStart);
      }
      if (lineStart < chunk.length) {
        const tail = chunk.subarray(lineStart);
        if (!pendingTooLarge && pendingLength + tail.length <= MAX_STATUS_RECORD_BYTES) {
          pendingChunks.push(tail);
        } else {
          pendingChunks = [];
          pendingTooLarge = true;
        }
        pendingLength += tail.length;
      }
    }
    // Keep the offset at the last complete JSONL record. A partial final line is retried next poll.
    cache.offset += consumed;
    return cache.accumulator.snapshot();
  }

  #ingestLine(accumulator: RolloutStatusAccumulator, line: string): void {
    if (!line) return;
    try {
      const record = JSON.parse(line) as RolloutRecord;
      if (record && typeof record === "object") accumulator.ingest(record);
    } catch {
      // A damaged record should not stop the remaining status stream.
    }
  }

  #pruneCache(activePaths: Set<string>): void {
    for (const cachedPath of this.#rolloutCache.keys()) {
      if (!activePaths.has(cachedPath)) this.#rolloutCache.delete(cachedPath);
    }
  }

  #cachedStatus(rolloutPath: string): InferredRolloutStatus {
    const resolved = path.resolve(rolloutPath);
    return this.#rolloutCache.get(resolved)?.accumulator.snapshot() ?? { phase: "idle" };
  }

}

function isThreadRow(value: unknown): value is ThreadRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string"
    && typeof row.title === "string"
    && typeof row.rollout_path === "string"
    && typeof row.updated_at_ms === "number";
}

function normalizeEpochMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // Codex database generations have used both Unix seconds and milliseconds.
  return value < 1_000_000_000_000 ? value * 1000 : value;
}
