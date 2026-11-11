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
import { safeActionError } from "../src/core/errors.ts";
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
    "agent-5", "agent-6", "approve", "voice-toggle"
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

test("an App Server blank name never overwrites a valid local task label", async () => {
  const names = fakeThreadNames([
    { ...snapshot("1", "Untitled", "idle") }
  ]);
  const { coordinator } = fixture([
    snapshot("1", "Saved local task name", "idle")
  ], { threadNames: names });

  await coordinator.poll();

  assert.equal(
    coordinator.keyPresentation({}, { column: 0, row: 0 }).secondary,
    "Saved local task name"
  );
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
  assert.deepEqual(follower.ownerAttempts[0]?.threadSettings, {
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
  follower.stub.updateThreadSettingsVerified = async (_conversationId, threadSettings) => {
    liveStarts.push(structuredClone(threadSettings));
    if (liveStarts.length === 1) {
      announceModelStarted?.();
      await modelPending;
    }
    liveCompletions.push(structuredClone(threadSettings));
    return false;
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
  follower.stub.updateThreadSettingsVerified = async (_conversationId, patch) => {
    livePatches.push(structuredClone(patch));
    if (livePatches.length === 1) {
      announceStarted?.();
      await firstPending;
    }
    return false;
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
  follower.stub.updateThreadSettingsVerified = async () => {
    liveCalls += 1;
    if (liveCalls === 1) throw new Error("first live apply failed");
    return false;
  };
  const appServer = fakeAppServer();
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

  assert.deepEqual(follower.ownerAttempts.at(-1), {
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
    follower.ownerAttempts.map((update) => update.conversationId),
    [...tracked.map((thread) => thread.id), openCompleted.id]
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
  assert.deepEqual([...follower.ownerAttempts], []);

  await coordinator.rotateEncoder({}, approval, 1);
  assert.equal(coordinator.encoderPresentation({}, approval).value, "Ask");
  const outcome = await coordinator.pressEncoder({}, approval);
  assert.equal(outcome, "applied");
  assert.deepEqual(calls, ["read", "apply:approval:ask"]);
  assert.equal(follower.ownerAttempts.length, 1);
  assert.equal(follower.ownerAttempts[0]?.threadSettings.approvalPolicy, "on-request");
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

  assert.deepEqual(follower.ownerAttempts.at(-1), {
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
  assert.equal(follower.ownerAttempts.at(-1)?.threadSettings.permissions, ":danger-full-access");
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
  assert.equal(coordinator.encoderPresentation({}, access).hint, "auto in 300ms · next turn");
  assert.equal(await coordinator.pressEncoder({}, access, "auto"), "applied");
  assert.deepEqual(configCalls, ["apply:approval:full"]);
  assert.equal(follower.ownerAttempts.length, 1);
  assert.equal(follower.ownerAttempts[0]?.threadSettings.permissions, ":danger-full-access");
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
  assert.equal(follower.ownerAttempts.at(-1)?.threadSettings.permissions, undefined);
  assert.deepEqual(follower.ownerAttempts.at(-1)?.threadSettings.sandboxPolicy, {
    type: "readOnly", networkAccess: false
  });
});

test("a partial task sync reports its failure reason safely without changing the successful count", async () => {
  const calls: string[] = [];
  const threads = [
    snapshot("1", "One", "idle"),
    snapshot("2", "Two", "idle"),
    snapshot("3", "Three", "idle")
  ];
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  const appServer = fakeAppServer({
    failRequest: (_method, params) => {
      if ((params as { threadId?: string }).threadId === threads[1]!.id) {
        throw new Error(
          "resume rejected for 11111111-2222-3333-4444-555555555555 at /Users/example/.codex/history.json\nretry\tlater"
        );
      }
      return false;
    }
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
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /synced 2\/3.*Partial sync/i);
      assert.match(error.message, /resume rejected/);
      const logged = safeActionError(error);
      assert.match(logged, /resume rejected for <thread-id> at <user-path> retry later/);
      assert.doesNotMatch(logged, /11111111|\/Users\/|[\r\n\t]/);
      assert.ok(logged.length <= 180);
      return true;
    }
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
  follower.stub.updateThreadSettingsVerified = async () => {
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
  assert.deepEqual(appServer.events, [], "an uncertain owner failure must not start a second writer");
});

test("a read-back reviewer mismatch retries once and never shows a false sync", async () => {
  const thread = snapshot("1", "Tracked", "idle");
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  const appServer = fakeAppServer({
    resumeResult(result) {
      return { ...result, approvalsReviewer: "user", serviceTier: "default" };
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
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /verification failed \(approvalsReviewer\)/);
      assert.doesNotMatch(error.message, /guardian_subagent|gpt-5\.6|on-request/);
      return true;
    }
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
  assert.equal(follower.ownerAttempts.length, 1);
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
  assert.deepEqual(follower.ownerAttempts, []);
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

test("a second dial press during AX start is ignored instead of being queued", async () => {
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
  assert.equal(
    await coordinator.pressKey(
      { role: "voice-toggle" },
      { column: 3, row: 1 },
      "voice-key"
    ),
    "ignored"
  );
  await coordinator.releaseKey(
    { role: "voice-toggle" },
    { column: 3, row: 1 },
    "voice-key"
  );
  assert.equal(
    await coordinator.dialDown({}, { column: 2, row: 0 }, "speed-dial"),
    "ignored"
  );
  await coordinator.dialUp({}, { column: 2, row: 0 }, "speed-dial");
  assert.deepEqual(calls, ["start"]);

  releaseStart?.();
  assert.equal(await first, "started");
  await coordinator.dialUp({}, { column: 0, row: 0 }, "model-dial");
  assert.deepEqual(calls, ["start"]);
  assert.equal(coordinator.voiceActive, true);
});

test("a failed Transcribe and send AX press clears voice state instead of sticking", async () => {
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
  let notifications = 0;
  coordinator.onChange(() => { notifications += 1; });

  await coordinator.dialDown({}, coordinates, "reasoning-dial");
  await coordinator.dialUp({}, coordinates, "reasoning-dial");
  const notificationsBeforeFailure = notifications;
  await assert.rejects(
    () => coordinator.dialDown({}, coordinates, "reasoning-dial"),
    /send button unavailable/
  );

  assert.equal(coordinator.voiceActive, false);
  assert.equal(coordinator.encoderPresentation({}, coordinates).mode, undefined);
  assert.equal(notifications, notificationsBeforeFailure + 1);
  assert.deepEqual(calls, ["start", "stop:send"]);
  await coordinator.dialUp({}, coordinates, "reasoning-dial");
});

test("five rapid physical presses execute only the first voice toggle action", async () => {
  const base = fixture([]).codexController;
  const calls: string[] = [];
  let announceFirstStart: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { announceFirstStart = resolve; });
  let releaseFirstStart: (() => void) | undefined;
  const firstStartPending = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: {
      ...base,
      async startDictation(): Promise<void> {
        calls.push("start");
        announceFirstStart?.();
        await firstStartPending;
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
  const results: Array<string | void> = [];
  for (let press = 1; press < 5; press += 1) {
    results.push(await coordinator.dialDown({}, coordinates, actionId));
    await coordinator.dialUp({}, coordinates, actionId);
  }
  releaseFirstStart?.();

  assert.equal(await first, "started");
  assert.deepEqual(results, ["ignored", "ignored", "ignored", "ignored"]);
  assert.deepEqual(calls, ["start"]);
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

test("voice mode ignores every non-toggle key action before it can reach Codex", async () => {
  const { coordinator, calls } = fixture([]);
  const model = { column: 0, row: 0 };

  await coordinator.dialDown({}, model, "model-dial");
  await coordinator.dialUp({}, model, "model-dial");

  const blockedPresses = [
    coordinator.pressKey(
      { role: "submit", shortcut: "cmd+return" },
      { column: 0, row: 1 },
      "shortcut-key"
    ),
    coordinator.pressKey({ role: "interrupt" }, { column: 1, row: 1 }, "interrupt-key"),
    coordinator.pressKey({ role: "submit" }, { column: 2, row: 1 }, "submit-key"),
    coordinator.pressKey({ role: "fork" }, { column: 3, row: 1 }, "fork-key"),
    coordinator.pressKey({ role: "approve" }, { column: 0, row: 1 }, "approve-key"),
    coordinator.pressKey({ role: "decline" }, { column: 1, row: 1 }, "decline-key"),
    coordinator.pressKey({ role: "agent-1" }, { column: 2, row: 1 }, "agent-key"),
    coordinator.pressKey({ role: "ptt" }, { column: 3, row: 1 }, "ptt-key")
  ];

  assert.deepEqual(
    await Promise.all(blockedPresses),
    Array.from({ length: blockedPresses.length }, () => "ignored")
  );
  assert.deepEqual(calls, ["dictation:start"]);

  assert.equal(
    await coordinator.pressKey(
      { role: "voice-toggle", shortcut: "cmd+return" },
      { column: 3, row: 1 },
      "voice-key"
    ),
    "sent"
  );
  await coordinator.releaseKey(
    { role: "voice-toggle", shortcut: "cmd+return" },
    { column: 3, row: 1 },
    "voice-key"
  );
  assert.deepEqual(calls, ["dictation:start", "dictation:stop:send"]);
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
  assert.equal(await coordinator.pressKey(settings, coordinates), "ignored");
  assert.equal(
    await coordinator.pressKey(settings, { column: 1, row: 0 }),
    "ignored"
  );
  assert.equal(coordinator.voiceActive, true);
  await coordinator.releaseKey(settings, coordinates);
  await coordinator.releaseKey(settings, coordinates);

  assert.equal(coordinator.voiceActive, false);
  assert.deepEqual(calls, ["dictation:start", "dictation:stop:insert"]);
});

test("a failed legacy insert stop clears its owner and active state", async () => {
  const base = fixture([]).codexController;
  const calls: string[] = [];
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: {
      ...base,
      async startDictation(): Promise<void> { calls.push("start"); },
      async stopDictation(disposition: DictationDisposition): Promise<void> {
        calls.push(`stop:${disposition}`);
        throw new Error("insert button unavailable");
      }
    }
  });
  const coordinates = { column: 0, row: 0 };
  const settings = { role: "ptt" as const };
  let notifications = 0;
  coordinator.onChange(() => { notifications += 1; });

  await coordinator.pressKey(settings, coordinates);
  const notificationsBeforeFailure = notifications;
  await assert.rejects(
    () => coordinator.releaseKey(settings, coordinates),
    /insert button unavailable/
  );

  assert.equal(coordinator.voiceActive, false);
  assert.equal(notifications, notificationsBeforeFailure + 1);
  assert.deepEqual(calls, ["start", "stop:insert"]);
  await coordinator.pressKey(settings, coordinates);
  assert.equal(coordinator.voiceActive, true);
});

test("voice mode makes every encoder touch gesture a no-op", async () => {
  const { coordinator, calls, configCalls } = fixture([]);
  const model = { column: 0, row: 0 };

  await coordinator.dialDown({}, model, "model-dial");
  await coordinator.dialUp({}, model, "model-dial");
  await coordinator.touchEncoder({}, model, false);
  await coordinator.touchEncoder({}, model, true);
  await coordinator.touchEncoder({ role: "composer" }, { column: 1, row: 0 }, false);
  await coordinator.touchEncoder({ role: "composer" }, { column: 1, row: 0 }, true);
  await coordinator.touchEncoder({ role: "navigation" }, { column: 2, row: 0 }, false);
  await coordinator.touchEncoder({ role: "navigation" }, { column: 2, row: 0 }, true);

  assert.deepEqual(calls, ["dictation:start"]);
  assert.deepEqual(configCalls, []);
});

test("stop clears local voice state and physical press owners", async () => {
  const { coordinator, calls } = fixture([]);
  const coordinates = { column: 3, row: 1 };
  const settings = { role: "voice-toggle" as const };

  assert.equal(await coordinator.pressKey(settings, coordinates, "voice-key"), "started");
  coordinator.stop();
  assert.equal(coordinator.voiceActive, false);
  assert.equal(await coordinator.pressKey(settings, coordinates, "voice-key"), "started");

  assert.deepEqual(calls, ["dictation:start", "dictation:start"]);
});

test("voice toggle key starts once per physical press and sends on the next press", async () => {
  const { coordinator, calls } = fixture([]);
  const coordinates = { column: 3, row: 1 };
  const settings = { role: "voice-toggle" as const };
  const actionId = "voice-key";

  assert.equal(
    await coordinator.pressKey(settings, coordinates, actionId),
    "started"
  );
  assert.equal(
    await coordinator.pressKey(settings, coordinates, actionId),
    "ignored"
  );
  assert.equal(coordinator.voiceActive, true);
  assert.deepEqual(coordinator.keyPresentation(settings, coordinates), {
    color: "blue",
    primary: "Voice",
    secondary: "Listening…"
  });

  await coordinator.releaseKey(settings, coordinates, actionId);
  assert.equal(coordinator.voiceActive, true);
  assert.equal(
    await coordinator.pressKey(settings, coordinates, actionId),
    "sent"
  );
  assert.equal(
    await coordinator.pressKey(settings, coordinates, actionId),
    "ignored"
  );
  await coordinator.releaseKey(settings, coordinates, actionId);

  assert.equal(coordinator.voiceActive, false);
  assert.deepEqual(coordinator.keyPresentation(settings, coordinates), {
    color: "white",
    primary: "Voice",
    secondary: "Tap to talk"
  });
  assert.deepEqual(calls, ["dictation:start", "dictation:stop:send"]);
});

test("explicit dictation tokens distinguish state sync from a performed action", async () => {
  const base = fixture([]).codexController;
  const calls: string[] = [];
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return []; } },
    codex: {
      ...base,
      async startDictation() {
        calls.push("start:already-active");
        return "already-active" as const;
      },
      async stopDictation(disposition: DictationDisposition) {
        calls.push(`stop:${disposition}:already-idle`);
        return "already-idle" as const;
      }
    }
  });
  const coordinates = { column: 3, row: 1 };
  const settings = { role: "voice-toggle" as const };

  assert.equal(
    await coordinator.pressKey(settings, coordinates, "voice-key"),
    "synced"
  );
  assert.equal(coordinator.voiceActive, true);
  await coordinator.releaseKey(settings, coordinates, "voice-key");

  assert.equal(
    await coordinator.pressKey(settings, coordinates, "voice-key"),
    "already-idle"
  );
  assert.equal(coordinator.voiceActive, false);
  await coordinator.releaseKey(settings, coordinates, "voice-key");

  assert.deepEqual(calls, [
    "start:already-active",
    "stop:send:already-idle"
  ]);
});

test("failed voice toggle key send clears the listening state", async () => {
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
  const coordinates = { column: 3, row: 1 };
  const settings = { role: "voice-toggle" as const };
  let notifications = 0;
  coordinator.onChange(() => { notifications += 1; });

  await coordinator.pressKey(settings, coordinates, "voice-key");
  await coordinator.releaseKey(settings, coordinates, "voice-key");
  const notificationsBeforeFailure = notifications;
  await assert.rejects(
    () => coordinator.pressKey(settings, coordinates, "voice-key"),
    /send button unavailable/
  );

  assert.equal(coordinator.voiceActive, false);
  assert.equal(coordinator.keyPresentation(settings, coordinates).color, "white");
  assert.equal(notifications, notificationsBeforeFailure + 1);
  assert.deepEqual(calls, ["start", "stop:send"]);
  await coordinator.releaseKey(settings, coordinates, "voice-key");
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
  assert.deepEqual(follower.ownerAttempts, [{
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
  assert.equal(follower.ownerAttempts.at(-1)?.conversationId, thread.id);
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
    follower.ownerAttempts.map((entry) => entry.conversationId),
    threads.map((thread) => thread.id)
  );
  assert.equal(new Set(follower.ownerAttempts.map((entry) => JSON.stringify(entry.threadSettings))).size, 1);
  assert.deepEqual(follower.ownerAttempts[0]?.threadSettings, {
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

test("owner discovery checks every exact target regardless of the followed window before native fallback", async () => {
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
    follower.ownerAttempts.map((entry) => entry.conversationId),
    threads.map((thread) => thread.id)
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

test("owner discovery precedes one shared native batch while per-target persistence remains parallel", async () => {
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
      async updateThreadSettingsVerified(conversationId, threadSettings) {
        events.push(`owner:${conversationId}`);
        return follower.stub.updateThreadSettingsVerified(conversationId, threadSettings);
      }
    },
    appServer,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);

  assert.equal(await coordinator.pressEncoder({}, { column: 0, row: 0 }), "applied");
  for (const thread of threads) {
    assert.ok(events.includes(`owner:${thread.id}`));
    assert.ok(events.indexOf(`owner:${thread.id}`) < events.indexOf("app-server:start"));
  }
  assert.equal(firstResumeReleases.length, 2, "both task chains reached their first resume together");
  for (const thread of threads) {
    const threadEvents = events.filter((event) => event.includes(thread.id));
    assert.deepEqual(threadEvents.filter((event) => !event.startsWith("owner:")), [
      `resume:first:${thread.id}`, `update:${thread.id}`
    ]);
  }
  assert.equal(events.at(-1), "app-server:stop");
});

test("a definitively unavailable owner falls back to the same exact native task", async () => {
  const thread = snapshot("1", "Task", "idle");
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.followOnly([thread.id]);
  follower.stub.updateThreadSettingsVerified = async () => {
    return false;
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

test("mixed owned and unowned Agent slots verify every target without acquiring a second writer", async () => {
  const threads = ["1", "2", "3", "4", "5", "6", "7", "8"].map(
    (id) => snapshot(id, `Task ${id}`, "idle")
  );
  // The released six-Agent profile and the pending eight-Agent profile share
  // this sync code. Derive the expected slots from the public key mapping so
  // the same regression also covers five owners plus three native tasks when
  // integrated into the user's eight-Agent source.
  const slotCount = [0, 1].flatMap((row) => [0, 1, 2, 3].map((column) => keyRole({}, { column, row })))
    .filter((role) => role.startsWith("agent-")).length;
  const targets = threads.slice(0, slotCount).map((thread) => thread.id);
  const owned = new Set(targets.slice(0, 5));
  const persisted = new Map<string, CodexThreadSettingsPatch>();
  const checks: string[] = [];
  const ownerWrites: string[] = [];
  let activeOwnerRequests = 0;
  let peakOwnerRequests = 0;
  const follower = fakeFollower();
  follower.stub.isConnected = true;
  follower.followOnly([]);
  follower.stub.updateThreadSettingsVerified = async (id, patch) => {
    checks.push(id);
    activeOwnerRequests += 1;
    peakOwnerRequests = Math.max(peakOwnerRequests, activeOwnerRequests);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      if (!owned.has(id)) return false;
      ownerWrites.push(id);
      persisted.set(id, structuredClone(patch));
      return true;
    } finally {
      activeOwnerRequests -= 1;
    }
  };
  const appServer = fakeAppServer({
    ownerPersistedSettings: persisted,
    failRequest(method, params) {
      const id = (params as { threadId: string }).threadId;
      if (owned.has(id) && method !== "thread/read") {
        throw new Error("thread already has an active writer");
      }
      return false;
    }
  });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return threads; } },
    codex: fixture([]).codexController, config: fakeConfig(),
    follower: follower.stub, appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  assert.equal(await coordinator.pressEncoder({}, { column: 0, row: 0 }), "applied");
  assert.deepEqual(checks, targets, "hidden owners must be checked too");
  assert.equal(peakOwnerRequests, 3, "owner requests must be parallel but bounded");
  assert.deepEqual(ownerWrites, [...owned]);
  assert.equal(appServer.events.filter((event) => event.startsWith("start:")).length, 1);
  assert.equal(appServer.events.filter((event) => event === "stop").length, 1);
  for (const id of targets) {
    const requests = appServer.requests.filter((request) => (request.params as { threadId: string }).threadId === id);
    assert.deepEqual(requests.map((request) => request.method), owned.has(id)
      ? ["thread/read"] : ["thread/resume", "thread/settings/update", "thread/resume"]);
    if (owned.has(id)) assert.deepEqual(requests[0]?.params, { threadId: id, includeTurns: false });
  }
  assert.equal(coordinator.encoderPresentation({}, { column: 0, row: 0 }).value, "5.6 Terra");
});

test("uncertain owner failures never start a standalone fallback writer", async (t) => {
  for (const reason of ["request-timeout", "owner rejected settings", "applied was false", "owner settings verification failed"]) {
    await t.test(reason, async () => {
      const thread = snapshot("1", "Owned", "idle");
      const follower = fakeFollower();
      follower.stub.isConnected = true;
      follower.stub.updateThreadSettingsVerified = async () => { throw new Error(reason); };
      const appServer = fakeAppServer();
      const coordinator = new CodexDeckCoordinator({
        provider: { async listRecentThreads() { return [thread]; } },
        codex: fixture([]).codexController, config: fakeConfig(),
        follower: follower.stub, appServer: appServer.stub
      });
      await coordinator.poll();
      await coordinator.rotateEncoder({}, { column: 1, row: 0 }, 1);
      await assert.rejects(() => coordinator.pressEncoder({}, { column: 1, row: 0 }), /failed for all 1 tracked tasks/);
      assert.deepEqual(appServer.events, []);
      assert.deepEqual(appServer.requests, []);
      assert.equal(coordinator.encoderPresentation({}, { column: 1, row: 0 }).value, "⚠ 0/1");
    });
  }
});

test("a non-boolean owner result cannot authorize a native fallback writer", async () => {
  const thread = snapshot("1", "Owned", "idle");
  const follower = fakeFollower();
  follower.stub.updateThreadSettingsVerified = async () => undefined as unknown as boolean;
  const appServer = fakeAppServer();
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController, config: fakeConfig(),
    follower: follower.stub, appServer: appServer.stub
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  await assert.rejects(() => coordinator.pressEncoder({}, { column: 0, row: 0 }), /invalid owner verification result/);
  assert.deepEqual(appServer.events, []);
  assert.deepEqual(appServer.requests, []);
  assert.equal(coordinator.encoderPresentation({}, { column: 0, row: 0 }).value, "⚠ 0/1");
});

test("owner acknowledgement requires independent persisted model and effort readback for the exact thread", async (t) => {
  const variants = [
    { name: "model", change: (result: Record<string, unknown>) => ({ thread: { ...(result.thread as object), model: "stale-model" } }) },
    { name: "effort", change: (result: Record<string, unknown>) => ({ thread: { ...(result.thread as object), reasoningEffort: "stale-effort" } }) },
    { name: "threadId", change: (result: Record<string, unknown>) => ({ thread: { ...(result.thread as object), id: "2".repeat(16) } }) },
    { name: "malformed metadata", change: (result: Record<string, unknown>) => ({ thread: { ...(result.thread as object), model: {} } }) }
  ];
  for (const { name, change } of variants) {
    await t.test(name, async () => {
      const thread = snapshot("1", "Owned", "idle");
      const persisted = new Map<string, CodexThreadSettingsPatch>();
      const follower = fakeFollower();
      let ownerWrites = 0;
      follower.stub.updateThreadSettingsVerified = async (id, patch) => {
        ownerWrites += 1;
        persisted.set(id, structuredClone(patch));
        return true;
      };
      const appServer = fakeAppServer({ ownerPersistedSettings: persisted, readResult: change });
      const coordinator = new CodexDeckCoordinator({
        provider: { async listRecentThreads() { return [thread]; } },
        codex: fixture([]).codexController, config: fakeConfig(),
        follower: follower.stub, appServer: appServer.stub,
        resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
      });
      await coordinator.poll();
      await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
      await assert.rejects(() => coordinator.pressEncoder({}, { column: 0, row: 0 }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`persistence verification failed (${name})`));
        assert.doesNotMatch(error.message, /stale-model|stale-effort|2222222222222222/);
        return true;
      });
      assert.equal(ownerWrites, 1, "do not blindly re-submit an uncertain write");
      assert.deepEqual(appServer.requests.map((request) => request.method),
        Array.from({ length: name === "model" || name === "effort" ? 5 : 1 }, () => "thread/read"));
      assert.equal(appServer.events.at(-1), "stop");
    });
  }
});

test("a failed read-only persisted lookup cannot become a writer fallback", async () => {
  const thread = snapshot("1", "Owned", "idle");
  const follower = fakeFollower();
  follower.stub.updateThreadSettingsVerified = async () => true;
  const appServer = fakeAppServer({ failRequests: true });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController, config: fakeConfig(),
    follower: follower.stub, appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  await assert.rejects(() => coordinator.pressEncoder({}, { column: 0, row: 0 }), /failed for all 1 tracked tasks/);
  assert.deepEqual(appServer.requests.map((request) => request.method), ["thread/read"]);
  assert.equal(appServer.events.at(-1), "stop");
});

test("owner persistence projection may catch up through bounded reads without another write", async () => {
  const thread = snapshot("1", "Owned", "idle");
  const persisted = new Map<string, CodexThreadSettingsPatch>();
  const follower = fakeFollower();
  let writes = 0;
  follower.stub.updateThreadSettingsVerified = async (id, patch) => {
    writes += 1;
    persisted.set(id, structuredClone(patch));
    return true;
  };
  let reads = 0;
  const appServer = fakeAppServer({
    ownerPersistedSettings: persisted,
    readResult(result) {
      reads += 1;
      return reads < 3 ? { thread: { id: thread.id, model: "old", reasoningEffort: "old" } } : result;
    }
  });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController, config: fakeConfig(),
    follower: follower.stub, appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  assert.equal(await coordinator.pressEncoder({}, { column: 0, row: 0 }), "applied");
  assert.equal(writes, 1);
  assert.deepEqual(appServer.requests.map((request) => request.method),
    ["thread/read", "thread/read", "thread/read"]);
});

test("a stale no-owner result cannot bypass an existing native writer lock", async () => {
  const thread = snapshot("1", "Owned", "idle");
  const follower = fakeFollower();
  const appServer = fakeAppServer({
    failRequest(method) {
      if (method === "thread/resume") throw new Error("thread already has an active writer");
      return false;
    }
  });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController, config: fakeConfig(),
    follower: follower.stub, appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  await assert.rejects(() => coordinator.pressEncoder({}, { column: 0, row: 0 }), /already has an active writer/);
  assert.deepEqual(appServer.requests.map((request) => request.method), ["thread/resume"]);
  assert.equal(appServer.events.at(-1), "stop");
});

test("a later dial batch waits until the prior owner write and independent readback have drained", async () => {
  const thread = snapshot("1", "Owned", "idle");
  const persisted = new Map<string, CodexThreadSettingsPatch>();
  const events: string[] = [];
  const follower = fakeFollower();
  let ownerCalls = 0;
  let announceFirstRead!: () => void;
  const firstReadStarted = new Promise<void>((resolve) => { announceFirstRead = resolve; });
  let releaseFirstRead!: () => void;
  const firstReadPending = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  follower.stub.updateThreadSettingsVerified = async (id, patch) => {
    ownerCalls += 1;
    events.push(`owner:${patch.model}:${patch.effort}`);
    persisted.set(id, structuredClone(patch));
    return true;
  };
  let readCalls = 0;
  const appServer = fakeAppServer({
    ownerPersistedSettings: persisted,
    readResult: async (result) => {
      readCalls += 1;
      events.push(`read:start:${readCalls}`);
      if (readCalls === 1) {
        announceFirstRead();
        await firstReadPending;
      }
      events.push(`read:done:${readCalls}`);
      return result;
    }
  });
  const coordinator = new CodexDeckCoordinator({
    provider: { async listRecentThreads() { return [thread]; } },
    codex: fixture([]).codexController, config: fakeConfig(),
    follower: follower.stub, appServer: appServer.stub,
    resolveCodexCliPath: async () => "/Applications/ChatGPT.app/Contents/Resources/codex"
  });
  await coordinator.poll();
  await coordinator.rotateEncoder({}, { column: 0, row: 0 }, 1);
  await coordinator.rotateEncoder({}, { column: 1, row: 0 }, 1);
  const first = coordinator.pressEncoder({}, { column: 0, row: 0 });
  const second = coordinator.pressEncoder({}, { column: 1, row: 0 });
  await firstReadStarted;
  assert.equal(ownerCalls, 1);
  releaseFirstRead();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "owner:gpt-5.6-terra:low", "read:start:1", "read:done:1",
    "owner:gpt-5.6-terra:medium", "read:start:2", "read:done:2"
  ]);
  assert.equal(persisted.get(thread.id)?.effort, "medium");
  assert.equal(appServer.events.filter((event) => event.startsWith("start:")).length, 2);
  assert.equal(appServer.events.filter((event) => event === "stop").length, 2);
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
    follower.ownerAttempts.map((entry) => entry.conversationId),
    expectedTargets
  );
  assert.equal(follower.ownerAttempts.some((entry) => entry.conversationId === threads[5]!.id), false);
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
    follower.ownerAttempts.map((entry) => entry.conversationId),
    expectedTargets
  );
  assert.equal(follower.ownerAttempts.some((entry) => entry.conversationId === fixedId), false);
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
    follower.ownerAttempts.map((entry) => entry.conversationId),
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
    rotate: "アクセス候補を選び、停止300ミリ秒後に自動適用（音声入力中は無効）",
    push: "音声入力を開始／もう一度押して文字起こし・送信",
    touch: "現在設定を再読み込み・待機中の適用を中止",
    longTouch: "Askへ戻して適用・待機中の適用を中止"
  });
  assert.deepEqual(triggerDescriptionForRole({}, { column: 1, row: 0 }), {
    rotate: "推論レベルを選び、停止300ミリ秒後に自動適用（音声入力中は無効）",
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
  const ownerAttempts: Array<{
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
    async updateThreadSettingsVerified(
      conversationId: string,
      threadSettings: CodexThreadSettingsPatch
    ): Promise<boolean> {
      if (!this.isConnected) return false;
      ownerAttempts.push({ conversationId, threadSettings: structuredClone(threadSettings) });
      // This default fixture models a connected router with no owner for the
      // exact target. No settings are submitted; native fallback is permitted.
      return false;
    }
  };
  return {
    stub,
    decisions,
    ownerAttempts,
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
  ownerPersistedSettings?: Map<string, CodexThreadSettingsPatch>;
  readResult?: (result: Record<string, unknown>, threadId: string) => unknown;
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
      if (method === "thread/read" && threadId) {
        const settings = options.ownerPersistedSettings?.get(threadId) ?? saved.get(threadId);
        const result = { thread: { id: threadId, model: settings?.model, reasoningEffort: settings?.effort } };
        return options.readResult?.(result, threadId) ?? result;
      }
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
