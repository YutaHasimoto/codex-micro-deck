import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Production ESM uses .js specifiers so the compiled plugin runs on Node 24.
// During source tests, resolve those local specifiers to their .ts sources.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const sourceUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(sourceUrl))) {
        return { url: sourceUrl.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
});

const { LocalCodexStateProvider } = await import("../src/codex/local-state-provider.ts");

function makeHome(): { home: string; codex: string } {
  const home = mkdtempSync(path.join(tmpdir(), "codex-micro-deck-test-"));
  const codex = path.join(home, ".codex");
  mkdirSync(path.join(codex, "sqlite"), { recursive: true });
  return { home, codex };
}

function createStateDb(dbPath: string, userRollout: string, internalRollout: string): void {
  const sql = `
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      preview TEXT NOT NULL,
      name TEXT,
      rollout_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER,
      recency_at_ms INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      source TEXT NOT NULL,
      thread_source TEXT
    );
    INSERT INTO threads VALUES
      ('user-thread', 'User task', 'The first user message', 'Named user task', '${userRollout}', 2000, 2000000, 2000000, 0, 'vscode', 'user'),
      ('guardian-thread', 'Internal task', 'The first internal message', 'Internal task name', '${internalRollout}', 3000, 3000000, 3000000, 0, 'subagent', 'subagent');
  `;
  execFileSync("/usr/bin/sqlite3", [dbPath, sql]);
}

function record(type: string, timestamp = "2026-07-21T12:00:00.000Z"): string {
  return `${JSON.stringify({ timestamp, type: "event_msg", payload: { type } })}\n`;
}

test("a missing state database yields no assignments, never unverified fallback sessions", async () => {
  const { home } = makeHome();
  const provider = new LocalCodexStateProvider(home);
  assert.deepEqual(await provider.listRecentThreads(), []);
});

test("a legacy state database without name never promotes title or preview into the task label", async () => {
  const { home, codex } = makeHome();
  const rollout = path.join(codex, "legacy.jsonl");
  writeFileSync(rollout, record("task_complete"));
  execFileSync("/usr/bin/sqlite3", [path.join(codex, "state_5.sqlite"), `
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      preview TEXT NOT NULL,
      rollout_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER,
      recency_at_ms INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      source TEXT NOT NULL,
      thread_source TEXT
    );
    INSERT INTO threads VALUES
      ('legacy-thread', 'First user message', 'Another first message', '${rollout}',
       2000, 2000000, 2000000, 0, 'vscode', 'user');
  `]);

  const [thread] = await new LocalCodexStateProvider(home).listRecentThreads();
  assert.equal(thread?.title, "Untitled");
});

test("only vscode/user threads are assigned and a deep task_started remains blue", async () => {
  const { home, codex } = makeHome();
  const userRollout = path.join(codex, "user.jsonl");
  const internalRollout = path.join(codex, "guardian.jsonl");
  const manyEvents = Array.from({ length: 4_000 }, () => record("agent_reasoning")).join("");
  writeFileSync(userRollout, record("task_started") + manyEvents);
  writeFileSync(internalRollout, record("task_started"));
  createStateDb(path.join(codex, "state_5.sqlite"), userRollout, internalRollout);

  const provider = new LocalCodexStateProvider(home);
  const first = await provider.listRecentThreads();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.id, "user-thread");
  assert.equal(first[0]?.title, "Named user task");
  assert.equal(first[0]?.phase, "working");

  appendFileSync(userRollout, record("task_complete", "2026-07-21T12:01:00.000Z"));
  const second = await provider.listRecentThreads();
  assert.equal(second[0]?.phase, "idle");
  assert.equal(second[0]?.completedAt, Date.parse("2026-07-21T12:01:00.000Z"));
});

test("codex-dev inbox timestamps are normalized and exposed as stronger unread evidence", async () => {
  const { home, codex } = makeHome();
  const userRollout = path.join(codex, "user.jsonl");
  const internalRollout = path.join(codex, "guardian.jsonl");
  writeFileSync(userRollout, record("task_complete"));
  writeFileSync(internalRollout, record("task_complete"));
  createStateDb(path.join(codex, "state_5.sqlite"), userRollout, internalRollout);
  execFileSync("/usr/bin/sqlite3", [path.join(codex, "sqlite", "codex-dev.db"), `
    CREATE TABLE inbox_items (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      read_at INTEGER,
      created_at INTEGER
    );
    INSERT INTO inbox_items VALUES ('notice', 'user-thread', NULL, 1784630000);
  `]);

  const [thread] = await new LocalCodexStateProvider(home).listRecentThreads();
  assert.equal(thread?.sourceUnread, true);
  assert.equal(thread?.sourceUnreadAt, 1_784_630_000_000);
});

test("a partial final JSONL record is retried after its newline arrives", async () => {
  const { home, codex } = makeHome();
  const userRollout = path.join(codex, "partial.jsonl");
  const internalRollout = path.join(codex, "internal.jsonl");
  writeFileSync(userRollout, record("task_started").trimEnd());
  writeFileSync(internalRollout, record("task_complete"));
  createStateDb(path.join(codex, "state_5.sqlite"), userRollout, internalRollout);

  const provider = new LocalCodexStateProvider(home);
  assert.equal((await provider.listRecentThreads())[0]?.phase, "idle");
  appendFileSync(userRollout, "\n");
  assert.equal((await provider.listRecentThreads())[0]?.phase, "working");
});

test("a transient missing rollout keeps its last verified status", async () => {
  const { home, codex } = makeHome();
  const userRollout = path.join(codex, "moving.jsonl");
  const internalRollout = path.join(codex, "internal.jsonl");
  writeFileSync(userRollout, record("task_started"));
  writeFileSync(internalRollout, record("task_complete"));
  createStateDb(path.join(codex, "state_5.sqlite"), userRollout, internalRollout);

  const provider = new LocalCodexStateProvider(home);
  assert.equal((await provider.listRecentThreads())[0]?.phase, "working");
  renameSync(userRollout, `${userRollout}.temporarily-moved`);
  assert.equal((await provider.listRecentThreads())[0]?.phase, "working");
});

test("a transient state database query failure keeps the last verified assignments", async () => {
  const { home, codex } = makeHome();
  const userRollout = path.join(codex, "user.jsonl");
  const internalRollout = path.join(codex, "internal.jsonl");
  const stateDb = path.join(codex, "state_5.sqlite");
  writeFileSync(userRollout, record("task_started"));
  writeFileSync(internalRollout, record("task_complete"));
  createStateDb(stateDb, userRollout, internalRollout);

  const provider = new LocalCodexStateProvider(home);
  assert.equal((await provider.listRecentThreads())[0]?.id, "user-thread");
  renameSync(stateDb, `${stateDb}.temporarily-moved`);
  mkdirSync(stateDb);
  assert.equal((await provider.listRecentThreads())[0]?.id, "user-thread");
});

test("oversized irrelevant rollout records cannot prevent later status updates", async () => {
  const { home, codex } = makeHome();
  const userRollout = path.join(codex, "large.jsonl");
  const internalRollout = path.join(codex, "internal.jsonl");
  const oversized = `${JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "large", output: "x".repeat(2_100_000) }
  })}\n`;
  writeFileSync(userRollout, record("task_started") + oversized + record("task_complete"));
  writeFileSync(internalRollout, record("task_complete"));
  createStateDb(path.join(codex, "state_5.sqlite"), userRollout, internalRollout);

  const [thread] = await new LocalCodexStateProvider(home).listRecentThreads();
  assert.equal(thread?.phase, "idle");
  assert.equal(thread?.completedAt, Date.parse("2026-07-21T12:00:00.000Z"));
});
