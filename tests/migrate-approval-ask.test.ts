import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_ASK_PATCH,
  assertApprovalOnlyPatch,
  exactRecentThreadIds,
  parseMigrationArgs,
  resolveCodexCliPath,
  runApprovalAskMigration
} from "../scripts/migrate-approval-ask.mjs";

const IDS = Array.from({ length: 6 }, (_, index) => `${index + 1}`.repeat(16));
const TEST_CLI_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";

test("approval migration is dry-run by default and rejects unsafe arguments", () => {
  assert.deepEqual(parseMigrationArgs([]), { apply: false, help: false });
  assert.deepEqual(parseMigrationArgs(["--apply"]), { apply: true, help: false });
  assert.throws(() => parseMigrationArgs(["--apply", "--dry-run"]), /同時/);
  assert.throws(() => parseMigrationArgs(["--force"]), /未対応/);
});

test("approval migration patch contains exactly the two approval fields", () => {
  assert.deepEqual(assertApprovalOnlyPatch(APPROVAL_ASK_PATCH), {
    approvalPolicy: "on-request",
    approvalsReviewer: "user"
  });
  assert.throws(
    () => assertApprovalOnlyPatch({ ...APPROVAL_ASK_PATCH, model: "gpt-5.6-sol" }),
    /承認以外/
  );
  assert.throws(
    () => assertApprovalOnlyPatch({
      approvalPolicy: "never",
      approvalsReviewer: "user"
    }),
    /Ask設定/
  );
});

test("recent targets must be six unique exact conversation ids", () => {
  assert.deepEqual(exactRecentThreadIds(IDS.map((id) => ({ id }))), IDS);
  assert.throws(() => exactRecentThreadIds(IDS.slice(0, 5).map((id) => ({ id }))), /最近6タスク/);
  assert.throws(
    () => exactRecentThreadIds([...IDS.slice(0, 5), IDS[0]].map((id) => ({ id }))),
    /最近6タスク/
  );
});

test("Codex CLI resolver selects the first executable absolute candidate", async () => {
  const checked: string[] = [];
  const resolved = await resolveCodexCliPath(
    ["/missing/codex", TEST_CLI_PATH],
    async (candidate) => {
      checked.push(candidate);
      return candidate === TEST_CLI_PATH;
    }
  );
  assert.equal(resolved, TEST_CLI_PATH);
  assert.deepEqual(checked, ["/missing/codex", TEST_CLI_PATH]);

  await assert.rejects(
    () => resolveCodexCliPath(
      ["relative/codex", "/missing/codex"],
      async () => false
    ),
    /見つかりません/
  );
});

test("dry-run reads state but never writes config or starts IPC", async () => {
  const events: string[] = [];
  const result = await runApprovalAskMigration({
    provider: {
      async listRecentThreads() {
        events.push("list");
        return IDS.map((id) => ({ id }));
      }
    },
    config: {
      async read() {
        events.push("read");
        return { approval: "never" };
      },
      async applyControl() {
        events.push("config-write");
        return { approval: "ask" };
      }
    },
    follower: fakeFollower(events),
    appServer: fakeAppServer(events),
    resolveCliPath: fakeCliResolver(events)
  });

  assert.deepEqual(result, {
    mode: "dry-run",
    targetCount: 6,
    updatedCount: 0,
    globalChanged: false,
    globalWouldChange: true
  });
  assert.equal(events.includes("config-write"), false);
  assert.equal(events.includes("start"), false);
  assert.equal(events.includes("app-start"), false);
  assert.equal(events.includes("app-stop"), false);
  assert.equal(events.some((event) => event.startsWith("update:")), false);
});

test("apply requires app-server persistence for all six exact task approvals", async () => {
  const events: string[] = [];
  const patches: unknown[] = [];
  const appRequests: AppRequest[] = [];
  const follower = fakeFollower(events, patches);
  const result = await runApprovalAskMigration({
    provider: {
      async listRecentThreads() {
        return IDS.map((id) => ({ id }));
      }
    },
    config: {
      async read() {
        return { approval: "never" };
      },
      async applyControl(role: string, value: string) {
        events.push(`config:${role}:${value}`);
        return { approval: "ask" };
      }
    },
    follower,
    appServer: fakeAppServer(events, appRequests),
    resolveCliPath: fakeCliResolver(events)
  }, { apply: true, connectionTimeoutMs: 100 });

  assert.deepEqual(result, {
    mode: "apply",
    targetCount: 6,
    updatedCount: 6,
    globalChanged: true,
    globalWouldChange: false
  });
  assert.deepEqual(events, [
    `desired:${IDS.join(",")}`,
    "start",
    "config:approval:ask",
    ...IDS.map((id) => `update:${id}`),
    "resolve-cli",
    `app-start:${TEST_CLI_PATH}:experimental`,
    ...IDS.flatMap((id) => [
      `app:thread/resume:${id}`,
      `app:thread/settings/update:${id}`
    ]),
    "app-stop",
    "stop"
  ]);
  assert.equal(patches.length, 6);
  for (const patch of patches) assert.deepEqual(patch, APPROVAL_ASK_PATCH);
  assertPersistentRequests(appRequests, IDS, 15_000);
});

test("follower hot-apply failures do not narrow the six-task persistence set", async () => {
  const events: string[] = [];
  const follower = fakeFollower(events);
  const appRequests: AppRequest[] = [];
  const hotApplyFailureIds = new Set([IDS[1], IDS[3], IDS[5]]);
  follower.updateThreadSettings = async (id: string) => {
    events.push(`update:${id}`);
    if (hotApplyFailureIds.has(id)) throw new Error("simulated follower miss");
  };

  const result = await runApprovalAskMigration({
    provider: { async listRecentThreads() { return IDS.map((id) => ({ id })); } },
    config: {
      async read() { return { approval: "ask" }; },
      async applyControl() {
        throw new Error("must not write an already-Ask global setting");
      }
    },
    follower,
    appServer: fakeAppServer(events, appRequests),
    resolveCliPath: fakeCliResolver(events)
  }, {
    apply: true,
    connectionTimeoutMs: 100,
    appServerRequestTimeoutMs: 3210
  });

  assert.equal(result.updatedCount, 6);
  assert.equal(events.filter((event) => event.startsWith("update:")).length, 6);
  assert.deepEqual(events.slice(-4), [
    `app:thread/resume:${IDS[5]}`,
    `app:thread/settings/update:${IDS[5]}`,
    "app-stop",
    "stop"
  ]);
  assert.equal(events.includes(`app-start:${TEST_CLI_PATH}:experimental`), true);
  assertPersistentRequests(appRequests, IDS, 3210);
});

test("follower success cannot hide one app-server persistence failure", async () => {
  const events: string[] = [];
  const follower = fakeFollower(events);
  const appServer = fakeAppServer(events);
  appServer.request = async (method: string, params: unknown) => {
    const threadId = (params as { threadId: string }).threadId;
    events.push(`app:${method}:${threadId}`);
    if (method === "thread/settings/update" && threadId === IDS[2]) {
      throw new Error("simulated app-server miss");
    }
    return {};
  };

  await assert.rejects(
    () => runApprovalAskMigration({
      provider: { async listRecentThreads() { return IDS.map((id) => ({ id })); } },
      config: {
        async read() { return { approval: "ask" }; },
        async applyControl() {
          throw new Error("must not write an already-Ask global setting");
        }
      },
      follower,
      appServer,
      resolveCliPath: fakeCliResolver(events)
    }, { apply: true, connectionTimeoutMs: 100 }),
    /5\/6/
  );
  assert.equal(events.filter((event) => event.startsWith("update:")).length, 6);
  assert.equal(
    events.filter((event) => event.startsWith("app:thread/resume:")).length,
    6
  );
  assert.equal(
    events.filter((event) => event.startsWith("app:thread/settings/update:")).length,
    6
  );
  assert.deepEqual(events.slice(-2), ["app-stop", "stop"]);
});

test("an unavailable Desktop follower remains best effort while app-server persists all six", async () => {
  const events: string[] = [];
  const follower = fakeFollower(events);
  follower.start = () => {
    events.push("start");
    throw new Error("simulated Desktop IPC outage");
  };
  const appRequests: AppRequest[] = [];

  const result = await runApprovalAskMigration({
    provider: { async listRecentThreads() { return IDS.map((id) => ({ id })); } },
    config: {
      async read() { return { approval: "ask" }; },
      async applyControl() {
        throw new Error("must not write an already-Ask global setting");
      }
    },
    follower,
    appServer: fakeAppServer(events, appRequests),
    resolveCliPath: fakeCliResolver(events)
  }, { apply: true, connectionTimeoutMs: 10 });

  assert.equal(result.updatedCount, 6);
  assert.equal(events.some((event) => event.startsWith("update:")), false);
  assertPersistentRequests(appRequests, IDS, 15_000);
  assert.deepEqual(events.slice(-2), ["app-stop", "stop"]);
});

function fakeFollower(events: string[], patches: unknown[] = []) {
  return {
    isConnected: false,
    start() {
      events.push("start");
      this.isConnected = true;
    },
    stop() {
      events.push("stop");
      this.isConnected = false;
    },
    onChange() {
      return () => undefined;
    },
    setDesiredConversations(ids: readonly string[]) {
      events.push(`desired:${ids.join(",")}`);
    },
    async updateThreadSettings(id: string, patch: unknown) {
      events.push(`update:${id}`);
      patches.push(structuredClone(patch));
    }
  };
}

type AppRequest = {
  method: string;
  params: unknown;
  timeoutMs: number | undefined;
};

function assertPersistentRequests(
  requests: AppRequest[],
  expectedIds: readonly string[],
  timeoutMs: number
) {
  assert.equal(requests.length, expectedIds.length * 2);
  for (let index = 0; index < requests.length; index += 2) {
    const resume = requests[index];
    const update = requests[index + 1];
    const expectedId = expectedIds[index / 2];
    assert.deepEqual(resume, {
      method: "thread/resume",
      params: { threadId: expectedId, excludeTurns: true },
      timeoutMs
    });
    assert.deepEqual(update, {
      method: "thread/settings/update",
      params: {
        threadId: expectedId,
        approvalPolicy: "on-request",
        approvalsReviewer: "user"
      },
      timeoutMs
    });
    assert.deepEqual(
      Object.keys(update!.params as Record<string, unknown>).sort(),
      ["approvalPolicy", "approvalsReviewer", "threadId"]
    );
  }
}

function fakeAppServer(events: string[], requests: AppRequest[] = []) {
  return {
    async start(
      cliPath: string,
      options: { experimentalApi?: boolean }
    ) {
      events.push(
        `app-start:${cliPath}:${options.experimentalApi ? "experimental" : "standard"}`
      );
    },
    async request(method: string, params: unknown, timeoutMs?: number) {
      const threadId = (params as { threadId?: string }).threadId ?? "none";
      events.push(`app:${method}:${threadId}`);
      requests.push({
        method,
        params: structuredClone(params),
        timeoutMs
      });
      return {};
    },
    async stop() {
      events.push("app-stop");
    }
  };
}

function fakeCliResolver(events: string[]) {
  return async () => {
    events.push("resolve-cli");
    return TEST_CLI_PATH;
  };
}
