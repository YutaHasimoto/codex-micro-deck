import assert from "node:assert/strict";
import test from "node:test";

import { RolloutStatusAccumulator } from "../src/core/status.ts";
import { UnreadTracker } from "../src/core/unread.ts";

const event = (type: string, extra: Record<string, unknown> = {}) => ({
  timestamp: "2026-07-21T12:00:00.000Z",
  type: "event_msg",
  payload: { type, ...extra }
});

test("a task_started anywhere in the full history remains working", () => {
  const status = new RolloutStatusAccumulator();
  status.ingest(event("task_started"));
  for (let index = 0; index < 2_000; index += 1) {
    status.ingest(event("agent_reasoning"));
  }
  assert.deepEqual(status.snapshot(), { phase: "working" });
});

test("a user interruption terminates blue state without becoming a red error", () => {
  const status = new RolloutStatusAccumulator();
  status.ingest(event("task_started"));
  status.ingest(event("turn_aborted", { reason: "interrupted" }));
  assert.deepEqual(status.snapshot(), { phase: "idle" });
});

test("a non-user abort is a terminal red error", () => {
  const status = new RolloutStatusAccumulator();
  status.ingest(event("task_started"));
  status.ingest(event("turn_aborted", { reason: "stream_lost" }));
  assert.deepEqual(status.snapshot(), { phase: "error" });
});

test("rollout tool calls never infer an approval phase, even with approval-ish text", () => {
  // Codex Desktop does not persist approval requests to rollout files; the
  // amber state comes from the live IPC follower. A grep/exec whose command
  // text merely mentions approval keywords must therefore stay blue.
  const status = new RolloutStatusAccumulator();
  status.ingest(event("task_started"));
  status.ingest({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "attention-1",
      input: "grep -r 'approval_required|request_user_input' src/"
    }
  });
  assert.deepEqual(status.snapshot(), { phase: "working" });
});

test("inbox timestamps strengthen unread and do not re-light after markSeen", () => {
  const tracker = new UnreadTracker({
    thread: { seenUpdatedAt: 1_000, unread: false }
  });
  const input = {
    id: "thread",
    updatedAt: 1_500,
    phase: "idle" as const,
    sourceUnread: true,
    sourceUnreadAt: 2_000
  };
  assert.deepEqual(tracker.reconcile(input), { unread: true, changed: true });
  assert.equal(tracker.markSeen("thread", input.updatedAt), true);
  assert.deepEqual(tracker.reconcile(input), { unread: false, changed: false });
  assert.deepEqual(
    tracker.reconcile({ ...input, sourceUnreadAt: 2_001 }),
    { unread: true, changed: true }
  );
});
