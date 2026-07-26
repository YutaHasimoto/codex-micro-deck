import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  CodexDeckCoordinator,
  CONTROL_SUCCESS_FEEDBACK_MS,
  CONTROL_WARNING_FEEDBACK_MS,
  encoderRole,
  keyRole
} from "../src/coordinator.ts";
import type { CodexControlSnapshot, ConfigControlRole } from "../src/codex/config-controller.ts";
import type { ApprovalDecision, PendingApproval } from "../src/codex/desktop-follower.ts";
import type { CodexThreadSettingsPatch } from "../src/codex/desktop-ipc-client.ts";
import type {
  DictationDisposition,
  PaletteCommand,
  StableCommand
} from "../src/codex/stable-controller.ts";
import { triggerDescriptionForRole } from "../src/core/encoder-triggers.ts";
import { renderEncoderFeedback } from "../src/render/encoder-feedback.ts";
import { renderKeyImage } from "../src/render/key-image.ts";
import type { GlobalSettings, ThreadSnapshot } from "../src/types.ts";

test("default Stream Deck + coordinates cover all eight keys and four encoders", () => {
  const keys = [
    keyRole({}, { column: 0, row: 0 }), keyRole({}, { column: 1, row: 0 }),
    keyRole({}, { column: 2, row: 0 }), keyRole({}, { column: 3, row: 0 }),
    keyRole({}, { column: 0, row: 1 }), keyRole({}, { column: 1, row: 1 }),
    keyRole({}, { column: 2, row: 1 }), keyRole({}, { column: 3, row: 1 })
  ];
  assert.deepEqual(keys, [
    "agent-1", "agent-2", "agent-3", "agent-4",
    "agent-5", "agent-6", "approve", "decline"
  ]);
  assert.deepEqual([0, 1, 2, 3].map((column) => encoderRole({}, { column, row: 0 })), [
    "model", "reasoning", "speed", "approval"
  ]);
});

test("agent presentations use official status colors and selected pulse", async () => {
  const threads: ThreadSnapshot[] = [
    snapshot("1", "Working", "working"),
    { ...snapshot("2", "Unread", "idle"), sourceUnread: true, sourceUnreadAt: 200 },
    snapshot("3", "Approval", "approval"),
    snapshot("4", "Error", "error"),
    snapshot("5", "Idle", "idle")
  ];
  const { coordinator } = fixture(threads);
  await coordinator.poll();

  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).color, "blue");
  assert.equal(coordinator.keyPresentation({}, { column: 1, row: 0 }).color, "green");
  assert.equal(coordinator.keyPresentation({}, { column: 2, row: 0 }).color, "amber");
  assert.equal(coordinator.keyPresentation({}, { column: 3, row: 0 }).color, "red");
  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 1 }).color, "white");

  await coordinator.pressKey({}, { column: 0, row: 0 });
  const selected = coordinator.keyPresentation({}, { column: 0, row: 0 });
  assert.equal(selected.selected, true);
  assert.equal(selected.pulse, true);
});

test("agent presentations retain a long Unicode-safe task title for the key marquee", async () => {
  const title = `${"長いタスク名".repeat(30)}🐈`;
  const { coordinator } = fixture([snapshot("1", title, "idle")]);
  await coordinator.poll();

  const presentation = coordinator.keyPresentation({}, { column: 0, row: 0 });
  assert.equal(Array.from(presentation.secondary).length, Array.from(title).length);
  assert.equal(presentation.secondary.endsWith("🐈"), true);
});

test("agent presentations prefer the exact App Server task name over SQLite preview text", async () => {
  const names = fakeThreadNames([
    { ...snapshot("1", "Human task name", "idle") },
    { ...snapshot("not-tracked", "Should not be assigned", "idle") }
  ]);
  const { coordinator } = fixture([
    snapshot("1", "The first user message", "idle"),
    snapshot("2", "Another first message", "idle")
  ], { threadNames: names });

  await coordinator.poll();

  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).secondary, "Human task name");
  assert.equal(coordinator.keyPresentation({}, { column: 1, row: 0 }).secondary, "Another first message");
  assert.deepEqual(names.events, [
    "start:/Applications/ChatGPT.app/Contents/Resources/codex:true",
    "poll",
  ]);
});

test("a failed App Server name poll leaves the safe local task label intact", async () => {
  const names = fakeThreadNames([], true);
  const { coordinator } = fixture([
    snapshot("1", "Untitled", "idle")
  ], { threadNames: names });

  await coordinator.poll();

  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).secondary, "Untitled");
});

test("all four encoder surfaces route rotate, press, tap, hold, down, and up", async () => {
  const { coordinator, configCalls } = fixture([snapshot("3", "Approval", "approval")]);
  await coordinator.poll();

  for (const column of [0, 1, 2, 3]) {
    const coordinates = { column, row: 0 };
    await coordinator.rotateEncoder({}, coordinates, 1);
    await coordinator.pressEncoder({}, coordinates);
    await coordinator.touchEncoder({}, coordinates, false);
    await coordinator.touchEncoder({}, coordinates, true);
    await coordinator.dialDown({}, coordinates, `dial-${column}`);
    await coordinator.dialUp({}, coordinates, `dial-${column}`);
    await coordinator.dialDown({}, coordinates, `dial-${column}`);
    await coordinator.dialUp({}, coordinates, `dial-${column}`);
  }

  assert.deepEqual(configCalls, [
    "apply:model:gpt-5.6-terra", "read", "reset:model",
    "apply:reasoning:medium", "read", "reset:reasoning",
    "apply:speed:fast", "read", "reset:speed",
    "apply:approval:ask", "read", "reset:approval"
  ]);
});

test("applying model preserves pending reasoning and sends the complete saved snapshot", async () => {
  const thread = snapshot("1", "Task", "idle");
  const { coordinator, configCalls, follower } = fixture([thread]);
  const model = { column: 0, row: 0 };
  const reasoning = { column: 1, row: 0 };
  await coordinator.poll();

  await coordinator.rotateEncoder({}, model, 1);
  await coordinator.rotateEncoder({}, reasoning, 1);
  assert.equal(coordinator.encoderPresentation({}, model).value, "5.6 Terra");
  assert.equal(coordinator.encoderPresentation({}, reasoning).value, "Medium");
  assert.equal(coordinator.encoderPresentation({}, model).color, "amber");
  assert.equal(coordinator.encoderPresentation({}, reasoning).color, "amber");

  await coordinator.pressEncoder({}, model);
  assert.deepEqual(follower.liveUpdates[0]?.threadSettings, {
    model: "gpt-5.6-terra",
    effort: "low",
    serviceTier: null,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user"
  });
  assert.equal(coordinator.encoderPresentation({}, reasoning).value, "Medium");
  assert.equal(coordinator.encoderPresentation({}, reasoning).color, "amber");
  await coordinator.pressEncoder({}, reasoning);

  assert.deepEqual(configCalls, [
    "apply:model:gpt-5.6-terra",
    "apply:reasoning:medium"
  ]);
});

test("concurrent control applies keep each complete six-task batch in invocation order", async () => {
  const configCalls: string[] = [];
  const liveStarts: CodexThreadSettingsPatch[] = [];
  const liveCompletions: CodexThreadSettingsPatch[] = [];
  let announceModelStarted: (() => void) | undefined;
  const modelStarted = new Promise<void>((resolve) => { announceModelStarted = resolve; });
  let releaseModel: (() => void) | undefined;
  const modelPending = new Promise<void>((resolve) => { releaseModel = resolve; });
  const thread = snapshot("1", "Task", "idle");
  const follower = fakeFollower();
  const appServer = fakeAppServer();
  follower.stub.isConnected = true;
  follower.stub.updateThreadSettings = async (_conversationId, threadSettings) => {
    liveStarts.push(structuredClone(threadSettings));
    if (liveStarts.length === 1) {
      announceModelStarted?.();
      await modelPending;
    }
    liveCompletions.push(structuredClone(threadSettings));
  };
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController,
    config: fakeConfig(configCalls),
    follower: follower.stub,
    appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  const model = { column: 0, row: 0 };
  const reasoning = { column: 1, row: 0 };
  await coordinator.rotateEncoder({}, model, 1);
  await coordinator.rotateEncoder({}, reasoning, 1);

  const modelApply = coordinator.pressEncoder({}, model);
  const reasoningApply = coordinator.pressEncoder({}, reasoning);
  await modelStarted;
  assert.deepEqual(liveStarts, [{
    model: "gpt-5.6-terra",
    effort: "low",
    serviceTier: null,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user"
  }]);
  assert.deepEqual(configCalls, ["apply:model:gpt-5.6-terra"]);

  releaseModel?.();
  await Promise.all([modelApply, reasoningApply]);
  assert.deepEqual(configCalls, [
    "apply:model:gpt-5.6-terra",
    "apply:reasoning:medium"
  ]);
  assert.deepEqual(liveStarts, [
    {
      model: "gpt-5.6-terra", effort: "low", serviceTier: null,
      approvalPolicy: "untrusted", approvalsReviewer: "user"
    },
    {
      model: "gpt-5.6-terra", effort: "medium", serviceTier: null,
      approvalPolicy: "untrusted", approvalsReviewer: "user"
    }
  ]);
  assert.deepEqual(liveCompletions, liveStarts);
});

test("a same-dial rotation waits for an in-flight apply before staging the newer value", async () => {
  const configCalls: string[] = [];
  const livePatches: CodexThreadSettingsPatch[] = [];
  let announceStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const thread = snapshot("1", "Task", "idle");
  const follower = fakeFollower();
  const appServer = fakeAppServer();
  follower.stub.isConnected = true;
  follower.stub.updateThreadSettings = async (_conversationId, patch) => {
    livePatches.push(structuredClone(patch));
    if (livePatches.length === 1) {
      announceStarted?.();
      await firstPending;
    }
  };
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController,
    config: fakeConfig(configCalls),
    follower: follower.stub,
    appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  const model = { column: 0, row: 0 };
  await coordinator.rotateEncoder({}, model, 1);
  const firstApply = coordinator.pressEncoder({}, model);
  await started;

  let laterRotationSettled = false;
  const laterRotation = coordinator.rotateEncoder({}, model, 1).then(() => {
    laterRotationSettled = true;
  });
  await Promise.resolve();
  assert.equal(laterRotationSettled, false);

  releaseFirst?.();
  await firstApply;
  await laterRotation;
  assert.equal(coordinator.encoderPresentation({}, model).value, "5.6 Sol");
  assert.equal(coordinator.encoderPresentation({}, model).color, "amber");
  await coordinator.pressEncoder({}, model);
  assert.deepEqual(livePatches, [
    {
      model: "gpt-5.6-terra", effort: "low", serviceTier: null,
      approvalPolicy: "untrusted", approvalsReviewer: "user"
    },
    {
      model: "gpt-5.6-sol", effort: "low", serviceTier: null,
      approvalPolicy: "untrusted", approvalsReviewer: "user"
    }
  ]);
  assert.deepEqual(configCalls, [
    "apply:model:gpt-5.6-terra",
    "apply:model:gpt-5.6-sol"
  ]);
});

test("a failed live apply does not poison the control apply queue", async () => {
  const configCalls: string[] = [];
  let liveCalls = 0;
  const thread = snapshot("1", "Task", "idle");
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.stub.updateThreadSettings = async () => {
    liveCalls += 1;
    if (liveCalls === 1) throw new Error("first live apply failed");
  };
  const appServer = fakeAppServer({
    failRequest: (_method, _params, index) => index === 0
  });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController,
    config: fakeConfig(configCalls),
    follower: follower.stub,
    appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  const model = { column: 0, row: 0 };
  const reasoning = { column: 1, row: 0 };
  await coordinator.rotateEncoder({}, model, 1);
  await coordinator.rotateEncoder({}, reasoning, 1);
  const [first, second] = await Promise.allSettled([
    coordinator.pressEncoder({}, model),
    coordinator.pressEncoder({}, reasoning)
  ]);
  assert.equal(first.status, "rejected");
  assert.equal(second.status, "fulfilled");
  assert.equal(liveCalls, 2);
  assert.deepEqual(configCalls, [
    "apply:model:gpt-5.6-terra",
    "apply:reasoning:medium"
  ]);
});

test("default-only dial apply is explicit when no current task is available", async () => {
  const { coordinator } = fixture([]);
  const model = { column: 0, row: 0 };
  const approval = { column: 3, row: 0 };

  assert.equal(CONTROL_SUCCESS_FEEDBACK_MS, 1_500);
  await coordinator.rotateEncoder({}, model, 1);
  const selectedModel = coordinator.encoderPresentation({}, model).value;
  await coordinator.pressEncoder({}, model);
  assert.notEqual(selectedModel, "✓ Default");
  assert.equal(coordinator.encoderPresentation({}, model).value, "✓ Default");
  assert.equal(coordinator.encoderPresentation({}, model).color, "blue");
  assert.equal(coordinator.encoderPresentation({}, model).hint, "New task default only");
  await delay(CONTROL_SUCCESS_FEEDBACK_MS + 50);
  assert.equal(coordinator.encoderPresentation({}, model).value, selectedModel);

  await coordinator.rotateEncoder({}, model, -1);
  assert.equal(coordinator.encoderPresentation({}, model).color, "amber");
  assert.equal(coordinator.encoderPresentation({}, model).hint, "auto apply · next turn");

  await coordinator.rotateEncoder({}, approval, 1);
  await coordinator.pressEncoder({}, approval);
  assert.equal(coordinator.encoderPresentation({}, approval).color, "white");
  assert.equal(coordinator.encoderPresentation({}, approval).value, "✓ Default");
  assert.equal(coordinator.encoderPresentation({}, approval).hint, "New task default only");
  coordinator.stop();
});

test("dial apply targets the currently open Desktop chat without an Agent key", async () => {
  const thread = snapshot("1", "Open", "idle");
  const { coordinator, follower, appServer } = fixture([thread]);
  follower.followOnly([thread.id]);
  await coordinator.poll();

  await coordinator.rotateEncoder({}, { column: 1, row: 0 }, 1);
  await coordinator.pressEncoder({}, { column: 1, row: 0 });

  assert.deepEqual(follower.liveUpdates.at(-1), {
    conversationId: thread.id,
    threadSettings: {
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: null,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user"
    }
  });
  assert.deepEqual(
    appServer.requests
      .filter((request) => request.method === "thread/settings/update")
      .map((request) => (request.params as { threadId?: string }).threadId),
    [thread.id],
    "expected exactly one thread/settings/update request for the tracked open Desktop chat"
  );
  assert.equal(coordinator.encoderPresentation({}, { column: 1, row: 0 }).value, "Medium");
});

test("dial apply includes an open Desktop completed task alongside six tracked Agent tasks", async () => {
  const tracked = ["1", "2", "3", "4", "5", "6"].map(
    (id) => snapshot(id, `Tracked ${id}`, "idle")
  );
  const openCompleted = snapshot("7", "Open completed task", "idle");
  const { coordinator, follower, appServer } = fixture(tracked);
  follower.followOnly([openCompleted.id]);
  await coordinator.poll();

  await coordinator.rotateEncoder({}, { column: 1, row: 0 }, 1);
  await coordinator.pressEncoder({}, { column: 1, row: 0 });

  assert.deepEqual(
    appServer.requests
      .filter((request) => request.method === "thread/settings/update")
      .map((request) => (request.params as { threadId?: string }).threadId),
    [...tracked.map((thread) => thread.id), openCompleted.id]
  );
  assert.deepEqual(
    follower.liveUpdates.map((update) => update.conversationId),
    [openCompleted.id]
  );
});

test("legacy Never is readable, preserved by unrelated controls, and never cycles", async () => {
  const calls: string[] = [];
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: fixture([]).codexController,
    config: fakeConfig(calls, undefined, "never"),
    follower: fakeFollower().stub
  });
  const approval = { column: 3, row: 0 };
  await coordinator.reloadConfigControls();
  assert.equal(coordinator.encoderPresentation({}, approval).value, "Never");

  const cycled = new Set<string>();
  for (let index = 0; index < 6; index += 1) {
    await coordinator.rotateEncoder({}, approval, 1);
    cycled.add(coordinator.encoderPresentation({}, approval).value);
  }
  assert.equal(cycled.has("Never"), false);
  assert.deepEqual([...cycled].sort(), ["Ask", "Custom", "Delegate", "Full"]);

  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  await coordinator.pressEncoder({}, { column: 0, row: 0 });
  assert.deepEqual(calls, [
    "read",
    "apply:model:gpt-5.6-terra"
  ]);
});

test("legacy Never cannot be applied until an Access candidate is selected", async () => {
  const calls: string[] = [];
  const thread = snapshot("1", "Task", "idle");
  const follower = fakeFollower();
  const appServer = fakeAppServer();
  follower.stub.isConnected = true;
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController,
    config: fakeConfig(calls, undefined, "never"),
    follower: follower.stub,
    appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  const approval = { column: 3, row: 0 };
  await coordinator.poll();
  await coordinator.reloadConfigControls();

  await assert.rejects(
    () => coordinator.pressEncoder({}, approval),
    /Legacy Access value is read-only.*Ask, Delegate, Full, or Custom/
  );
  assert.deepEqual(calls, ["read"]);
  assert.deepEqual([...follower.liveUpdates], []);

  await coordinator.rotateEncoder({}, approval, 1);
  assert.equal(coordinator.encoderPresentation({}, approval).value, "Ask");
  const outcome = await coordinator.pressEncoder({}, approval);
  assert.equal(outcome, "applied");
  assert.deepEqual(calls, ["read", "apply:approval:ask"]);
  assert.equal(follower.liveUpdates.length, 1);
  assert.equal(follower.liveUpdates[0]?.threadSettings.approvalPolicy, "on-request");
});

test("unpersisted Access infers exact config presets and keeps mixed config Custom", async () => {
  const workspaceDefault = {
    type: "workspaceWrite" as const,
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  const cases = [
    ["mixed", {
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "user" as const,
      sandboxPolicy: { type: "dangerFullAccess" as const }
    }, "Custom"],
    ["ask", {
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "user" as const,
      sandboxPolicy: workspaceDefault
    }, "Ask"],
    ["delegate guardian", {
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "guardian_subagent" as const,
      sandboxPolicy: workspaceDefault
    }, "Delegate"],
    ["delegate auto", {
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "auto_review" as const,
      sandboxPolicy: workspaceDefault
    }, "Delegate"],
    ["full", {
      approvalPolicy: "never" as const,
      approvalsReviewer: "user" as const,
      sandboxPolicy: { type: "dangerFullAccess" as const }
    }, "Full"]
  ] satisfies ReadonlyArray<[string, NonNullable<CodexControlSnapshot["customAccess"]>, string]>;

  for (const [_name, customAccess, expected] of cases) {
    const coordinator = new CodexDeckCoordinator({
      provider: { async listRecentThreads() { return []; } },
      codex: fixture([]).codexController,
      config: fakeConfig([], undefined, "ask", customAccess),
      follower: fakeFollower().stub
    });
    await coordinator.reloadConfigControls();
    assert.equal(coordinator.encoderPresentation({}, { column: 3, row: 0 }).value, expected);
  }
});

test("unpersisted Access is inferred again when an unrelated setting merges a config snapshot", async () => {
  const workspaceDefault = {
    type: "workspaceWrite" as const,
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: fixture([]).codexController,
    config: fakeConfig([], undefined, "ask", {
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandboxPolicy: workspaceDefault
    }),
    follower: fakeFollower().stub
  });

  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  await coordinator.pressEncoder({}, { column: 0, row: 0 });
  assert.equal(coordinator.encoderPresentation({}, { column: 3, row: 0 }).value, "Delegate");
});

test("tracked Agent keeps the selected value visible after a successful sync", async () => {
  const thread = snapshot("1", "Selected", "idle");
  const { coordinator, follower } = fixture([thread]);
  await coordinator.poll();
  await coordinator.pressKey({}, { column: 0, row: 0 });
  await coordinator.rotateEncoder({}, { column: 1, row: 0 }, 1);
  await coordinator.pressEncoder({}, { column: 1, row: 0 });

  assert.deepEqual(follower.liveUpdates.at(-1), {
    conversationId: thread.id,
    threadSettings: {
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: null,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user"
    }
  });
  assert.equal(coordinator.encoderPresentation({}, { column: 1, row: 0 }).value, "Medium");
  assert.equal(coordinator.encoderPresentation({}, { column: 1, row: 0 }).hint, "rotate choose · tap reload");
});

test("Access sync returns to the normal steady-state Deck label", async () => {
  const thread = snapshot("1", "Selected", "idle");
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController,
    config: fakeConfig([], undefined, "ask"),
    follower: fakeFollower().stub,
    appServer: fakeAppServer().stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  const approval = { column: 3, row: 0 };
  await coordinator.rotateEncoder({}, approval, 1);
  await coordinator.pressEncoder({}, approval);

  const presentation = coordinator.encoderPresentation({}, approval);
  assert.equal(presentation.value, "Delegate");
  assert.equal(presentation.hint, "rotate choose · tap reload");
});

test("Full Access needs two presses, and rotate or hold clears the confirmation arm", async () => {
  const thread = snapshot("1", "Selected", "idle");
  const { coordinator, configCalls, appServer, follower } = fixture([thread]);
  const persisted: GlobalSettings[] = [];
  coordinator.configure({}, async (settings) => { persisted.push(settings); });
  await coordinator.poll();
  const access = { column: 3, row: 0 };

  await coordinator.rotateEncoder({}, access, -1); // Custom -> Full
  assert.equal(coordinator.encoderPresentation({}, access).value, "Full");
  assert.equal(await coordinator.pressEncoder({}, access), "confirmation");
  assert.equal(configCalls.length, 0);
  assert.equal(appServer.requests.length, 0);
  assert.equal(coordinator.encoderPresentation({}, access).value, "Full · again");

  await coordinator.rotateEncoder({}, access, 1); // Full -> Custom; clears arm
  await coordinator.rotateEncoder({}, access, -1); // Custom -> Full
  assert.equal(await coordinator.pressEncoder({}, access), "confirmation");
  assert.equal(configCalls.length, 0);

  assert.equal(await coordinator.pressEncoder({}, access), "applied");
  assert.deepEqual(configCalls, ["apply:approval:full"]);
  assert.equal(follower.liveUpdates.at(-1)?.threadSettings.permissions, ":danger-full-access");
  assert.equal(persisted.at(-1)?.accessMode, "full");

  await coordinator.rotateEncoder({}, access, 1); // Full -> Custom
  await coordinator.rotateEncoder({}, access, -1); // Custom -> Full
  assert.equal(await coordinator.pressEncoder({}, access), "confirmation");
  await coordinator.touchEncoder({}, access, true); // reset to Ask clears arm
  await coordinator.rotateEncoder({}, access, 2); // Ask -> Full
  assert.equal(await coordinator.pressEncoder({}, access), "confirmation");
});

test("Full Access applies once from the settled rotation source without a physical confirmation", async () => {
  const thread = snapshot("1", "Selected", "idle");
  const { coordinator, configCalls, follower } = fixture([thread]);
  coordinator.configure({});
  await coordinator.poll();
  const access = { column: 3, row: 0 };

  await coordinator.rotateEncoder({}, access, -1); // Custom -> Full
  assert.equal(coordinator.encoderPresentation({}, access).hint, "auto in 80ms · next turn");
  assert.equal(await coordinator.pressEncoder({}, access, "auto"), "applied");
  assert.deepEqual(configCalls, ["apply:approval:full"]);
  assert.equal(follower.liveUpdates.length, 1);
  assert.equal(follower.liveUpdates[0]?.threadSettings.permissions, ":danger-full-access");
});

test("a legacy pressShortcut cannot hijack a focused dial trailing auto-apply", async () => {
  const thread = snapshot("1", "Selected", "idle");
  const { coordinator, calls, configCalls } = fixture([thread]);
  await coordinator.poll();
  const model = { column: 0, row: 0 };
  const settings = { role: "model" as const, pressShortcut: "cmd+shift+r" };

  await coordinator.rotateEncoder(settings, model, 1);
  assert.equal(await coordinator.pressEncoder(settings, model), undefined);
  assert.deepEqual(calls, ["shortcut:cmd+shift+r"]);
  assert.deepEqual(configCalls, []);

  assert.equal(await coordinator.pressEncoder(settings, model, "auto"), "applied");
  assert.deepEqual(calls, ["shortcut:cmd+shift+r"]);
  assert.deepEqual(configCalls, ["apply:model:gpt-5.6-terra"]);
});

test("persisted Custom Access survives Model changes and uses no named profile", async () => {
  const thread = snapshot("1", "Selected", "idle");
  const { coordinator, follower } = fixture([thread]);
  coordinator.configure({ accessMode: "custom" });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  await coordinator.pressEncoder({}, { column: 0, row: 0 });

  assert.equal(coordinator.globalSettings.accessMode, "custom");
  assert.equal(coordinator.encoderPresentation({}, { column: 3, row: 0 }).value, "Custom");
  assert.equal(follower.liveUpdates.at(-1)?.threadSettings.permissions, undefined);
  assert.deepEqual(follower.liveUpdates.at(-1)?.threadSettings.sandboxPolicy, {
    type: "readOnly", networkAccess: false
  });
});

test("a partial task sync reports the successful count and raises a physical alert", async () => {
  const calls: string[] = [];
  const threads = [
    snapshot("1", "One", "idle"),
    snapshot("2", "Two", "idle"),
    snapshot("3", "Three", "idle")
  ];
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.stub.updateThreadSettings = async (conversationId, patch) => {
    if (conversationId === threads[1]!.id) throw new Error("second task unavailable");
    follower.liveUpdates.push({ conversationId, threadSettings: structuredClone(patch) });
  };
  const appServer = fakeAppServer({
    failRequest: (_method, params) => (
      (params as { threadId?: string }).threadId === threads[1]!.id
    )
  });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return threads; } },
    codex: fixture([]).codexController,
    config: fakeConfig(calls),
    follower: follower.stub,
    appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  const reasoning = { column: 1, row: 0 };
  await coordinator.rotateEncoder({}, reasoning, 1);
  await assert.rejects(
    () => coordinator.pressEncoder({}, reasoning),
    /synced 2\/3.*Partial sync/i
  );
  assert.deepEqual(calls, ["apply:reasoning:medium"]);
  const presentation = coordinator.encoderPresentation({}, reasoning);
  assert.equal(presentation.value, "⚠ 2/3");
  assert.equal(presentation.hint, "Partial sync · retry");
  assert.equal(presentation.color, "amber");
  assert.equal(CONTROL_WARNING_FEEDBACK_MS, 4_000);
});

test("all task sync failures keep the saved default and reject for physical alert", async () => {
  const calls: string[] = [];
  const thread = snapshot("1", "Tracked", "idle");
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.stub.updateThreadSettings = async () => {
    throw new Error("Codex Desktop IPC is unavailable");
  };
  const appServer = fakeAppServer({ failRequests: true });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController,
    config: fakeConfig(calls),
    follower: follower.stub,
    appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  const model = { column: 0, row: 0 };
  await coordinator.rotateEncoder({}, model, 1);
  await assert.rejects(() => coordinator.pressEncoder({}, model), /failed for all 1 tracked tasks/);
  assert.deepEqual(calls, ["apply:model:gpt-5.6-terra"]);
  assert.equal(coordinator.encoderPresentation({}, model).value, "⚠ 0/1");
  assert.equal(coordinator.encoderPresentation({}, model).hint, "Live failed · default saved");
  assert.equal(coordinator.encoderPresentation({}, model).color, "amber");
  assert.equal(CONTROL_WARNING_FEEDBACK_MS, 4_000);
  assert.equal(appServer.events.at(-1), "stop");
});

test("a read-back reviewer mismatch retries once and never shows a false sync", async () => {
  const thread = snapshot("1", "Tracked", "idle");
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  const appServer = fakeAppServer({
    resumeResult(result) {
      return { ...result, approvalsReviewer: "user" };
    }
  });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController,
    config: fakeConfig([], undefined, "ask"),
    follower: follower.stub,
    appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  const approval = { column: 3, row: 0 };
  await coordinator.rotateEncoder({}, approval, 1);
  await assert.rejects(
    () => coordinator.pressEncoder({}, approval),
    /verification failed/
  );

  assert.deepEqual(
    appServer.requests.map((request) => request.method),
    [
      "thread/resume",
      "thread/settings/update",
      "thread/resume",
      "thread/settings/update",
      "thread/resume"
    ]
  );
  assert.equal(follower.liveUpdates.length, 1);
  assert.equal(coordinator.encoderPresentation({}, approval).value, "⚠ 0/1");
});

test("both transports failing with a disconnected follower reports zero synced tasks", async () => {
  const thread = snapshot("1", "Tracked", "idle");
  const failingAppServer = fakeAppServer({ failRequests: true });
  const { coordinator, follower, configCalls, appServer } = fixture(
    [thread],
    { appServer: failingAppServer }
  );
  follower.stub.isConnected = false;
  await coordinator.poll();
  const speed = { column: 2, row: 0 };
  await coordinator.rotateEncoder({}, speed, 1);
  await assert.rejects(
    () => coordinator.pressEncoder({}, speed),
    /failed for all 1 tracked tasks/
  );
  assert.deepEqual(configCalls, ["apply:speed:fast"]);
  assert.deepEqual(follower.liveUpdates, []);
  assert.equal(coordinator.encoderPresentation({}, speed).value, "⚠ 0/1");
  assert.equal(appServer.events.at(-1), "stop");
});

test("failed config apply leaves the selected candidate amber and unsaved", async () => {
  const calls: string[] = [];
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: fixture([]).codexController,
    config: fakeConfig(calls, "model")
  });
  const model = { column: 0, row: 0 };

  await coordinator.rotateEncoder({}, model, 1);
  await assert.rejects(() => coordinator.pressEncoder({}, model), /simulated model apply failure/);
  const presentation = coordinator.encoderPresentation({}, model);
  assert.equal(presentation.color, "amber");
  assert.equal(presentation.value, "5.6 Terra");
  assert.equal(presentation.hint, "auto apply · next turn");
  assert.deepEqual(calls, ["apply:model:gpt-5.6-terra"]);
});

test("approve routes the decision to the single amber task without a selection", async () => {
  const approval = snapshot("3", "Approval", "working");
  const { coordinator, follower } = fixture([approval]);
  follower.stub.isConnected = true;
  follower.setPending(approval.id, [commandRequest("req-1")]);
  await coordinator.poll();

  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).color, "amber");
  assert.equal(
    coordinator.keyPresentation({ role: "approve" }, { column: 2, row: 1 }).color,
    "amber"
  );
  assert.equal(
    coordinator.keyPresentation({ role: "decline" }, { column: 3, row: 1 }).color,
    "red"
  );
  await coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 });
  assert.deepEqual(follower.decisions, [`${approval.id}:req-1:accept`]);
  // The decided request is consumed and the suppression window blocks a fast double press.
  await assert.rejects(
    () => coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 }),
    /No Codex task is waiting/
  );
});

test("approve and decline keys stay off until a directly actionable request exists", async () => {
  const thread = snapshot("1", "Question", "working");
  const { coordinator, follower } = fixture([thread]);
  await coordinator.poll();
  const approve = { role: "approve" as const };
  const decline = { role: "decline" as const };
  assert.equal(coordinator.keyPresentation(approve, { column: 2, row: 1 }).color, "off");
  assert.equal(coordinator.keyPresentation(decline, { column: 3, row: 1 }).color, "off");

  follower.setPending(thread.id, [{
    requestId: "req-q",
    kind: "other",
    method: "item/tool/requestUserInput"
  }]);
  follower.notify();
  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).color, "amber");
  assert.equal(coordinator.keyPresentation(approve, { column: 2, row: 1 }).color, "off");
  assert.equal(coordinator.keyPresentation(decline, { column: 3, row: 1 }).color, "off");
});

test("multiple actionable tasks use the uniquely current Desktop task", async () => {
  const first = snapshot("1", "First", "working");
  const second = snapshot("2", "Second", "working");
  const { coordinator, follower } = fixture([first, second]);
  follower.followOnly([first.id]);
  follower.setPending(first.id, [commandRequest("req-1")]);
  follower.setPending(second.id, [commandRequest("req-2")]);
  await coordinator.poll();

  await coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 });
  assert.deepEqual(follower.decisions, [`${first.id}:req-1:accept`]);
});

test("an explicitly selected actionable Agent outranks a different current task", async () => {
  const current = snapshot("1", "Current", "working");
  const selected = snapshot("2", "Selected", "working");
  const { coordinator, follower } = fixture([current, selected]);
  follower.followOnly([current.id]);
  follower.setPending(current.id, [commandRequest("req-current")]);
  follower.setPending(selected.id, [commandRequest("req-selected")]);
  await coordinator.poll();
  await coordinator.pressKey({}, { column: 1, row: 0 });

  await coordinator.pressKey({ role: "decline" }, { column: 3, row: 1 });
  assert.deepEqual(follower.decisions, [`${selected.id}:req-selected:decline`]);
});

test("multiple amber tasks require the selected agent before deciding", async () => {
  const first = snapshot("1", "First", "working");
  const second = snapshot("2", "Second", "working");
  const { coordinator, follower } = fixture([first, second]);
  follower.stub.isConnected = true;
  follower.setPending(first.id, [commandRequest("req-1")]);
  follower.setPending(second.id, [commandRequest("req-2")]);
  await coordinator.poll();

  await assert.rejects(
    () => coordinator.pressKey({ role: "decline" }, { column: 3, row: 1 }),
    /Select the amber/
  );
  await coordinator.pressKey({}, { column: 1, row: 0 });
  await coordinator.pressKey({ role: "decline" }, { column: 3, row: 1 });
  assert.deepEqual(follower.decisions, [`${second.id}:req-2:decline`]);
});

test("approve and decline never fire without a pending approval or IPC connection", async () => {
  const { coordinator, follower } = fixture([snapshot("1", "Idle", "idle")]);
  follower.stub.isConnected = false;
  await coordinator.poll();
  await assert.rejects(
    () => coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 }),
    /not reachable/
  );
  follower.stub.isConnected = true;
  await assert.rejects(
    () => coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 }),
    /No Codex task is waiting/
  );
  await assert.rejects(
    () => coordinator.pressKey({ role: "decline" }, { column: 3, row: 1 }),
    /No Codex task is waiting/
  );
  assert.deepEqual(follower.decisions, []);
});

test("a question-style request is amber but cannot be decided from the deck", async () => {
  const question = snapshot("4", "Question", "working");
  const { coordinator, follower } = fixture([question]);
  follower.stub.isConnected = true;
  follower.setPending(question.id, [{
    requestId: "req-q",
    kind: "other",
    method: "item/tool/requestUserInput"
  }]);
  await coordinator.poll();
  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).color, "amber");
  assert.equal(
    coordinator.keyPresentation({ role: "approve" }, { column: 2, row: 1 }).color,
    "off"
  );
  await assert.rejects(
    () => coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 }),
    /No Codex task is waiting for approval/
  );
  assert.deepEqual(follower.decisions, []);
});

test("multiple actionable requests in one task are never guessed", async () => {
  const thread = snapshot("1", "Two approvals", "working");
  const { coordinator, follower } = fixture([thread]);
  follower.setPending(thread.id, [
    commandRequest("req-1"),
    { requestId: "req-2", kind: "file", method: "item/fileChange/requestApproval" }
  ]);
  await coordinator.poll();
  await assert.rejects(
    () => coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 }),
    /multiple approval requests.*inside Codex/
  );
  assert.deepEqual(follower.decisions, []);
});

test("a failed agent deep link never arms approval for the wrong Codex task", async () => {
  const first = snapshot("1", "First", "working");
  const second = snapshot("2", "Second", "working");
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.setPending(first.id, [commandRequest("req-1")]);
  follower.setPending(second.id, [commandRequest("req-2")]);
  const codex = {
    ...fixture([]).codexController,
    async openThread(): Promise<"background"> { throw new Error("open failed"); }
  };
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [first, second]; } },
    codex,
    follower: follower.stub
  });
  await coordinator.poll();
  await assert.rejects(() => coordinator.pressKey({}, { column: 0, row: 0 }), /open failed/);
  await assert.rejects(() => coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 }), /Select the amber/);
  assert.deepEqual(follower.decisions, []);
});

test("duplicate dial-down and stray dial-up events cannot invert voice state", async () => {
  const { coordinator, calls } = fixture([]);
  const coordinates = { column: 3, row: 0 };
  const settings = { role: "composer" as const };
  await coordinator.dialUp(settings, coordinates);
  await coordinator.dialDown(settings, coordinates);
  await coordinator.dialDown(settings, coordinates);
  await coordinator.dialUp(settings, coordinates);
  await coordinator.dialUp(settings, coordinates);
  assert.deepEqual(calls, ["dictation:start", "dictation:stop:insert"]);
});

test("focused dial down toggles Codex dictation once per physical press and up only releases the guard", async () => {
  const { coordinator, calls } = fixture([]);
  const coordinates = { column: 0, row: 0 };

  assert.equal(await coordinator.dialDown({}, coordinates, "model-dial"), "started");
  assert.equal(coordinator.voiceActive, true);
  assert.equal(await coordinator.dialDown({}, coordinates, "model-dial"), "ignored");
  await coordinator.dialUp({}, coordinates, "model-dial");
  assert.equal(coordinator.voiceActive, true);
  assert.deepEqual(calls, ["dictation:start"]);

  for (const column of [0, 1, 2, 3]) {
    const presentation = coordinator.encoderPresentation({}, { column, row: 0 });
    assert.equal(presentation.mode, "voice");
    assert.equal(presentation.slice, column);
    assert.equal(presentation.value, "Listening…");
  }

  const otherDial = { column: 2, row: 0 };
  assert.equal(await coordinator.dialDown({}, otherDial, "speed-dial"), "sent");
  await coordinator.dialUp({}, otherDial, "speed-dial");
  assert.equal(coordinator.voiceActive, false);
  assert.equal(coordinator.encoderPresentation({}, coordinates).mode, undefined);
  assert.deepEqual(calls, ["dictation:start", "dictation:stop:send"]);
});

test("a second dial press during AX start queues send instead of racing the state", async () => {
  const base = fixture([]).codexController;
  const calls: string[] = [];
  let announceStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let releaseStart: (() => void) | undefined;
  const startPending = new Promise<void>((resolve) => { releaseStart = resolve; });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: {
      ...base,
      async startDictation(): Promise<void> {
        calls.push("start");
        announceStarted?.();
        await startPending;
      },
      async stopDictation(disposition: DictationDisposition): Promise<void> {
        calls.push(`stop:${disposition}`);
      }
    }
  });

  const first = coordinator.dialDown({}, { column: 0, row: 0 }, "model-dial");
  await started;
  const second = coordinator.dialDown({}, { column: 2, row: 0 }, "speed-dial");
  await Promise.resolve();
  assert.deepEqual(calls, ["start"]);

  releaseStart?.();
  assert.deepEqual(await Promise.all([first, second]), ["started", "sent"]);
  assert.deepEqual(calls, ["start", "stop:send"]);
  assert.equal(coordinator.voiceActive, false);
});

test("a failed Transcribe and send AX press keeps voice active and the waveform visible", async () => {
  const base = fixture([]).codexController;
  const calls: string[] = [];
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: {
      ...base,
      async startDictation(): Promise<void> { calls.push("start"); },
      async stopDictation(disposition: DictationDisposition): Promise<void> {
        calls.push(`stop:${disposition}`);
        throw new Error("send button unavailable");
      }
    }
  });
  const coordinates = { column: 1, row: 0 };

  await coordinator.dialDown({}, coordinates, "reasoning-dial");
  await coordinator.dialUp({}, coordinates, "reasoning-dial");
  await assert.rejects(
    () => coordinator.dialDown({}, coordinates, "reasoning-dial"),
    /send button unavailable/
  );

  assert.equal(coordinator.voiceActive, true);
  assert.equal(coordinator.encoderPresentation({}, coordinates).mode, "voice");
  assert.deepEqual(calls, ["start", "stop:send"]);
  await coordinator.dialUp({}, coordinates, "reasoning-dial");
});

test("three rapid physical presses serialize as start then send then start", async () => {
  const base = fixture([]).codexController;
  const calls: string[] = [];
  let announceFirstStart: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { announceFirstStart = resolve; });
  let releaseFirstStart: (() => void) | undefined;
  const firstStartPending = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
  let starts = 0;
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: {
      ...base,
      async startDictation(): Promise<void> {
        starts += 1;
        calls.push("start");
        if (starts === 1) {
          announceFirstStart?.();
          await firstStartPending;
        }
      },
      async stopDictation(disposition: DictationDisposition): Promise<void> {
        calls.push(`stop:${disposition}`);
      }
    }
  });
  const coordinates = { column: 0, row: 0 };
  const actionId = "model-dial";

  const first = coordinator.dialDown({}, coordinates, actionId);
  await firstStarted;
  await coordinator.dialUp({}, coordinates, actionId);
  const second = coordinator.dialDown({}, coordinates, actionId);
  await coordinator.dialUp({}, coordinates, actionId);
  const third = coordinator.dialDown({}, coordinates, actionId);
  await coordinator.dialUp({}, coordinates, actionId);
  releaseFirstStart?.();

  assert.deepEqual(
    await Promise.all([first, second, third]),
    ["started", "sent", "started"]
  );
  assert.deepEqual(calls, ["start", "stop:send", "start"]);
  assert.equal(coordinator.voiceActive, true);
});

test("voice mode blocks every dial rotation before custom shortcuts or config candidates can run", async () => {
  const { coordinator, calls } = fixture([]);
  const model = { column: 0, row: 0 };
  const before = coordinator.encoderPresentation({}, model).value;
  await coordinator.dialDown({}, model, "model-dial");

  const overridden = {
    role: "model" as const,
    clockwiseShortcut: "cmd+shift+r",
    counterClockwiseShortcut: "cmd+shift+l"
  };
  assert.equal(await coordinator.rotateEncoder(overridden, model, 3), overridden);
  await coordinator.rotateEncoder({}, model, 1);
  await coordinator.rotateEncoder({ role: "navigation" }, { column: 1, row: 0 }, 2);
  assert.deepEqual(calls, ["dictation:start"]);

  await coordinator.dialUp({}, model, "model-dial");
  await coordinator.dialDown({}, model, "model-dial");
  await coordinator.dialUp({}, model, "model-dial");
  assert.equal(coordinator.encoderPresentation({}, model).value, before);
});

test("failed focused-dial AX actions fail closed without inventing voice state or sending text", async () => {
  const base = fixture([]).codexController;
  let starts = 0;
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: {
      ...base,
      async startDictation(): Promise<void> {
        starts += 1;
        throw new Error("AX button missing");
      }
    }
  });
  const coordinates = { column: 2, row: 0 };

  await assert.rejects(
    () => coordinator.dialDown({}, coordinates, "speed-dial"),
    /AX button missing/
  );
  assert.equal(coordinator.voiceActive, false);
  assert.equal(coordinator.encoderPresentation({}, coordinates).mode, undefined);
  assert.equal(starts, 1);
  assert.equal(await coordinator.dialDown({}, coordinates, "speed-dial"), "ignored");
  await coordinator.dialUp({}, coordinates, "speed-dial");
});

test("legacy PTT key still starts on down and stops with insert on release", async () => {
  const { coordinator, calls } = fixture([]);
  const coordinates = { column: 0, row: 0 };
  const settings = { role: "ptt" as const };

  await coordinator.pressKey(settings, coordinates);
  await coordinator.pressKey(settings, coordinates);
  assert.equal(coordinator.voiceActive, true);
  await coordinator.releaseKey(settings, coordinates);
  await coordinator.releaseKey(settings, coordinates);

  assert.equal(coordinator.voiceActive, false);
  assert.deepEqual(calls, ["dictation:start", "dictation:stop:insert"]);
});

test("agent slots remain stable when task recency order changes", async () => {
  const first = snapshot("1", "First", "idle");
  const second = snapshot("2", "Second", "working");
  let threads = [first, second];
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return threads; } },
    codex: fixture([]).codexController
  });
  await coordinator.poll();
  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).threadId, first.id);
  assert.equal(coordinator.keyPresentation({}, { column: 1, row: 0 }).threadId, second.id);

  threads = [second, first];
  await coordinator.poll();
  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).threadId, first.id);
  assert.equal(coordinator.keyPresentation({}, { column: 1, row: 0 }).threadId, second.id);
});

test("manual assignment mode without a thread id stays unassigned", async () => {
  const { coordinator } = fixture([snapshot("1", "Recent", "working")]);
  await coordinator.poll();
  const presentation = coordinator.keyPresentation(
    { role: "agent-1", autoAssign: false },
    { column: 0, row: 0 }
  );
  assert.equal(presentation.color, "off");
  assert.equal(presentation.threadId, undefined);
});

test("aggregated dial ticks execute every detent with a safety cap", async () => {
  const { coordinator, calls } = fixture([]);
  await coordinator.rotateEncoder({ role: "navigation" }, { column: 1, row: 0 }, 3);
  await coordinator.rotateEncoder({ role: "composer" }, { column: 3, row: 0 }, -2);
  assert.deepEqual(calls, [
    "navigate:forward", "navigate:forward", "navigate:forward",
    "shortcut:left", "shortcut:left"
  ]);
});

test("concurrent approval presses can emit only one decision", async () => {
  const approval = snapshot("3", "Approval", "working");
  let finishApproval: (() => void) | undefined;
  const approvalPending = new Promise<void>((resolve) => { finishApproval = resolve; });
  let approvalCalls = 0;
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.setPending(approval.id, [commandRequest("req-1")]);
  follower.stub.decideApproval = async () => {
    approvalCalls += 1;
    await approvalPending;
  };
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [approval]; } },
    codex: fixture([]).codexController,
    follower: follower.stub
  });
  await coordinator.poll();
  const firstPress = coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 });
  await Promise.resolve();
  await assert.rejects(
    () => coordinator.pressKey({ role: "approve" }, { column: 2, row: 1 }),
    /already in progress/
  );
  finishApproval?.();
  await firstPress;
  assert.equal(approvalCalls, 1);
});

test("dial apply syncs the complete snapshot to a tracked task", async () => {
  const thread = snapshot("1", "Task", "idle");
  const { coordinator, follower, liveCalls } = fixture([thread]);
  follower.stub.isConnected = true;
  follower.followOnly([thread.id]);
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 1, row: 0 }, 1);
  const outcome = await coordinator.pressEncoder({}, { column: 1, row: 0 });

  assert.equal(outcome, "applied");
  assert.deepEqual(follower.liveUpdates, [{
    conversationId: thread.id,
    threadSettings: {
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: null,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user"
    }
  }]);
  assert.deepEqual(liveCalls, []);
  assert.equal(coordinator.encoderPresentation({}, { column: 1, row: 0 }).value, "Medium");
});

test("App Server default service-tier normalization verifies a Standard-speed patch", async () => {
  const thread = snapshot("1", "Task", "idle");
  const appServer = fakeAppServer({
    resumeResult(result) {
      return result.serviceTier === null ? { ...result, serviceTier: "default" } : result;
    }
  });
  const { coordinator } = fixture([thread], { appServer });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);

  assert.equal(await coordinator.pressEncoder({}, { column: 0, row: 0 }), "applied");
  assert.deepEqual(appServer.requests.map((request) => request.method), [
    "thread/resume", "thread/settings/update", "thread/resume"
  ]);
  assert.equal(coordinator.encoderPresentation({}, { column: 0, row: 0 }).value, "5.6 Terra");
});

test("an unknown new-tab conversation does not block dial apply to the real task", async () => {
  const thread = snapshot("1", "Task", "idle");
  const { coordinator, follower } = fixture([thread]);
  follower.stub.isConnected = true;
  follower.followOnly([thread.id, "ephemeral-new-tab-0001"]);
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 1, row: 0 }, 1);
  const outcome = await coordinator.pressEncoder({}, { column: 1, row: 0 });

  assert.equal(outcome, "applied");
  assert.equal(follower.liveUpdates.at(-1)?.conversationId, thread.id);
});

test("all six tracked Agent tasks receive one identical full snapshot", async () => {
  const threads = ["1", "2", "3", "4", "5", "6"].map(
    (id) => snapshot(id, `Task ${id}`, "idle")
  );
  const { coordinator, follower } = fixture(threads);
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  const outcome = await coordinator.pressEncoder({}, { column: 0, row: 0 });

  assert.equal(outcome, "applied");
  assert.deepEqual(
    follower.liveUpdates.map((entry) => entry.conversationId),
    threads.map((thread) => thread.id)
  );
  assert.equal(new Set(follower.liveUpdates.map((entry) => JSON.stringify(entry.threadSettings))).size, 1);
  assert.deepEqual(follower.liveUpdates[0]?.threadSettings, {
    model: "gpt-5.6-terra",
    effort: "low",
    serviceTier: null,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user"
  });
  const presentation = coordinator.encoderPresentation({}, { column: 0, row: 0 });
  assert.equal(presentation.value, "5.6 Terra");
  assert.equal(presentation.hint, "rotate choose · tap reload");
});

test("one followed and five inactive tasks persist through one exact-ID App Server batch", async () => {
  const threads = ["1", "2", "3", "4", "5", "6"].map(
    (id) => snapshot(id, `Task ${id}`, "idle")
  );
  const configCalls: string[] = [];
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.followOnly([threads[0]!.id]);
  const appServer = fakeAppServer();
  let resolverCalls = 0;
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return threads; } },
    codex: fixture([]).codexController,
    config: fakeConfig(configCalls),
    follower: follower.stub,
    appServer: appServer.stub,
    resolveCodexCliPath: async () => {
      resolverCalls += 1;
      return "/Applications/ChatGPT.app/Contents/Resources/codex";
    }
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  const outcome = await coordinator.pressEncoder({}, { column: 0, row: 0 });

  assert.equal(outcome, "applied");
  assert.equal(resolverCalls, 1);
  assert.deepEqual(
    follower.liveUpdates.map((entry) => entry.conversationId),
    [threads[0]!.id]
  );
  assert.equal(appServer.events[0], "start:/Applications/ChatGPT.app/Contents/Resources/codex:true");
  assert.equal(appServer.events.at(-1), "stop");
  assert.equal(appServer.events.filter((event) => event.startsWith("start:")).length, 1);
  for (const thread of threads) {
    const requests = appServer.requests.filter(
      (request) => (request.params as { threadId?: string }).threadId === thread.id
    );
    assert.deepEqual(requests.map((request) => request.method), [
      "thread/resume", "thread/settings/update", "thread/resume"
    ]);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.timeoutMs, 15_000);
      if (index !== 1) {
      assert.deepEqual(request.params, {
        threadId: thread.id,
        excludeTurns: true
      });
      } else {
      assert.deepEqual(request.params, {
        threadId: thread.id,
        model: "gpt-5.6-terra",
        effort: "low",
        serviceTier: null,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user"
      });
      }
    }
  }
  const presentation = coordinator.encoderPresentation({}, { column: 0, row: 0 });
  assert.equal(presentation.value, "5.6 Terra");
  assert.equal(presentation.hint, "rotate choose · tap reload");
});

test("followed tasks hot-refresh before the shared App Server batch, while task persistence starts in parallel", async () => {
  const threads = [snapshot("1", "Task 1", "idle"), snapshot("2", "Task 2", "idle")];
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.followOnly(threads.map((thread) => thread.id));
  const events: string[] = [];
  const firstResumeCounts = new Map<string, number>();
  const firstResumeReleases: Array<() => void> = [];
  const saved = new Map<string, CodexThreadSettingsPatch>();
  const appServer = {
    async start(): Promise<void> { events.push("app-server:start"); },
    async stop(): Promise<void> { events.push("app-server:stop"); },
    async request(method: string, params: unknown): Promise<unknown> {
      const record = params as Record<string, unknown>;
      const threadId = record.threadId as string;
      if (method === "thread/resume") {
        const count = (firstResumeCounts.get(threadId) ?? 0) + 1;
        firstResumeCounts.set(threadId, count);
        if (count === 1) {
          events.push(`resume:first:${threadId}`);
          await new Promise<void>((resolve) => {
            firstResumeReleases.push(resolve);
            if (firstResumeReleases.length === threads.length) {
              for (const release of firstResumeReleases) release();
            }
          });
          return {};
        }
        const settings = saved.get(threadId)!;
        return {
          model: settings.model,
          reasoningEffort: settings.effort,
          serviceTier: settings.serviceTier,
          approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: settings.approvalsReviewer
        };
      }
      if (method === "thread/settings/update") {
        events.push(`update:${threadId}`);
        saved.set(threadId, {
          model: record.model as string,
          effort: record.effort as string,
          serviceTier: record.serviceTier as string | null,
          approvalPolicy: record.approvalPolicy as CodexThreadSettingsPatch["approvalPolicy"],
          approvalsReviewer: record.approvalsReviewer as CodexThreadSettingsPatch["approvalsReviewer"]
        });
      }
      return {};
    }
  };
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return threads; } },
    codex: fixture([]).codexController,
    config: fakeConfig(),
    follower: {
      ...follower.stub,
      async updateThreadSettings(conversationId, threadSettings) {
        events.push(`desktop:${conversationId}`);
        await follower.stub.updateThreadSettings(conversationId, threadSettings);
      }
    },
    appServer,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);

  assert.equal(await coordinator.pressEncoder({}, { column: 0, row: 0 }), "applied");
  assert.ok(events.indexOf(`desktop:${threads[0]!.id}`) < events.indexOf("app-server:start"));
  assert.ok(events.indexOf(`desktop:${threads[1]!.id}`) < events.indexOf("app-server:start"));
  assert.equal(firstResumeReleases.length, 2, "both task chains reached their first resume together");
  for (const thread of threads) {
    const threadEvents = events.filter((event) => event.includes(thread.id));
    assert.deepEqual(threadEvents.filter((event) => !event.startsWith("desktop:")), [
      `resume:first:${thread.id}`, `update:${thread.id}`
    ]);
  }
  assert.equal(events.at(-1), "app-server:stop");
});

test("a failed followed update falls back to the same exact App Server task", async () => {
  const thread = snapshot("1", "Task", "idle");
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.followOnly([thread.id]);
  follower.stub.updateThreadSettings = async () => {
    throw new Error("conversation became inactive");
  };
  const appServer = fakeAppServer();
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController,
    config: fakeConfig(),
    follower: follower.stub,
    appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 2, row: 0 }, 1);
  const outcome = await coordinator.pressEncoder({}, { column: 2, row: 0 });

  assert.equal(outcome, "applied");
  assert.deepEqual(
    appServer.requests.map((request) => [
      request.method,
      (request.params as { threadId?: string }).threadId
    ]),
    [
      ["thread/resume", thread.id],
      ["thread/settings/update", thread.id],
      ["thread/resume", thread.id]
    ]
  );
  assert.equal(appServer.events.at(-1), "stop");
});

test("a fixed Agent slot replaces its auto task and the sync target count stays at six", async () => {
  const threads = ["1", "2", "3", "4", "5", "6"].map(
    (id) => snapshot(id, `Task ${id}`, "idle")
  );
  const fixedId = "f".repeat(16);
  const { coordinator, follower } = fixture(threads);
  await coordinator.poll();
  coordinator.keyPresentation(
    { role: "agent-6", autoAssign: false, threadId: fixedId },
    { column: 1, row: 1 }
  );
  const expectedTargets = [...threads.slice(0, 5).map((thread) => thread.id), fixedId];
  assert.deepEqual(follower.desired.at(-1), expectedTargets);

  await coordinator.rotateEncoder({}, { column: 2, row: 0 }, 1);
  await coordinator.pressEncoder({}, { column: 2, row: 0 });
  assert.deepEqual(
    follower.liveUpdates.map((entry) => entry.conversationId),
    expectedTargets
  );
  assert.equal(follower.liveUpdates.some((entry) => entry.conversationId === threads[5]!.id), false);
});

test("clearing a removed Agent role drops its fixed task from future sync batches", async () => {
  const threads = ["1", "2", "3", "4", "5", "6"].map(
    (id) => snapshot(id, `Task ${id}`, "idle")
  );
  const fixedId = "f".repeat(16);
  const fixedSettings = { autoAssign: false, threadId: fixedId } as const;
  const coordinates = { column: 1, row: 1 };
  const { coordinator, follower } = fixture(threads);
  await coordinator.poll();
  coordinator.keyPresentation(fixedSettings, coordinates, "agent-key");
  assert.equal(follower.desired.at(-1)?.includes(fixedId), true);

  // The previous settings have no explicit role, so clearAgentSlot must use
  // the old coordinate to resolve the removed default role as Agent 6.
  coordinator.clearAgentSlot(fixedSettings, coordinates, "agent-key");
  const expectedTargets = threads.slice(0, 5).map((thread) => thread.id);
  assert.deepEqual(follower.desired.at(-1), expectedTargets);

  await coordinator.rotateEncoder({}, { column: 2, row: 0 }, 1);
  await coordinator.pressEncoder({}, { column: 2, row: 0 });
  assert.deepEqual(
    follower.liveUpdates.map((entry) => entry.conversationId),
    expectedTargets
  );
  assert.equal(follower.liveUpdates.some((entry) => entry.conversationId === fixedId), false);
});

test("a stale disappearing key cannot clear a newer owner of the same Agent slot", async () => {
  const threads = ["1", "2", "3", "4", "5", "6"].map(
    (id) => snapshot(id, `Task ${id}`, "idle")
  );
  const fixedId = "f".repeat(16);
  const settings = { role: "agent-6", autoAssign: false, threadId: fixedId } as const;
  const coordinates = { column: 1, row: 1 };
  const { coordinator, follower } = fixture(threads);
  await coordinator.poll();
  coordinator.keyPresentation(settings, coordinates, "new-owner");
  coordinator.clearAgentSlot(settings, coordinates, "old-owner");

  assert.equal(follower.desired.at(-1)?.includes(fixedId), true);
});

test("duplicate, invalid, and explicitly unassigned fixed slots never add sync targets", async () => {
  const threads = ["1", "2", "3", "4", "5", "6"].map(
    (id) => snapshot(id, `Task ${id}`, "idle")
  );
  const { coordinator, follower } = fixture(threads);
  await coordinator.poll();
  coordinator.keyPresentation(
    { role: "agent-5", autoAssign: false, threadId: threads[0]!.id },
    { column: 0, row: 1 }
  );
  coordinator.keyPresentation(
    { role: "agent-6", autoAssign: false, threadId: "invalid" },
    { column: 1, row: 1 }
  );
  const expectedTargets = threads.slice(0, 4).map((thread) => thread.id);
  assert.deepEqual(follower.desired.at(-1), expectedTargets);

  coordinator.keyPresentation(
    { role: "agent-6", autoAssign: false },
    { column: 1, row: 1 }
  );
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  await coordinator.pressEncoder({}, { column: 0, row: 0 });
  assert.deepEqual(
    follower.liveUpdates.map((entry) => entry.conversationId),
    expectedTargets
  );
});

test("follower pending approvals turn the agent key amber without rollout events", async () => {
  const thread = snapshot("1", "Task", "working");
  const { coordinator, follower } = fixture([thread]);
  follower.stub.isConnected = true;
  await coordinator.poll();
  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).color, "blue");

  follower.setPending(thread.id, [commandRequest("req-9")]);
  follower.notify();
  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).color, "amber");

  follower.clearPending(thread.id);
  follower.notify();
  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).color, "blue");
});

test("agent selection persists across a plugin restart", async () => {
  const thread = snapshot("1", "Task", "idle");
  let persisted: GlobalSettings | undefined;
  const { coordinator } = fixture([thread]);
  coordinator.configure({}, async (settings) => { persisted = settings; });
  await coordinator.poll();
  await coordinator.pressKey({}, { column: 0, row: 0 });
  assert.equal(persisted?.selectedThreadId, thread.id);

  const restarted = fixture([thread]);
  restarted.coordinator.configure(persisted ?? {});
  await restarted.coordinator.poll();
  assert.equal(restarted.coordinator.keyPresentation({}, { column: 0, row: 0 }).selected, true);
});

test("a fast PTT release cannot race the start toggle into an inverted state", async () => {
  const calls: string[] = [];
  const base = fixture([]).codexController;
  let releaseStart: (() => void) | undefined;
  const startPending = new Promise<void>((resolve) => { releaseStart = resolve; });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: {
      ...base,
      async startDictation(): Promise<void> {
        calls.push("start");
        await startPending;
      },
      async stopDictation(disposition: DictationDisposition): Promise<void> {
        calls.push(`stop:${disposition}`);
      }
    }
  });
  const coordinates = { column: 3, row: 0 };
  const settings = { role: "composer" as const };
  const down = coordinator.dialDown(settings, coordinates);
  await Promise.resolve();
  const up = coordinator.dialUp(settings, coordinates);
  releaseStart?.();
  await Promise.all([down, up]);
  assert.deepEqual(calls, ["start", "stop:insert"]);
  assert.equal(coordinator.encoderPresentation(settings, coordinates).color, "blue");
});

test("failed settings persistence never turns a successful agent press into an error", async () => {
  const { coordinator, calls } = fixture([snapshot("1", "Task", "idle")]);
  coordinator.configure({}, async () => { throw new Error("host settings unavailable"); });
  await coordinator.poll();
  await coordinator.pressKey({}, { column: 0, row: 0 });
  assert.equal(calls.length, 1);
  assert.equal(coordinator.keyPresentation({}, { column: 0, row: 0 }).selected, true);
});

test("invalid poll settings are normalized instead of creating a hot timer", () => {
  const { coordinator } = fixture([]);
  coordinator.configure({ pollIntervalMs: Number.NaN });
  assert.equal(coordinator.globalSettings.pollIntervalMs, 2000);
});

test("dial trigger descriptions explain each physical gesture in Japanese", () => {
  assert.deepEqual(triggerDescriptionForRole({}, { column: 3, row: 0 }), {
    rotate: "アクセス候補を選び、停止80ミリ秒後に自動適用（音声入力中は無効）",
    push: "音声入力を開始／もう一度押して文字起こし・送信",
    touch: "現在設定を再読み込み・待機中の適用を中止",
    longTouch: "Askへ戻して適用・待機中の適用を中止"
  });
  assert.deepEqual(triggerDescriptionForRole({}, { column: 1, row: 0 }), {
    rotate: "推論レベルを選び、停止80ミリ秒後に自動適用（音声入力中は無効）",
    push: "音声入力を開始／もう一度押して文字起こし・送信",
    touch: "現在設定を再読み込み",
    longTouch: "既定の推論レベルへ戻して適用"
  });
  assert.equal(
    triggerDescriptionForRole(
      { role: "model", pressShortcut: "cmd+shift+d" },
      { column: 0, row: 0 }
    ).push,
    "音声入力を開始／もう一度押して文字起こし・送信"
  );
});

test("key-control setting reaches the System Events controller", () => {
  const { coordinator, codexController } = fixture([]);
  coordinator.configure({ accessibilityEnabled: false });
  assert.equal(codexController.accessibilityEnabled, false);
  coordinator.configure({ accessibilityEnabled: true });
  assert.equal(codexController.accessibilityEnabled, true);
});

test("key and encoder renderers expose exact official color values", () => {
  const image = renderKeyImage({
    color: "blue", primary: "Agent 1", secondary: "Working", selected: true, pulse: true
  });
  const svg = Buffer.from(image.split(",")[1] ?? "", "base64").toString("utf8");
  assert.match(svg, /#304FFE/);
  assert.match(svg, /opacity="0\.95"/);

  const feedback = renderEncoderFeedback({
    color: "amber", title: "Composer", value: "Listening…", hint: "release to stop"
  });
  assert.deepEqual(feedback.accent, {
    value: 100,
    bar_bg_c: "#FF6D00",
    bar_fill_c: "#FF6D00",
    background: "#FF6D00"
  });
});

function snapshot(id: string, title: string, phase: ThreadSnapshot["phase"]): ThreadSnapshot {
  return { id: id.repeat(16), title, phase, updatedAt: 100 };
}

function commandRequest(id: string): PendingApproval {
  return { requestId: id, kind: "command", method: "item/commandExecution/requestApproval" };
}

function fakeFollower() {
  const listeners = new Set<() => void>();
  const pending = new Map<string, PendingApproval[]>();
  let autoFollowDesired = true;
  const decisions: string[] = [];
  const liveUpdates: Array<{
    conversationId: string;
    threadSettings: CodexThreadSettingsPatch;
  }> = [];
  const desired: string[][] = [];
  const stub = {
    isConnected: false,
    desktopFollowedIds: [] as string[],
    start(): void {},
    stop(): void {},
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDesiredConversations(ids: readonly string[]): void {
      desired.push([...ids]);
      if (autoFollowDesired) this.desktopFollowedIds = [...ids];
    },
    pendingApprovals(): Map<string, PendingApproval[]> {
      const result = new Map<string, PendingApproval[]>();
      for (const [id, requests] of pending) {
        if (requests.length) result.set(id, requests.map((request) => ({ ...request })));
      }
      return result;
    },
    async decideApproval(
      conversationId: string,
      approval: PendingApproval,
      decision: ApprovalDecision
    ): Promise<void> {
      decisions.push(`${conversationId}:${approval.requestId}:${decision}`);
      const remaining = (pending.get(conversationId) ?? [])
        .filter((request) => request.requestId !== approval.requestId);
      if (remaining.length) pending.set(conversationId, remaining);
      else pending.delete(conversationId);
    },
    async updateThreadSettings(
      conversationId: string,
      threadSettings: CodexThreadSettingsPatch
    ): Promise<void> {
      if (!this.isConnected) throw new Error("Codex Desktop IPC is unavailable");
      liveUpdates.push({ conversationId, threadSettings: structuredClone(threadSettings) });
    }
  };
  return {
    stub,
    decisions,
    liveUpdates,
    desired,
    setPending(id: string, requests: PendingApproval[]): void { pending.set(id, requests); },
    clearPending(id: string): void { pending.delete(id); },
    followOnly(ids: readonly string[]): void {
      autoFollowDesired = false;
      stub.desktopFollowedIds = [...ids];
    },
    notify(): void { for (const listener of [...listeners]) listener(); }
  };
}

function fixture(
  threads: ThreadSnapshot[],
  options: {
    appServer?: ReturnType<typeof fakeAppServer>;
    threadNames?: ReturnType<typeof fakeThreadNames>;
  } = {}
) {
  const calls: string[] = [];
  const configCalls: string[] = [];
  const liveCalls: Array<{
    fallbackConversationId: string | undefined;
    threadSettings: CodexThreadSettingsPatch;
  }> = [];
  const codex = {
    accessibilityEnabled: true,
    async openThread(id: string): Promise<"background" | "foreground"> {
      calls.push(`thread:${id}`);
      return "background";
    },
    async openApp(): Promise<void> { calls.push("app"); },
    async runCommand(command: StableCommand): Promise<void> { calls.push(`command:${command}`); },
    async runShortcutText(value: string): Promise<void> { calls.push(`shortcut:${value}`); },
    async runPaletteCommand(command: PaletteCommand): Promise<void> { calls.push(`palette:${command}`); },
    async navigate(direction: "back" | "forward"): Promise<void> { calls.push(`navigate:${direction}`); },
    async startDictation(): Promise<void> { calls.push("dictation:start"); },
    async stopDictation(disposition: DictationDisposition): Promise<void> {
      calls.push(`dictation:stop:${disposition}`);
    }
  };
  const follower = fakeFollower();
  const appServer = options.appServer ?? fakeAppServer();
  follower.stub.isConnected = true;
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return threads; } },
    codex,
    config: fakeConfig(configCalls),
    liveSettings: {
      async updateThreadSettings(
        fallbackConversationId: string | undefined,
        threadSettings: CodexThreadSettingsPatch
      ) {
        liveCalls.push({ fallbackConversationId, threadSettings });
        return fallbackConversationId
          ? { applied: true as const, conversationId: fallbackConversationId }
          : { applied: false as const, reason: "no-target" as const };
      }
    },
    follower: follower.stub,
    appServer: appServer.stub,
    threadNames: options.threadNames?.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  return {
    coordinator,
    calls,
    configCalls,
    liveCalls,
    codexController: codex,
    follower,
    appServer
  };
}

function fakeAppServer(options: {
  failRequests?: boolean;
  failRequest?: (method: string, params: unknown, index: number) => boolean;
  resumeResult?: (result: Record<string, unknown>) => unknown;
} = {}) {
  const events: string[] = [];
  const requests: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = [];
  const saved = new Map<string, CodexThreadSettingsPatch>();
  const stub = {
    async start(cliPath: string, startOptions: { experimentalApi?: boolean } = {}): Promise<void> {
      events.push(`start:${cliPath}:${startOptions.experimentalApi === true}`);
    },
    async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
      requests.push({ method, params: structuredClone(params), timeoutMs });
      events.push(method);
      if (options.failRequests
        || options.failRequest?.(method, params, requests.length - 1)) {
        throw new Error("simulated App Server failure");
      }
      const record = params as Record<string, unknown>;
      const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
      if (method === "thread/settings/update" && threadId) {
        saved.set(threadId, {
          model: typeof record.model === "string" ? record.model : undefined,
          effort: typeof record.effort === "string" ? record.effort : undefined,
          serviceTier: record.serviceTier === null || typeof record.serviceTier === "string"
            ? record.serviceTier
            : undefined,
          approvalPolicy: record.approvalPolicy as CodexThreadSettingsPatch["approvalPolicy"],
          approvalsReviewer: record.approvalsReviewer as CodexThreadSettingsPatch["approvalsReviewer"],
          permissions: typeof record.permissions === "string" ? record.permissions : undefined,
          sandboxPolicy: record.sandboxPolicy as CodexThreadSettingsPatch["sandboxPolicy"]
        });
      }
      if (method === "thread/resume" && threadId) {
        const settings = saved.get(threadId);
        const result: Record<string, unknown> = settings ? {
          model: settings.model,
          reasoningEffort: settings.effort,
          serviceTier: settings.serviceTier,
          approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: settings.approvalsReviewer,
          activePermissionProfile: settings.permissions ? { id: settings.permissions } : null,
          sandbox: settings.sandboxPolicy
        } : {};
        return options.resumeResult?.(result) ?? result;
      }
      return {};
    },
    async stop(): Promise<void> {
      events.push("stop");
    }
  };
  return { stub, events, requests };
}

function fakeThreadNames(threads: ThreadSnapshot[], fail = false) {
  const events: string[] = [];
  const stub = {
    async start(cliPath: string, startOptions: { experimentalApi?: boolean } = {}): Promise<void> {
      events.push(`start:${cliPath}:${startOptions.experimentalApi === true}`);
    },
    async stop(): Promise<void> {
      events.push("stop");
    },
    async pollRecentThreads(): Promise<ThreadSnapshot[]> {
      events.push("poll");
      if (fail) throw new Error("simulated App Server name failure");
      return threads;
    }
  };
  return { stub, events };
}

function fakeConfig(
  calls: string[] = [],
  failingRole?: ConfigControlRole,
  initialApproval: CodexControlSnapshot["approval"] = "strict",
  customAccess?: CodexControlSnapshot["customAccess"]
) {
  let snapshot: CodexControlSnapshot = {
    models: [
      { id: "gpt-5.6-sol", label: "5.6 Sol", reasoning: ["low", "medium"], defaultReasoning: "low", priority: 1 },
      { id: "gpt-5.6-terra", label: "5.6 Terra", reasoning: ["low", "medium"], defaultReasoning: "medium", priority: 2 }
    ],
    model: "gpt-5.6-sol", reasoning: "low", speed: "standard", approval: initialApproval,
    ...(customAccess ? { customAccess } : {})
  };
  return {
    enabled: true,
    async read(): Promise<CodexControlSnapshot> { calls.push("read"); return structuredClone(snapshot); },
    async applyControl(role: ConfigControlRole, value: string): Promise<CodexControlSnapshot> {
      calls.push(`apply:${role}:${value}`);
      if (role === failingRole) throw new Error(`simulated ${role} apply failure`);
      snapshot = { ...snapshot, [role]: value } as CodexControlSnapshot;
      return structuredClone(snapshot);
    },
    async resetControl(role: ConfigControlRole): Promise<CodexControlSnapshot> {
      calls.push(`reset:${role}`);
      const defaults = { model: "gpt-5.6-sol", reasoning: "low", speed: "standard", approval: "ask" };
      snapshot = { ...snapshot, [role]: defaults[role] } as CodexControlSnapshot;
      return structuredClone(snapshot);
    }
  };
}
