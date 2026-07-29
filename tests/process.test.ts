import assert from "node:assert/strict";
import test from "node:test";

import { runProcess } from "../src/system/process.ts";

test("runProcess escalates to SIGKILL when a timed-out child ignores SIGTERM", {
  timeout: 3_000
}, async () => {
  const startedAt = Date.now();
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      [
        "process.on('SIGTERM', () => process.stdout.write('sigterm-ignored\\n'));",
        "process.stdout.write('ready\\n');",
        "setInterval(() => {}, 1000);"
      ].join("")
    ],
    { timeoutMs: 500, maxOutputBytes: 4 * 1024 }
  );

  assert.equal(result.exitCode, -1);
  assert.match(result.stdout, /ready/);
  assert.match(result.stdout, /sigterm-ignored/);
  assert.ok(
    Date.now() - startedAt < 2_000,
    "the Promise must settle shortly after the SIGKILL grace period"
  );
});

test("runProcess preserves normal exit results before the timeout", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('ok'); process.stderr.write('note');"],
    { timeoutMs: 1_000, maxOutputBytes: 4 * 1024 }
  );

  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "ok",
    stderr: "note"
  });
});
