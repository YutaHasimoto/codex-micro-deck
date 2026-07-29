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

test("Codex CLI resolution prefers the ChatGPT app bundle and requires an executable codex path", async () => {
  assert.equal(
    DEFAULT_CODEX_CLI_CANDIDATES[0],
    "/Applications/ChatGPT.app/Contents/Resources/codex"
  );
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
