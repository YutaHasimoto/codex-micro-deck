import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CODEX_CLI_CANDIDATES,
  THREAD_NAME_LIST_LIMIT,
  resolveCodexCliPath
} from "../src/codex/app-server-client.ts";

test("thread name discovery requests enough rows to cover six local user tasks", () => {
  assert.equal(THREAD_NAME_LIST_LIMIT, 100);
  assert.ok(THREAD_NAME_LIST_LIMIT >= 6);
});

test("Codex CLI resolution requires an executable absolute codex path", async () => {
  const checked: string[] = [];
  const resolved = await resolveCodexCliPath(
    ["/tmp/not-codex", "/Applications/ChatGPT.app/Contents/Resources/codex"],
    async (candidate) => {
      checked.push(candidate);
      return true;
    }
  );

  assert.equal(resolved, "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.deepEqual(checked, ["/Applications/ChatGPT.app/Contents/Resources/codex"]);
  await assert.rejects(
    () => resolveCodexCliPath(["relative/codex"], async () => true),
    /bundled CLI was not found/
  );
});

test("default CLI discovery supports both layouts while preserving ChatGPT app preference", async (t) => {
  const currentChatGpt = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  const currentCodex = "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex";
  const legacyChatGpt = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const legacyCodex = "/Applications/Codex.app/Contents/Resources/codex";
  const cases = [
    { available: [currentChatGpt], expected: currentChatGpt },
    { available: [currentCodex], expected: currentCodex },
    { available: [currentChatGpt, currentCodex, legacyChatGpt, legacyCodex], expected: currentChatGpt },
    { available: [currentCodex, legacyChatGpt], expected: legacyChatGpt },
    { available: [legacyChatGpt, legacyCodex], expected: legacyChatGpt },
    { available: [legacyCodex], expected: legacyCodex }
  ];
  for (const { available, expected } of cases) {
    await t.test(`finds ${expected} with ${available.length} available bundle(s)`, async () => {
      assert.equal(
        await resolveCodexCliPath(undefined, async (candidate) => available.includes(candidate)),
        expected
      );
    });
  }
});

test("missing bundled CLIs never fall back to a standalone PATH installation", async () => {
  const standalone = "/opt/homebrew/bin/codex";
  const checked: string[] = [];
  await assert.rejects(
    () => resolveCodexCliPath(undefined, async (candidate) => {
      checked.push(candidate);
      return candidate === standalone;
    }),
    /bundled CLI was not found/
  );
  assert.deepEqual(checked, [...DEFAULT_CODEX_CLI_CANDIDATES]);
  assert.equal(checked.includes(standalone), false);
});
