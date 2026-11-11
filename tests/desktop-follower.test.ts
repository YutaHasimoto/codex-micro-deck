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
import type { CodexThreadSettingsPatch } from "../src/codex/desktop-ipc-client.ts";

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
      assert.equal(message.version, 2);
      updates.push(params(message) ?? {});
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: message.method,
        result: { applied: true }
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

const VERIFIED_PATCH: CodexThreadSettingsPatch = {
  model: "gpt-6.1-sol",
  effort: "high",
  serviceTier: null,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  permissions: ":workspace"
};

test("verified settings use the exact discovered owner and a fresh snapshot even at an unchanged revision", async () => {
  const harness = createVerifiedHarness();
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => followingCount(harness.sent, CONV) === 1);
    assert.equal(await follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH), true);
    const requests = harness.sent.filter((message) => message.type === "request" && message.method !== "initialize");
    assert.deepEqual(requests.map((message) => [message.method, message.version]), [
      ["thread-owner-discovery", 1],
      ["thread-follower-update-thread-settings", 2],
      ["thread-follower-read-model-settings", 1]
    ]);
    assert.ok(requests.every((message) => params(message)?.conversationId === CONV));
    assert.ok(requests.slice(1).every((message) => message.targetClientId === "desktop-owner"));
    assert.equal(followingCount(harness.sent, CONV), 2);
    assert.equal(JSON.stringify(harness.sent).includes("PRIVATE_TRANSCRIPT"), false);
  } finally { follower.stop(); }
});

test("an exact target outside the visible followed set can be verified without selecting another task", async () => {
  const harness = createVerifiedHarness({
    snapshotRequests: [{ id: "extra-task-approval", method: "item/commandExecution/requestApproval", params: {} }]
  });
  const follower = harness.follower();
  try {
    follower.start();
    await until(() => follower.isConnected);
    assert.deepEqual(follower.desktopFollowedIds, []);
    assert.equal(await follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH), true);
    assert.equal(follower.pendingApprovals().has(CONV), false);
    assert.ok(harness.sent.filter((message) => message.type === "request" && message.method !== "initialize")
      .every((message) => params(message)?.conversationId === CONV));
    assert.equal(harness.sent.filter((message) => message.method === "thread-stream-following-changed")
      .at(-1)?.params && params(harness.sent.filter((message) => message.method === "thread-stream-following-changed").at(-1)!)?.following, false);
  } finally { follower.stop(); }
});

test("only no-client-found during discovery permits a no-owner result", async () => {
  const disconnected = new CodexDesktopFollower();
  assert.equal(await disconnected.updateThreadSettingsVerified(CONV, VERIFIED_PATCH), false);
  for (const code of ["no-client-found", "request-timeout", "client-disconnected", "request-version-mismatch"]) {
    const harness = createVerifiedHarness({ discoveryError: code });
    const follower = harness.follower();
    try {
      follower.start();
      await until(() => follower.isConnected);
      if (code === "no-client-found") {
        assert.equal(await follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH), false);
      } else {
        await assert.rejects(() => follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH), /request failed/);
      }
      assert.equal(harness.sent.some((message) => message.method === "thread-follower-update-thread-settings"), false);
    } finally { follower.stop(); }
  }
});

test("false, legacy, and uncertain owner acknowledgements never become a no-owner fallback", async () => {
  for (const options of [
    { applied: false }, { legacyAck: true }, { updateError: "no-client-found" },
    { updateError: "request-timeout" }, { updateError: "client-disconnected" },
    { replyOwner: "different-owner" }
  ]) {
    const harness = createVerifiedHarness(options);
    const follower = harness.follower();
    try {
      follower.start();
      await until(() => follower.isConnected);
      await assert.rejects(() => follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH));
    } finally { follower.stop(); }
  }
});

test("cached matching settings cannot replace a post-acknowledgement owner snapshot", async () => {
  const harness = createVerifiedHarness({ freshSnapshot: false });
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => followingCount(harness.sent, CONV) === 1);
    await assert.rejects(() => follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH), /snapshot timed out/);
  } finally { follower.stop(); }
});

test("owner readback, snapshot source, and every requested setting must agree", async () => {
  for (const options of [
    { readModel: "gpt-6.1-terra" },
    { snapshotOwner: "different-owner" },
    { snapshotSettings: { approvalsReviewer: "guardian_subagent" } },
    { snapshotSettings: { serviceTier: "priority" } },
    { snapshotSettings: { serviceTier: undefined } },
    { snapshotSettings: { activePermissionProfile: undefined } },
    { snapshotSettings: { activePermissionProfile: { id: ":danger-full-access" } } }
  ]) {
    const harness = createVerifiedHarness(options);
    const follower = harness.follower();
    try {
      follower.start();
      await until(() => follower.isConnected);
      await assert.rejects(() => follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH), /verification|owner/);
    } finally { follower.stop(); }
  }
});

test("Custom owner verification retains the raw sandbox and rejects a stale named profile", async () => {
  const customPatch: CodexThreadSettingsPatch = {
    ...VERIFIED_PATCH,
    permissions: undefined,
    sandboxPolicy: { type: "readOnly", networkAccess: false }
  };
  delete customPatch.permissions;
  for (const staleProfile of [false, true]) {
    const harness = createVerifiedHarness({
      snapshotSettings: {
        activePermissionProfile: staleProfile ? { id: ":workspace" } : null,
        sandboxPolicy: customPatch.sandboxPolicy
      }
    });
    const follower = harness.follower();
    try {
      follower.start();
      await until(() => follower.isConnected);
      if (staleProfile) await assert.rejects(() => follower.updateThreadSettingsVerified(CONV, customPatch), /sandboxPolicy/);
      else assert.equal(await follower.updateThreadSettingsVerified(CONV, customPatch), true);
    } finally { follower.stop(); }
  }
});

test("removing a tracked target rejects its pending verification", async () => {
  const harness = createVerifiedHarness({ freshSnapshot: false });
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => followingCount(harness.sent, CONV) === 1);
    const update = follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH);
    const rejected = assert.rejects(update, /removed/);
    await until(() => followingCount(harness.sent, CONV) === 2);
    follower.setDesiredConversations([]);
    await rejected;
  } finally { follower.stop(); }
});

test("disconnecting rejects a pending owner verification", async () => {
  const harness = createVerifiedHarness({ freshSnapshot: false });
  const follower = harness.follower();
  follower.setDesiredConversations([CONV]);
  follower.start();
  await until(() => followingCount(harness.sent, CONV) === 1);
  const update = follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH);
  const rejected = assert.rejects(update, /connection closed/);
  await until(() => followingCount(harness.sent, CONV) === 2);
  follower.stop();
  await rejected;
});

test("a settings patch invalidates the projection and requests a full owner snapshot", async () => {
  const harness = createVerifiedHarness({ patchBeforeSnapshot: true });
  const follower = harness.follower();
  try {
    follower.setDesiredConversations([CONV]);
    follower.start();
    await until(() => followingCount(harness.sent, CONV) === 1);
    assert.equal(await follower.updateThreadSettingsVerified(CONV, VERIFIED_PATCH), true);
    assert.equal(followingCount(harness.sent, CONV), 3);
  } finally { follower.stop(); }
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

function createVerifiedHarness(options: {
  discoveryError?: string;
  updateError?: string;
  applied?: boolean;
  legacyAck?: boolean;
  replyOwner?: string;
  readModel?: string;
  snapshotOwner?: string;
  snapshotSettings?: Record<string, unknown>;
  freshSnapshot?: boolean;
  patchBeforeSnapshot?: boolean;
  snapshotRequests?: unknown[];
} = {}) {
  let patch: CodexThreadSettingsPatch = VERIFIED_PATCH;
  let readComplete = false;
  let patchSent = false;
  return createHarness((message, send) => {
    const reply = (result: unknown) => send({
      type: "response", requestId: message.requestId, resultType: "success",
      method: message.method, handledByClientId: options.replyOwner ?? "desktop-owner", result
    });
    const fail = (error: string) => send({
      type: "response", requestId: message.requestId, resultType: "error", error
    });
    if (message.method === "thread-owner-discovery") {
      if (options.discoveryError) fail(options.discoveryError);
      else reply({});
    } else if (message.method === "thread-follower-update-thread-settings") {
      patch = params(message)?.threadSettings as CodexThreadSettingsPatch;
      if (options.updateError) fail(options.updateError);
      else reply(options.legacyAck ? { ok: true } : { applied: options.applied ?? true });
    } else if (message.method === "thread-follower-read-model-settings") {
      readComplete = true;
      reply({ settings: {
        model: options.readModel ?? patch.model,
        reasoningEffort: patch.effort,
        resumeState: "resumed"
      } });
    } else if (message.method === "thread-stream-following-changed"
      && params(message)?.following === true
      && (!readComplete || options.freshSnapshot !== false)) {
      if (readComplete && options.patchBeforeSnapshot && !patchSent) {
        patchSent = true;
        send(stateChanged(CONV, {
          type: "patches", baseRevision: 7, revision: 8,
          patches: [{ op: "replace", path: ["latestThreadSettings", "effort"], value: patch.effort }]
        }));
        return;
      }
      send({ ...stateChanged(CONV, {
        type: "snapshot", revision: patchSent ? 8 : 7,
        conversationState: {
          requests: options.snapshotRequests ?? [], turns: [{ text: "PRIVATE_TRANSCRIPT" }],
          latestModel: patch.model,
          latestReasoningEffort: patch.effort,
          latestThreadSettings: {
            ...patch,
            serviceTier: patch.serviceTier === null ? "default" : patch.serviceTier,
            activePermissionProfile: patch.permissions ? { id: patch.permissions, extends: null } : null,
            ...options.snapshotSettings
          }
        }
      }), sourceClientId: options.snapshotOwner ?? "desktop-owner" });
    }
  });
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
