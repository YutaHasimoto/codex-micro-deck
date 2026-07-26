import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";

import {
  assertThreadSettings,
  CodexDesktopIpcClient,
  type CodexDesktopIpcClientOptions,
  encodeIpcFrame,
  IpcFrameDecoder,
  threadSettingsMatchResume,
  threadSettingsForControl,
  threadSettingsForSnapshot
} from "../src/codex/desktop-ipc-client.ts";

type Message = Record<string, unknown>;

test("IPC framing decodes fragmented and coalesced little-endian JSON messages", () => {
  const first = { type: "first", value: 1 };
  const second = { type: "second", value: 2 };
  const firstFrame = encodeIpcFrame(first);
  const secondFrame = encodeIpcFrame(second);
  assert.equal(firstFrame.readUInt32LE(0), firstFrame.length - 4);

  const decoder = new IpcFrameDecoder();
  assert.deepEqual(decoder.push(firstFrame.subarray(0, 2)), []);
  assert.deepEqual(
    decoder.push(Buffer.concat([firstFrame.subarray(2), secondFrame])),
    [first, second]
  );
});

test("IPC framing rejects empty, oversized, and invalid JSON frames", () => {
  const empty = Buffer.alloc(4);
  assert.throws(() => new IpcFrameDecoder(1024).push(empty), /empty/);

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(1025, 0);
  assert.throws(() => new IpcFrameDecoder(1024).push(oversized), /too large/);

  const invalidHeader = Buffer.alloc(4);
  const invalidPayload = Buffer.from("not-json");
  invalidHeader.writeUInt32LE(invalidPayload.length, 0);
  assert.throws(
    () => new IpcFrameDecoder(1024).push(Buffer.concat([invalidHeader, invalidPayload])),
    /invalid JSON/
  );
});

test("all four dials map to the current Desktop thread settings schema", () => {
  assert.deepEqual(threadSettingsForControl("model", "gpt-5.6-terra", "medium"), {
    model: "gpt-5.6-terra", effort: "medium"
  });
  assert.deepEqual(threadSettingsForControl("reasoning", "ultra"), { effort: "ultra" });
  assert.throws(() => threadSettingsForControl("reasoning", "max"), /Unsupported Codex reasoning/);
  assert.deepEqual(threadSettingsForControl("speed", "standard"), { serviceTier: null });
  assert.deepEqual(threadSettingsForControl("speed", "fast"), { serviceTier: "priority" });
  assert.deepEqual(threadSettingsForControl("approval", "ask"), {
    approvalPolicy: "on-request", approvalsReviewer: "user", permissions: ":workspace"
  });
  assert.deepEqual(threadSettingsForControl("approval", "delegate"), {
    approvalPolicy: "on-request", approvalsReviewer: "guardian_subagent", permissions: ":workspace"
  });
  assert.deepEqual(threadSettingsForControl("approval", "full"), {
    approvalPolicy: "never", approvalsReviewer: "user", permissions: ":danger-full-access"
  });
  assert.deepEqual(threadSettingsForControl("approval", "custom", undefined, {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" }
  }), {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" }
  });
});

test("a task patch cannot mix a named permission profile and a raw sandbox", () => {
  assert.throws(() => assertThreadSettings({
    permissions: ":workspace",
    sandboxPolicy: { type: "dangerFullAccess" }
  }), /cannot be combined/);
});

test("a persisted snapshot becomes one complete authoritative task patch", () => {
  assert.deepEqual(threadSettingsForSnapshot({
    model: "gpt-5.6-terra",
    reasoning: "ultra",
    speed: "fast",
    approval: "ask"
  }, "delegate"), {
    model: "gpt-5.6-terra",
    effort: "ultra",
    serviceTier: "priority",
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian_subagent",
    permissions: ":workspace"
  });
  assert.deepEqual(threadSettingsForSnapshot({
    model: "gpt-5.6-sol",
    reasoning: "low",
    speed: "standard",
    approval: "ask",
    customAccess: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" }
    }
  }, "custom"), {
    model: "gpt-5.6-sol",
    effort: "low",
    serviceTier: null,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" }
  });
  // Legacy mappings remain parseable for customized older profiles.
  assert.deepEqual(threadSettingsForSnapshot({
    model: "gpt-5.6-terra",
    reasoning: "ultra",
    speed: "fast",
    approval: "auto"
  }), {
    model: "gpt-5.6-terra",
    effort: "ultra",
    serviceTier: "priority",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review"
  });
  // Legacy Never remains parseable/mappable for backwards compatibility.
  assert.deepEqual(threadSettingsForSnapshot({
    model: "gpt-5.6-sol",
    reasoning: "low",
    speed: "standard",
    approval: "never"
  }).approvalPolicy, "never");
});

test("App Server read-back accepts either delegate reviewer and verifies profile provenance", () => {
  const expected = threadSettingsForSnapshot({
    model: "gpt-5.6-sol",
    reasoning: "high",
    speed: "fast",
    approval: "ask"
  }, "delegate");
  const actual = {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    serviceTier: "priority",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    activePermissionProfile: { id: ":workspace" }
  };
  assert.equal(threadSettingsMatchResume(actual, expected), true);
  assert.equal(threadSettingsMatchResume({
    ...actual,
    approvalsReviewer: "user"
  }, expected), false);
  assert.equal(threadSettingsMatchResume({
    ...actual,
    approvalPolicy: "never"
  }, expected), false);
});

test("App Server default service tier is equivalent only to the requested Standard speed", () => {
  assert.equal(threadSettingsMatchResume(
    { serviceTier: "default" },
    { serviceTier: null }
  ), true);
  assert.equal(threadSettingsMatchResume(
    { serviceTier: null },
    { serviceTier: null }
  ), true);
  assert.equal(threadSettingsMatchResume(
    { serviceTier: "default" },
    { serviceTier: "priority" }
  ), false);
  assert.equal(threadSettingsMatchResume(
    { serviceTier: null },
    { serviceTier: "priority" }
  ), false);
});

test("Custom Access read-back requires the raw sandbox and no stale permission profile", () => {
  const expected = threadSettingsForSnapshot({
    model: "gpt-5.6-sol",
    reasoning: "high",
    speed: "standard",
    approval: "ask",
    customAccess: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" }
    }
  }, "custom");
  const actual = {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    serviceTier: null,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: null
  };
  assert.equal(threadSettingsMatchResume(actual, expected), true);
  assert.equal(threadSettingsMatchResume({
    ...actual,
    activePermissionProfile: { id: ":workspace" }
  }, expected), false);
});

test("ephemeral client initializes, prefers active following, and declines discovery", async () => {
  const fallbackId = "f".repeat(16);
  const activeId = "a".repeat(16);
  let initialize: Message | undefined;
  let update: Message | undefined;
  let discoveryResponse: Message | undefined;

  const router = await startRouter((socket, send) => {
    // This deliberately arrives before the client can send initialize.
    send(followingChanged(activeId, true));
    return (message) => {
      if (message.method === "initialize") {
        initialize = message;
        send(success(message, { clientId: "deck-client" }));
      } else if (message.method === "thread-follower-update-thread-settings") {
        update = message;
        send({ type: "client-discovery-request", requestId: "discover-1" });
      } else if (message.type === "client-discovery-response") {
        discoveryResponse = message;
        if (update) send(success(update, { ok: true }));
      }
    };
  });

  try {
    const result = await router.client()
      .updateThreadSettings(fallbackId, { effort: "high" });
    assert.deepEqual(result, { applied: true, conversationId: activeId });
    assert.equal(initialize?.version, 0);
    assert.equal(initialize?.sourceClientId, "initializing-client");
    assert.deepEqual(initialize?.params, { clientType: "codex-micro-deck" });
    assert.equal(update?.version, 1);
    assert.equal(update?.timeoutMs, 2_500);
    assert.equal(update?.sourceClientId, "deck-client");
    assert.equal("targetClientId" in (update ?? {}), false);
    assert.deepEqual(update?.params, {
      conversationId: activeId,
      threadSettings: { effort: "high" }
    });
    assert.deepEqual(discoveryResponse, {
      type: "client-discovery-response",
      requestId: "discover-1",
      response: { canHandle: false }
    });
  } finally {
    await router.close();
  }
});

test("a following notification after initialize still outranks the selected fallback", async () => {
  const fallbackId = "b".repeat(16);
  const activeId = "c".repeat(16);
  let appliedId: unknown;
  const router = await startRouter((_socket, send) => (message) => {
    if (message.method === "initialize") {
      send(success(message, { clientId: "deck-client" }));
      setTimeout(() => send(followingChanged(activeId, true)), 5);
    } else if (message.method === "thread-follower-update-thread-settings") {
      appliedId = (message.params as Message | undefined)?.conversationId;
      send(success(message, { ok: true }));
    }
  });
  try {
    const result = await router.client()
      .updateThreadSettings(fallbackId, { model: "gpt-5.6-sol" });
    assert.deepEqual(result, { applied: true, conversationId: activeId });
    assert.equal(appliedId, activeId);
  } finally {
    await router.close();
  }
});

test("selected fallback is used only when Desktop reports no active following task", async () => {
  const fallbackId = "d".repeat(16);
  let appliedId: unknown;
  const router = await startRouter((_socket, send) => (message) => {
    if (message.method === "initialize") send(success(message, { clientId: "deck-client" }));
    else if (message.method === "thread-follower-update-thread-settings") {
      appliedId = (message.params as Message | undefined)?.conversationId;
      send(success(message, { ok: true }));
    }
  });
  try {
    const result = await router.client()
      .updateThreadSettings(fallbackId, { serviceTier: "priority" });
    assert.deepEqual(result, { applied: true, conversationId: fallbackId });
    assert.equal(appliedId, fallbackId);
  } finally {
    await router.close();
  }
});

test("an explicitly selected Agent safely overrides multiple active following tasks", async () => {
  let updateCalls = 0;
  let appliedId: unknown;
  const router = await startRouter((_socket, send) => {
    send(followingChanged("1".repeat(16), true));
    send(followingChanged("2".repeat(16), true));
    return (message) => {
      if (message.method === "initialize") send(success(message, { clientId: "deck-client" }));
      else if (message.method === "thread-follower-update-thread-settings") {
        updateCalls += 1;
        appliedId = (message.params as Message | undefined)?.conversationId;
        send(success(message, { ok: true }));
      }
    };
  });
  try {
    const result = await router.client()
      .updateThreadSettings("f".repeat(16), { effort: "low" });
    assert.deepEqual(result, { applied: true, conversationId: "f".repeat(16) });
    assert.equal(updateCalls, 1);
    assert.equal(appliedId, "f".repeat(16));
  } finally {
    await router.close();
  }
});

test("multiple active following tasks without a selected Agent remain ambiguous", async () => {
  let updateCalls = 0;
  const router = await startRouter((_socket, send) => {
    send(followingChanged("1".repeat(16), true));
    send(followingChanged("2".repeat(16), true));
    return (message) => {
      if (message.method === "initialize") send(success(message, { clientId: "deck-client" }));
      else if (message.method === "thread-follower-update-thread-settings") updateCalls += 1;
    };
  });
  try {
    const result = await router.client().updateThreadSettings(undefined, { effort: "low" });
    assert.deepEqual(result, { applied: false, reason: "ambiguous" });
    assert.equal(updateCalls, 0);
  } finally {
    await router.close();
  }
});

test("missing target returns default-only without sending an update", async () => {
  let updateCalls = 0;
  const router = await startRouter((_socket, send) => (message) => {
    if (message.method === "initialize") send(success(message, { clientId: "deck-client" }));
    else if (message.method === "thread-follower-update-thread-settings") updateCalls += 1;
  });
  try {
    const result = await router.client()
      .updateThreadSettings(undefined, { effort: "medium" });
    assert.deepEqual(result, { applied: false, reason: "no-target" });
    assert.equal(updateCalls, 0);
  } finally {
    await router.close();
  }
});

test("request timeout is bounded without connecting to the real Codex socket", async () => {
  const router = await startRouter(() => () => undefined);
  try {
    await assert.rejects(
      () => router.client({ timeoutMs: 100 })
        .updateThreadSettings("e".repeat(16), { effort: "medium" }),
      /timed out/
    );
  } finally {
    await router.close();
  }
});

test("a success response for the wrong method is rejected", async () => {
  const router = await startRouter((_socket, send) => (message) => {
    if (message.method === "initialize") send(success(message, { clientId: "deck-client" }));
    else if (message.method === "thread-follower-update-thread-settings") {
      send({
        ...success(message, { ok: true }),
        method: "some-other-method"
      });
    }
  });
  try {
    await assert.rejects(
      () => router.client().updateThreadSettings("e".repeat(16), { effort: "medium" }),
      /mismatched response method/
    );
  } finally {
    await router.close();
  }
});

test("an error response without a method reports the rejected operation", async () => {
  const router = await startRouter((_socket, send) => (message) => {
    if (message.method === "initialize") send(success(message, { clientId: "deck-client" }));
    else if (message.method === "thread-follower-update-thread-settings") {
      send({
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: { message: "no owner" }
      });
    }
  });
  try {
    await assert.rejects(
      () => router.client().updateThreadSettings("e".repeat(16), { effort: "medium" }),
      /rejected the thread settings update/
    );
  } finally {
    await router.close();
  }
});

test("runtime validation rejects invalid approval enums before connecting", async () => {
  const client = new CodexDesktopIpcClient({
    socketConnector: () => { throw new Error("must not connect"); },
    async socketVerifier() { throw new Error("must not verify"); }
  });
  await assert.rejects(
    () => client.updateThreadSettings("e".repeat(16), {
      approvalPolicy: "always" as never
    }),
    /approval policy selection is invalid/
  );
  await assert.rejects(
    () => client.updateThreadSettings("e".repeat(16), {
      approvalsReviewer: "robot" as never
    }),
    /approval reviewer selection is invalid/
  );
});

test("unsafe IPC directories and symbolic-link sockets are rejected before connect", async () => {
  const unsafeRoot = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-ipc-unsafe-"));
  const unsafeIpc = path.join(unsafeRoot, "ipc");
  await mkdir(unsafeIpc, { mode: 0o755 });
  await writeFile(path.join(unsafeIpc, "ipc.sock"), "not a socket");
  await assert.rejects(
    () => new CodexDesktopIpcClient({ codexRoot: unsafeRoot })
      .updateThreadSettings("e".repeat(16), { effort: "medium" }),
    /directory is not owner-only/
  );

  const linkRoot = await mkdtemp(path.join(tmpdir(), "codex-micro-deck-ipc-link-"));
  const linkIpc = path.join(linkRoot, "ipc");
  await mkdir(linkIpc, { mode: 0o700 });
  const target = path.join(linkIpc, "target");
  await writeFile(target, "not a socket");
  await symlink(target, path.join(linkIpc, "ipc.sock"));
  await assert.rejects(
    () => new CodexDesktopIpcClient({ codexRoot: linkRoot })
      .updateThreadSettings("e".repeat(16), { effort: "medium" }),
    /not a real socket/
  );
});

type Router = {
  client(options?: CodexDesktopIpcClientOptions): CodexDesktopIpcClient;
  close(): Promise<void>;
};

type ConnectionHandler = (
  socket: Socket,
  send: (message: Message) => void
) => (message: Message) => void;

async function startRouter(onConnection: ConnectionHandler): Promise<Router> {
  const [clientSocket, routerSocket] = memorySocketPair();
  const decoder = new IpcFrameDecoder();
  const send = (message: Message) => routerSocket.write(encodeIpcFrame(message));
  const receive = onConnection(routerSocket as unknown as Socket, send);
  routerSocket.on("data", (chunk: Buffer) => {
    for (const value of decoder.push(chunk)) {
      if (value && typeof value === "object" && !Array.isArray(value)) receive(value as Message);
    }
  });
  return {
    client(options = {}) {
      return new CodexDesktopIpcClient({
        ...options,
        socketConnector: () => {
          queueMicrotask(() => clientSocket.emit("connect"));
          return clientSocket as unknown as Socket;
        },
        async socketVerifier() {}
      });
    },
    async close() {
      clientSocket.destroy();
      routerSocket.destroy();
    }
  };
}

function followingChanged(conversationId: string, following: boolean): Message {
  return {
    type: "broadcast",
    version: 1,
    method: "thread-stream-following-changed",
    params: { conversationId, hostId: "local", following }
  };
}

function success(request: Message, result: Message): Message {
  return {
    type: "response",
    requestId: request.requestId,
    resultType: "success",
    method: request.method,
    handledByClientId: "desktop-client",
    result
  };
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
