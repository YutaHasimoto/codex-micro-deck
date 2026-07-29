import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import test from "node:test";

import {
  applyRequestsPatches,
  CodexDesktopFollower,
  parseRequests
} from "../src/codex/desktop-follower.ts";
import { encodeIpcFrame, IpcFrameDecoder } from "../src/codex/desktop-ipc-client.ts";

type Message = Record<string, unknown>;

const CONV = "a".repeat(16);
const OTHER_CONV = "b".repeat(16);

test("follower registers desired conversations and parses snapshot requests", async () => {
  const harness = createHarness();
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => harness.sent.some((message) =>
      message.method === "thread-stream-following-changed"
      && params(message)?.following === true
      && params(message)?.conversationId === CONV));

    harness.send(stateChanged(CONV, {
      type: "snapshot",
      revision: 3,
      conversationState: {
        requests: [
          { id: "req-tool", method: "item/tool/call", params: {} },
          { id: 26, method: "item/commandExecution/requestApproval", params: {} }
        ]
      }
    }));
    await until(() => follower.pendingApprovals().get(CONV)?.length === 1);
    assert.deepEqual(follower.pendingApprovals().get(CONV), [{
      requestId: 26,
      kind: "command",
      method: "item/commandExecution/requestApproval"
    }]);
  } finally {
    follower.stop();
  }
});

test("patch indices refer to the full requests array including non-approvals", async () => {
  const harness = createHarness();
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => harness.sent.some((message) => message.method === "thread-stream-following-changed"));
    harness.send(stateChanged(CONV, {
      type: "snapshot",
      revision: 1,
      conversationState: {
        requests: [
          { id: "req-tool", method: "item/tool/call", params: {} },
          { id: "req-cmd", method: "item/commandExecution/requestApproval", params: {} }
        ]
      }
    }));
    await until(() => follower.pendingApprovals().has(CONV));

    // Removing index 0 (the tool call) must keep the approval pending.
    harness.send(stateChanged(CONV, {
      type: "patches",
      baseRevision: 1,
      revision: 2,
      patches: [{ op: "remove", path: ["requests", 0] }]
    }));
    await delay(20);
    assert.equal(follower.pendingApprovals().get(CONV)?.length, 1);

    // Removing the remaining approval clears the amber state.
    harness.send(stateChanged(CONV, {
      type: "patches",
      baseRevision: 2,
      revision: 3,
      patches: [{ op: "remove", path: ["requests", 0] }]
    }));
    await until(() => !follower.pendingApprovals().has(CONV));

    // A pushed file-change approval turns it back on.
    harness.send(stateChanged(CONV, {
      type: "patches",
      baseRevision: 3,
      revision: 4,
      patches: [{
        op: "add",
        path: ["requests", 0],
        value: { id: "req-file", method: "item/fileChange/requestApproval", params: {} }
      }]
    }));
    await until(() => follower.pendingApprovals().get(CONV)?.[0]?.kind === "file");
  } finally {
    follower.stop();
  }
});

test("a revision gap re-affirms the follow to force a fresh snapshot", async () => {
  const harness = createHarness();
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => followingCount(harness.sent, CONV) === 1);
    harness.send(stateChanged(CONV, {
      type: "snapshot",
      revision: 1,
      conversationState: { requests: [] }
    }));
    harness.send(stateChanged(CONV, {
      type: "patches",
      baseRevision: 41,
      revision: 42,
      patches: [{ op: "add", path: ["requests", 0], value: { id: "x", method: "item/commandExecution/requestApproval" } }]
    }));
    // Recovery re-sends following:true, which makes the owner push a snapshot.
    await until(() => followingCount(harness.sent, CONV) === 2);
    // The out-of-order patch must not be applied blindly.
    assert.equal(follower.pendingApprovals().has(CONV), false);
  } finally {
    follower.stop();
  }
});

test("a decided request keeps patch indices aligned for the remaining approvals", async () => {
  const harness = createHarness((message, send) => {
    if (message.type === "request" && message.method === "thread-follower-command-approval-decision") {
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: message.method,
        result: { ok: true }
      });
    }
  });
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => followingCount(harness.sent, CONV) === 1);
    harness.send(stateChanged(CONV, {
      type: "snapshot",
      revision: 1,
      conversationState: {
        requests: [
          { id: 26, method: "item/commandExecution/requestApproval", params: {} },
          { id: "req-file", method: "item/fileChange/requestApproval", params: {} }
        ]
      }
    }));
    await until(() => follower.pendingApprovals().get(CONV)?.length === 2);

    const command = follower.pendingApprovals().get(CONV)?.[0];
    assert.ok(command);
    await follower.decideApproval(CONV, command, "accept");
    assert.deepEqual(
      follower.pendingApprovals().get(CONV)?.map((request) => request.requestId),
      ["req-file"]
    );

    // The owner confirms by removing the decided request at ITS index (0).
    // The raw mirror must still match, so the file approval survives.
    harness.send(stateChanged(CONV, {
      type: "patches",
      baseRevision: 1,
      revision: 2,
      patches: [{ op: "remove", path: ["requests", 0] }]
    }));
    await delay(20);
    assert.deepEqual(
      follower.pendingApprovals().get(CONV)?.map((request) => request.requestId),
      ["req-file"]
    );
  } finally {
    follower.stop();
  }
});

test("decideApproval sends the command decision and clears the request optimistically", async () => {
  const decisions: Message[] = [];
  const harness = createHarness((message, send) => {
    if (message.type === "request" && message.method === "thread-follower-command-approval-decision") {
      decisions.push(params(message) ?? {});
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: message.method,
        result: { ok: true }
      });
    }
  });
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => harness.sent.some((message) => message.method === "thread-stream-following-changed"));
    harness.send(stateChanged(CONV, {
      type: "snapshot",
      revision: 1,
      conversationState: {
        requests: [{ id: 26, method: "item/commandExecution/requestApproval", params: {} }]
      }
    }));
    await until(() => follower.pendingApprovals().has(CONV));
    const approval = follower.pendingApprovals().get(CONV)?.[0];
    assert.ok(approval);
    await follower.decideApproval(CONV, approval, "accept");
    assert.deepEqual(decisions, [{ conversationId: CONV, requestId: 26, decision: "accept" }]);
    assert.equal(follower.pendingApprovals().has(CONV), false);
  } finally {
    follower.stop();
  }
});

test("decideApproval preserves a numeric request id for a file decline", async () => {
  const decisions: Message[] = [];
  const harness = createHarness((message, send) => {
    if (message.type === "request" && message.method === "thread-follower-file-approval-decision") {
      decisions.push(params(message) ?? {});
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: message.method,
        result: { ok: true }
      });
    }
  });
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => harness.sent.some((message) => message.method === "thread-stream-following-changed"));
    harness.send(stateChanged(CONV, {
      type: "snapshot",
      revision: 1,
      conversationState: {
        requests: [{ id: 71, method: "item/fileChange/requestApproval", params: {} }]
      }
    }));
    await until(() => follower.pendingApprovals().has(CONV));
    const approval = follower.pendingApprovals().get(CONV)?.[0];
    assert.ok(approval);
    await follower.decideApproval(CONV, approval, "decline");
    assert.deepEqual(decisions, [{ conversationId: CONV, requestId: 71, decision: "decline" }]);
    assert.equal(follower.pendingApprovals().has(CONV), false);
  } finally {
    follower.stop();
  }
});

test("question-style requests are pending but cannot be decided", async () => {
  const harness = createHarness();
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => harness.sent.some((message) => message.method === "thread-stream-following-changed"));
    harness.send(stateChanged(CONV, {
      type: "snapshot",
      revision: 1,
      conversationState: {
        requests: [{ id: "req-q", method: "item/tool/requestUserInput", params: {} }]
      }
    }));
    await until(() => follower.pendingApprovals().has(CONV));
    const approval = follower.pendingApprovals().get(CONV)?.[0];
    assert.ok(approval);
    assert.equal(approval.kind, "other");
    await assert.rejects(
      () => follower.decideApproval(CONV, approval, "decline"),
      /needs an answer inside the Codex app/
    );
  } finally {
    follower.stop();
  }
});

test("updateThreadSettings travels over the persistent connection", async () => {
  const updates: Message[] = [];
  const harness = createHarness((message, send) => {
    if (message.type === "request" && message.method === "thread-follower-update-thread-settings") {
      updates.push(params(message) ?? {});
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: message.method,
        result: { ok: true }
      });
    }
  });
  const follower = harness.follower();
  try {
    follower.start();
    await until(() => follower.isConnected);
    await follower.updateThreadSettings(CONV, { effort: "high" });
    assert.deepEqual(updates, [{ conversationId: CONV, threadSettings: { effort: "high" } }]);
  } finally {
    follower.stop();
  }
});

test("a following-status request re-affirms desired conversations", async () => {
  const harness = createHarness();
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => followingCount(harness.sent, CONV) === 1);
    harness.send({
      type: "broadcast",
      method: "thread-stream-following-status-requested",
      version: 1,
      sourceClientId: "desktop-owner",
      params: { conversationId: CONV, hostId: "local" }
    });
    await until(() => followingCount(harness.sent, CONV) === 2);
  } finally {
    follower.stop();
  }
});

test("desktop-followed conversations are tracked and pending state clears on stop", async () => {
  const harness = createHarness();
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => follower.isConnected);
    harness.send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: "desktop-client",
      params: { conversationId: OTHER_CONV, hostId: "local", following: true }
    });
    await until(() => follower.desktopFollowedIds.includes(OTHER_CONV));
    harness.send(stateChanged(CONV, {
      type: "snapshot",
      revision: 1,
      conversationState: {
        requests: [{ id: "req-cmd", method: "item/commandExecution/requestApproval", params: {} }]
      }
    }));
    await until(() => follower.pendingApprovals().has(CONV));
  } finally {
    follower.stop();
  }
  assert.equal(follower.isConnected, false);
  assert.equal(follower.pendingApprovals().size, 0);
  assert.deepEqual(follower.desktopFollowedIds, []);
});

test("parseRequests and applyRequestsPatches handle deep and length patches", () => {
  const raw = [
    { id: "req-cmd", method: "item/commandExecution/requestApproval", params: { reason: "x" } }
  ];
  // Deep mutation inside a request stays supported via generic application.
  const deep = applyRequestsPatches(raw, [
    { op: "replace", path: ["requests", 0, "params", "reason"], value: "y" }
  ]);
  assert.equal(deep.supported, true);
  assert.deepEqual(parseRequests(deep.next), [{
    requestId: "req-cmd",
    kind: "command",
    method: "item/commandExecution/requestApproval"
  }]);

  const truncated = applyRequestsPatches(raw, [
    { op: "replace", path: ["requests", "length"], value: 0 }
  ]);
  assert.equal(truncated.supported, true);
  assert.deepEqual(parseRequests(truncated.next), []);

  const unrelated = applyRequestsPatches(raw, [
    { op: "replace", path: ["turns", 3], value: {} }
  ]);
  assert.equal(unrelated.touched, false);
  assert.equal(unrelated.supported, true);

  assert.deepEqual(parseRequests([
    { id: 71, method: "item/fileChange/requestApproval" }
  ]), [{
    requestId: 71,
    kind: "file",
    method: "item/fileChange/requestApproval"
  }]);
  assert.deepEqual(parseRequests([
    { id: "", method: "item/commandExecution/requestApproval" },
    { id: 1.5, method: "item/commandExecution/requestApproval" },
    { id: Number.MAX_SAFE_INTEGER + 1, method: "item/commandExecution/requestApproval" }
  ]), []);
});

function params(message: Message): Record<string, unknown> | undefined {
  const value = message.params;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function followingCount(messages: readonly Message[], conversationId: string): number {
  return messages.filter((message) =>
    message.method === "thread-stream-following-changed"
    && params(message)?.conversationId === conversationId
    && params(message)?.following === true).length;
}

function stateChanged(conversationId: string, change: Record<string, unknown>): Message {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId: "desktop-owner",
    params: { conversationId, hostId: "local", change }
  };
}

function createHarness(
  handle?: (message: Message, send: (reply: Message) => void) => void
) {
  const sent: Message[] = [];
  let connections = 0;
  let activeSend: ((message: Message) => void) | undefined;
  const connector = (): Socket => {
    connections += 1;
    const [clientSocket, routerSocket] = memorySocketPair();
    const decoder = new IpcFrameDecoder(64 * 1024 * 1024);
    const routerSend = (message: Message) => routerSocket.write(encodeIpcFrame(message));
    activeSend = routerSend;
    routerSocket.on("data", (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const message = value as Message;
        sent.push(message);
        if (message.type === "request" && message.method === "initialize") {
          routerSend({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "initialize",
            result: { clientId: `follower-${connections}` }
          });
          continue;
        }
        handle?.(message, routerSend);
      }
    });
    queueMicrotask(() => clientSocket.emit("connect"));
    return clientSocket as unknown as Socket;
  };
  return {
    sent,
    send(message: Message): void { activeSend?.(message); },
    follower(): CodexDesktopFollower {
      return new CodexDesktopFollower({
        socketConnector: connector,
        async socketVerifier() {},
        reconnectDelaysMs: [25],
        requestTimeoutMs: 400
      });
    }
  };
}

async function until(check: () => boolean, timeoutMs = 1_500): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition was not reached in time");
    await delay(5);
  }
}

class MemorySocket extends Duplex {
  peer: MemorySocket | undefined;

  override _read(): void {}

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (!this.peer || this.peer.destroyed) {
      callback(new Error("Memory IPC peer is closed"));
      return;
    }
    this.peer.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
    callback();
  }
}

function memorySocketPair(): [MemorySocket, MemorySocket] {
  const left = new MemorySocket();
  const right = new MemorySocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}
