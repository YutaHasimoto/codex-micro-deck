import assert from "node:assert/strict";
import test from "node:test";

import {
  commandPaletteAppleScript,
  parseShortcut,
  shortcutAppleScript
} from "../src/codex/shortcut.ts";
import { dictationButtonAppleScript } from "../src/codex/accessibility-controller.ts";
import { StableCodexController } from "../src/codex/stable-controller.ts";

test("shortcut parser accepts only the small supported key grammar", () => {
  assert.deepEqual(parseShortcut("cmd+shift+p"), {
    key: "p",
    modifiers: ["command", "shift"]
  });
  assert.equal(parseShortcut("cmd+$(open bad.example)"), undefined);
  assert.equal(parseShortcut("cmd+q; open bad.example"), undefined);
});

test("shortcut scripts contain a literal key action, never a shell command", () => {
  const script = shortcutAppleScript(parseShortcut("cmd+[")!);
  assert.match(script, /keystroke "\[" using \{command down\}/);
  assert.match(script, /if not frontmost then error/);
  assert.match(script, /count of windows/);
  assert.doesNotMatch(script, /do shell script/);
});

test("command palette labels are encoded as one AppleScript string literal", () => {
  const script = commandPaletteAppleScript('x"\\\nend tell');
  assert.match(script, /keystroke "x\\"\\\\\\nend tell"/);
  assert.doesNotMatch(script, /do shell script/);
  assert.match(script, /keystroke "k" using \{command down\}/);
  assert.match(script, /AXFocusedUIElement/);
  assert.match(script, /Codex did not become ready/);
  assert.match(script, /command palette did not receive focus/);
  assert.match(script, /command palette lost focus/);
  assert.match(script, /key code 36/);
});

test("disabled key control blocks System Events before spawning osascript", async () => {
  let processCalls = 0;
  const controller = new StableCodexController({
    async processRunner() {
      processCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  });
  controller.accessibilityEnabled = false;
  await assert.rejects(() => controller.runShortcutText("cmd+b"), /disabled/);
  await assert.rejects(() => controller.runPaletteCommand("fast"), /disabled/);
  await assert.rejects(() => controller.startDictation(), /disabled/);
  await assert.rejects(() => controller.stopDictation("send"), /disabled/);
  assert.equal(processCalls, 0);
});

test("dictation AX scripts target the ChatGPT main composer and never type a fallback", () => {
  const cases = [
    ["start", ["音声入力", "Dictate"]],
    ["insert", ["音声入力を停止", "Stop dictation"]],
    ["send", ["文字起こしして送信する", "Transcribe and send"]]
  ] as const;

  for (const [action, labels] of cases) {
    const script = dictationButtonAppleScript(action);
    for (const label of labels) assert.match(script, new RegExp(label));
    assert.match(script, /windowTitle is "ChatGPT"/);
    assert.match(script, /attribute "AXMain"/);
    assert.match(script, /attribute "AXChildren"/);
    assert.match(script, /Codex composer accessibility path changed/);
    assert.match(script, /role of itemRef as text\) is "AXButton"/);
    assert.match(script, /enabled of itemRef as boolean\) is true/);
    assert.match(script, /set itemVisible to true/);
    assert.match(script, /set itemVisible to visible of itemRef as boolean/);
    assert.match(script, /if \(count of matchedItems\) > 1 then error/);
    assert.match(script, /perform action "AXPress"/);
    assert.doesNotMatch(script, /front window|entire contents|labelText contains|keystroke|key code|do shell script/);
  }
});

test("stable dictation controls press Codex start, insert, and send buttons through one UI queue", async () => {
  const scripts: string[] = [];
  const controller = new StableCodexController({
    async processRunner(command, args) {
      assert.equal(command, "/usr/bin/osascript");
      scripts.push(args[1] ?? "");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  });

  await controller.startDictation();
  await controller.stopDictation("insert");
  await controller.stopDictation("send");

  assert.match(scripts[0] ?? "", /"音声入力", "Dictate"/);
  assert.match(scripts[1] ?? "", /"音声入力を停止", "Stop dictation"/);
  assert.match(scripts[2] ?? "", /"文字起こしして送信する", "Transcribe and send"/);
});

test("stable dictation failures expose only a classified reason and exit code", async () => {
  const controller = new StableCodexController({
    async processRunner() {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "/Users/private/task/secret Codex composer accessibility path changed\nsecond line"
      };
    }
  });

  await assert.rejects(
    () => controller.startDictation(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Codex dictation accessibility action failed: start (composer-path-changed; exit 1)"
      );
      assert.doesNotMatch(error.message, /Users|secret|second line/);
      return true;
    }
  );
});

test("successful agent double presses are serialized and the second opens in front", async () => {
  const calls: string[][] = [];
  let now = 1_000;
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let invocation = 0;
  const controller = new StableCodexController({
    now: () => now,
    async processRunner(_command, args) {
      calls.push([...args]);
      invocation += 1;
      if (invocation === 1) await firstPending;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  });
  const id = "a".repeat(16);
  const first = controller.openThread(id);
  now = 1_200;
  const second = controller.openThread(id);
  await Promise.resolve();
  releaseFirst?.();
  assert.equal(await first, "background");
  assert.equal(await second, "foreground");
  assert.deepEqual(calls, [
    ["-g", `codex://threads/${id}`],
    [`codex://threads/${id}`]
  ]);
});

test("a failed first deep link never arms foreground mode for the retry", async () => {
  const calls: string[][] = [];
  let now = 2_000;
  let invocation = 0;
  const controller = new StableCodexController({
    now: () => now,
    async processRunner(_command, args) {
      calls.push([...args]);
      invocation += 1;
      return { exitCode: invocation === 1 ? 1 : 0, stdout: "", stderr: "" };
    }
  });
  const id = "b".repeat(16);
  await assert.rejects(() => controller.openThread(id), /Could not open/);
  now = 2_100;
  assert.equal(await controller.openThread(id), "background");
  assert.deepEqual(calls, [
    ["-g", `codex://threads/${id}`],
    ["-g", `codex://threads/${id}`]
  ]);
});

// Approvals no longer synthesize Enter/Escape keystrokes: decisions travel over
// the Codex Desktop IPC follower (see tests/desktop-follower.test.ts), so the
// controller intentionally has no approval entry points anymore.
