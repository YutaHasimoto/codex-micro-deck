#!/usr/bin/env node

import { registerHooks } from "node:module";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Production sources use `.js` specifiers for the Rollup build. This standalone
// maintenance tool runs those same TypeScript sources directly on Node 24+.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/src/")
      && specifier.startsWith(".")
      && specifier.endsWith(".js")) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

export const REQUIRED_TARGET_COUNT = 6;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 8_000;
export const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_CODEX_CLI_CANDIDATES = Object.freeze([
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex"
]);
export const APPROVAL_ASK_PATCH = Object.freeze({
  approvalPolicy: "on-request",
  approvalsReviewer: "user"
});

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const APPROVAL_PATCH_KEYS = ["approvalPolicy", "approvalsReviewer"];

export function parseMigrationArgs(argv) {
  const args = new Set(argv);
  for (const value of args) {
    if (value !== "--apply" && value !== "--dry-run" && value !== "--help") {
      throw new Error(`未対応の引数です: ${value}`);
    }
  }
  if (args.has("--apply") && args.has("--dry-run")) {
    throw new Error("--applyと--dry-runは同時に指定できません");
  }
  return {
    apply: args.has("--apply"),
    help: args.has("--help")
  };
}

export function assertApprovalOnlyPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("承認移行パッチがオブジェクトではありません");
  }
  const keys = Object.keys(patch).sort();
  const expected = [...APPROVAL_PATCH_KEYS].sort();
  if (keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])) {
    throw new Error("承認移行パッチに承認以外の設定が含まれています");
  }
  if (patch.approvalPolicy !== "on-request"
    || patch.approvalsReviewer !== "user") {
    throw new Error("承認移行パッチの値がAsk設定ではありません");
  }
  return patch;
}

export function exactRecentThreadIds(threads) {
  if (!Array.isArray(threads)) {
    throw new Error("最近のCodexタスク一覧を取得できませんでした");
  }
  const ids = threads.map((thread) => thread?.id);
  if (ids.length !== REQUIRED_TARGET_COUNT
    || ids.some((id) => typeof id !== "string" || !CONVERSATION_ID_PATTERN.test(id))
    || new Set(ids).size !== REQUIRED_TARGET_COUNT) {
    throw new Error(`移行対象は重複のない最近${REQUIRED_TARGET_COUNT}タスクである必要があります`);
  }
  return ids;
}

export async function waitForFollowerConnection(
  follower,
  timeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS
) {
  if (follower.isConnected) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => undefined;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error("Codex Desktopへの接続がタイムアウトしました"));
    }, timeoutMs);
    unsubscribe = follower.onChange(() => {
      if (follower.isConnected) finish();
    });
    // Cover a connection completing between the first check and listener setup.
    if (follower.isConnected) finish();
  });
}

export async function resolveCodexCliPath(
  candidates = DEFAULT_CODEX_CLI_CANDIDATES,
  canExecute = async (candidate) => {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
) {
  for (const candidate of candidates) {
    if (typeof candidate === "string"
      && candidate.startsWith("/")
      && await canExecute(candidate)) {
      return candidate;
    }
  }
  throw new Error("Codex Desktop同梱のcodex実行ファイルが見つかりませんでした");
}

export async function updateThreadsViaAppServer(
  appServer,
  cliPath,
  conversationIds,
  options = {}
) {
  const timeoutMs = options.requestTimeoutMs
    ?? DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS;
  const failedIds = [];
  let updatedCount = 0;

  await appServer.start(cliPath, { experimentalApi: true });
  for (const conversationId of conversationIds) {
    try {
      // Resume the exact inactive task in this isolated app-server before
      // queueing its next-turn settings. No model, effort, speed, or sandbox
      // fields are included in either request.
      await appServer.request(
        "thread/resume",
        { threadId: conversationId, excludeTurns: true },
        timeoutMs
      );
      await appServer.request(
        "thread/settings/update",
        {
          threadId: conversationId,
          ...assertApprovalOnlyPatch(APPROVAL_ASK_PATCH)
        },
        timeoutMs
      );
      updatedCount += 1;
    } catch {
      failedIds.push(conversationId);
    }
  }
  return { updatedCount, failedIds };
}

export async function runApprovalAskMigration(
  dependencies,
  options = {}
) {
  const apply = options.apply === true;
  const report = options.report ?? (() => undefined);
  const timeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  const appServerRequestTimeoutMs = options.appServerRequestTimeoutMs
    ?? DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS;
  const {
    provider,
    config,
    follower,
    appServer,
    resolveCliPath
  } = dependencies;

  const [threads, before] = await Promise.all([
    provider.listRecentThreads(),
    config.read()
  ]);
  const targetIds = exactRecentThreadIds(threads);
  if (before.approval !== "never" && before.approval !== "ask") {
    throw new Error("現在の承認設定はNeverまたはAskではないため、自動移行を中止しました");
  }

  if (!apply) {
    const result = {
      mode: "dry-run",
      targetCount: targetIds.length,
      updatedCount: 0,
      globalChanged: false,
      globalWouldChange: before.approval === "never"
    };
    report(result);
    return result;
  }

  assertApprovalOnlyPatch(APPROVAL_ASK_PATCH);
  try {
    // Follower updates keep the currently owned Desktop task hot, but that
    // in-memory success is not proof that the task's next resume will use the
    // setting. Treat the complete follower path as best effort only.
    let followerReady = false;
    try {
      follower.setDesiredConversations(targetIds);
      follower.start();
      await waitForFollowerConnection(follower, timeoutMs);
      followerReady = true;
    } catch {
      // The isolated app-server path below remains authoritative.
    }

    let globalChanged = false;
    if (before.approval === "never") {
      const after = await config.applyControl("approval", "ask");
      if (after.approval !== "ask") {
        throw new Error("新規タスクの承認設定をAskへ保存できませんでした");
      }
      globalChanged = true;
    }

    if (followerReady) {
      for (const conversationId of targetIds) {
        try {
          // CodexDesktopFollower sends the supplied conversationId verbatim.
          // A successful response refreshes current Desktop memory only; final
          // migration success is never counted from this path.
          await follower.updateThreadSettings(
            conversationId,
            assertApprovalOnlyPatch(APPROVAL_ASK_PATCH)
          );
        } catch {
          // Inactive/unowned Desktop tasks are expected to reject this path.
        }
      }
    }

    // Every task must be resumed and updated by app-server. This is the
    // persistence boundary used for the final success count, even when the
    // follower already reported a hot in-memory success for the current task.
    const cliPath = await resolveCliPath();
    const persistent = await updateThreadsViaAppServer(
      appServer,
      cliPath,
      targetIds,
      { requestTimeoutMs: appServerRequestTimeoutMs }
    );
    const updatedCount = persistent.updatedCount;
    if (persistent.failedIds.length) {
      throw new Error(
        `既存タスクの承認設定は${updatedCount}/${targetIds.length}件だけ更新されました。再実行できます`
      );
    }

    const result = {
      mode: "apply",
      targetCount: targetIds.length,
      updatedCount,
      globalChanged,
      globalWouldChange: false
    };
    report(result);
    return result;
  } finally {
    try {
      await appServer.stop();
    } finally {
      follower.stop();
    }
  }
}

export function formatMigrationResult(result) {
  if (result.mode === "dry-run") {
    return `ドライラン: 対象${result.targetCount}件、更新0件、標準設定${result.globalWouldChange ? "Never→Ask予定" : "変更不要"}`;
  }
  return `移行完了: 対象${result.targetCount}件、更新${result.updatedCount}件、標準設定${result.globalChanged ? "Never→Ask" : "変更不要"}`;
}

async function createDefaultDependencies() {
  const [
    { LocalCodexStateProvider },
    { CodexConfigController },
    { CodexDesktopFollower },
    { CodexAppServerClient }
  ] = await Promise.all([
    import("../src/codex/local-state-provider.ts"),
    import("../src/codex/config-controller.ts"),
    import("../src/codex/desktop-follower.ts"),
    import("../src/codex/app-server-client.ts")
  ]);
  return {
    provider: new LocalCodexStateProvider(),
    config: new CodexConfigController(),
    follower: new CodexDesktopFollower(),
    appServer: new CodexAppServerClient(),
    resolveCliPath: () => resolveCodexCliPath()
  };
}

async function main() {
  const parsed = parseMigrationArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log("使い方: node scripts/migrate-approval-ask.mjs [--dry-run | --apply]");
    console.log("引数なしではドライランになり、設定や既存タスクを変更しません。");
    return;
  }
  const dependencies = await createDefaultDependencies();
  const result = await runApprovalAskMigration(dependencies, {
    apply: parsed.apply
  });
  console.log(formatMigrationResult(result));
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryPath === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "不明なエラー";
    console.error(`移行に失敗しました: ${message}`);
    process.exitCode = 1;
  });
}
