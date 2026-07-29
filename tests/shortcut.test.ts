import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseShortcut,
  shortcutAppleScript
} from "../src/codex/shortcut.ts";
import {
  DICTATION_PRESS_MARKER,
  dictationButtonAppleScript
} from "../src/codex/accessibility-controller.ts";
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

test("shortcut source contains no command-palette typing or Return path", () => {
  const source = readFileSync(
    new URL("../src/codex/shortcut.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /commandPaletteAppleScript|command palette|AXFocusedUIElement|AXValue|JSON\.stringify\(label\)|keystroke "k" using \{command down\}|"    key code 36"/i
  );
});

test("palette commands fail closed without spawning even when accessibility is enabled", async () => {
  let processCalls = 0;
  const controller = new StableCodexController({
    async processRunner() {
      processCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  });

  await assert.rejects(
    () => controller.runPaletteCommand("fast"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Codex command palette action is unavailable because the selected command row cannot be verified: fast"
      );
      return true;
    }
  );
  assert.equal(processCalls, 0);
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

test("dictation scripts target only the bounded composer and never use the command palette", () => {
  const cases = [
    ["start", ["音声入力", "Dictate", "音声入力を再試行", "Retry dictation"]],
    ["insert", ["音声入力を停止", "Stop dictation"]],
    ["send", ["文字起こしして送信する", "Transcribe and send"]]
  ] as const;

  for (const [action, labels] of cases) {
    const script = dictationButtonAppleScript(action);
    for (const label of labels) assert.match(script, new RegExp(label));
    assert.match(script, /windowTitle is "ChatGPT"/);
    assert.match(script, /attribute "AXMain"/);
    assert.match(script, /attribute "AXChildren"/);
    assert.doesNotMatch(script, /entire contents of composerRoot/);
    assert.match(script, /Codex composer accessibility path changed/);
    assert.match(script, /set itemRole to role of itemRef as text/);
    assert.match(script, /if itemRole is "AXButton" then/);
    assert.match(script, /set itemEnabled to enabled of itemRef as boolean/);
    assert.match(script, /set itemTitle to title of itemRef as text/);
    assert.match(script, /set itemDescription to description of itemRef as text/);
    assert.match(script, /perform action "AXPress"/);
    assert.match(script, /with timeout of 1 second/);
    assert.doesNotMatch(
      script,
      /visible of itemRef|itemVisible|keystroke|key code 36|AXFocusedUIElement|AXValue|paletteCommand|command palette|labelText contains|do shell script/
    );
    assert.ok(
      script.indexOf(DICTATION_PRESS_MARKER) < script.indexOf('perform action "AXPress"'),
      `${action} must log before AXPress`
    );
  }
});

test("accessibility controller source has no legacy fuzzy global AX scan", () => {
  const source = readFileSync(
    new URL("../src/codex/accessibility-controller.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /labelText contains|entire contents of front window/);
  assert.doesNotMatch(source, /MacAccessibilityController|AccessibleTarget|clickElementScript/);
});

test("dictation start prefers an exact localized Edit menu item and has one direct fallback", () => {
  const start = dictationButtonAppleScript("start");
  assert.ok(start.includes("\u2026"), "menu labels must contain the U+2026 ellipsis");
  assert.match(
    start,
    /menu item "音声入力を開始…" of menu 1 of menu bar item "編集" of menu bar 1/
  );
  assert.match(
    start,
    /menu item "Start Dictation…" of menu 1 of menu bar item "Edit" of menu bar 1/
  );
  assert.equal(occurrences(start, "set menuItemRef to menu item"), 4);
  assert.doesNotMatch(
    start,
    /repeat with menuBarItemRef|repeat with menuItemRef|menu bar items of|menu items of/
  );
  assert.match(start, /if \(count of startMenuItems\) is 1 then/);
  assert.match(start, /perform action "AXPress" of item 1 of startMenuItems/);
  assert.match(start, /else\n\s+log "CODEX_MICRO_DECK_DICTATION_AXPRESS"/);
  assert.match(start, /perform action "AXPress" of item 1 of idleItems/);
  assert.equal(occurrences(start, 'perform action "AXPress"'), 2);
  assert.doesNotMatch(start, /Start dictation"|"音声入力を開始"/);
});

test("dictation scans labels in memory with a bounded static cost", () => {
  const start = dictationButtonAppleScript("start");
  assert.equal(occurrences(start, "repeat with itemRef in"), 2);
  assert.equal(occurrences(start, "repeat with childIndex in"), 1);
  assert.match(start, /idleLabels contains itemTitle/);
  assert.match(start, /activeLabels contains itemDescription/);
  assert.doesNotMatch(start, /repeat with (?:candidate|idle|active)Label/);
  assert.doesNotMatch(start, /visible of itemRef/);

  for (const action of ["insert", "send"] as const) {
    const script = dictationButtonAppleScript(action);
    assert.equal(occurrences(script, "repeat with itemRef in"), 1);
    assert.equal(occurrences(script, "repeat with childIndex in"), 1);
    assert.match(script, /targetLabels contains itemTitle/);
    assert.match(script, /idleLabels contains itemDescription/);
    assert.doesNotMatch(script, /repeat with (?:candidate|idle|active)Label/);
    assert.doesNotMatch(script, /visible of itemRef/);
  }
});

test("dictation start reconciles active state and confirms without walking the fixed path again", () => {
  const start = dictationButtonAppleScript("start");
  assert.match(start, /set composerBranch to item 3 of rootChildren/);
  assert.match(start, /"音声入力を停止", "Stop dictation", "文字起こしして送信する", "Transcribe and send"/);
  assert.match(start, /if \(count of activeItems\) is 1 then return "already-active"/);
  assert.match(start, /return "already-active"/);
  assert.match(start, /repeat 3 times/);
  assert.match(start, /entire contents of composerBranch/);
  assert.match(start, /return "start-confirmed"/);
  assert.match(start, /Codex dictation start was not confirmed/);
  assert.equal(occurrences(start, "set composerRoot to item 1 of candidateWindows"), 1);
});

test("dictation stop classifies target and idle together and never retries an uncertain press", () => {
  for (const action of ["insert", "send"] as const) {
    const script = dictationButtonAppleScript(action);
    assert.match(script, /set targetItems to \{\}/);
    assert.match(script, /set idleItems to \{\}/);
    assert.match(script, /"音声入力", "Dictate", "音声入力を再試行", "Retry dictation"/);
    assert.match(script, /if \(count of targetItems\) is 1 and \(count of idleItems\) is 1 then error/);
    assert.match(script, /if errorNumber is -1712 then return "press-indeterminate"/);
    assert.match(script, /return "pressed"/);
    assert.match(script, /return "already-idle"/);
    assert.equal(occurrences(script, 'perform action "AXPress"'), 1);
  }
  assert.doesNotMatch(dictationButtonAppleScript("start"), /return "already-idle"/);
});

test("stable dictation controls return only strict action-specific stdout tokens", async () => {
  const scripts: string[] = [];
  const timeouts: number[] = [];
  const results = [
    "start-confirmed\n",
    "already-active\n",
    "pressed\n",
    "already-idle\n"
  ];
  const controller = new StableCodexController({
    async processRunner(command, args, options) {
      assert.equal(command, "/usr/bin/osascript");
      scripts.push(args[1] ?? "");
      timeouts.push(options?.timeoutMs ?? 0);
      return { exitCode: 0, stdout: results.shift() ?? "", stderr: "" };
    }
  });

  assert.equal(await controller.startDictation(), "start-confirmed");
  assert.equal(await controller.startDictation(), "already-active");
  assert.equal(await controller.stopDictation("insert"), "pressed");
  assert.equal(await controller.stopDictation("send"), "already-idle");

  assert.match(scripts[0] ?? "", /"音声入力を開始…"/);
  assert.match(scripts[0] ?? "", /return "start-confirmed"/);
  assert.match(scripts[2] ?? "", /"音声入力を停止", "Stop dictation"/);
  assert.match(scripts[3] ?? "", /"文字起こしして送信する", "Transcribe and send"/);
  assert.deepEqual(timeouts, [10_000, 10_000, 8_000, 8_000]);
});

test("a timed-out dictation AX scan never retries a non-idempotent press", async () => {
  let invocations = 0;
  const controller = new StableCodexController({
    async processRunner(command, _args, options) {
      assert.equal(command, "/usr/bin/osascript");
      assert.equal(options?.timeoutMs, 8_000);
      invocations += 1;
      return { exitCode: -1, stdout: "", stderr: "" };
    }
  });

  await assert.rejects(
    () => controller.stopDictation("send"),
    /send \(timed-out; exit -1\)/
  );
  assert.equal(invocations, 1);
});

test("a timed-out dictation start is not retried after it might have begun recording", async () => {
  let invocations = 0;
  const controller = new StableCodexController({
    async processRunner(_command, _args, options) {
      assert.equal(options?.timeoutMs, 10_000);
      invocations += 1;
      return { exitCode: -1, stdout: "", stderr: "" };
    }
  });

  await assert.rejects(
    () => controller.startDictation(),
    /start \(timed-out; exit -1\)/
  );
  assert.equal(invocations, 1);
});

test("a marker-bearing outer timeout is classified as press-indeterminate", async () => {
  const controller = new StableCodexController({
    async processRunner() {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `(*${DICTATION_PRESS_MARKER}*)`
      };
    }
  });

  await assert.rejects(
    () => controller.stopDictation("send"),
    /send \(press-indeterminate; exit -1\)/
  );
});

test("empty, unknown, noisy, and indeterminate stdout tokens fail closed", async () => {
  const cases = [
    ["", "empty-result"],
    ["unknown-token\n", "invalid-result"],
    ["pressed\nextra-output\n", "invalid-result"],
    ["press-indeterminate\n", "press-indeterminate"]
  ] as const;

  for (const [stdout, reason] of cases) {
    const controller = new StableCodexController({
      async processRunner() {
        return { exitCode: 0, stdout, stderr: "" };
      }
    });
    await assert.rejects(
      () => controller.stopDictation("send"),
      new RegExp(`send \\(${reason}; exit 0\\)`)
    );
  }
});

test("already-idle is returned as a distinct no-send outcome", async () => {
  const controller = new StableCodexController({
    async processRunner() {
      return { exitCode: 0, stdout: "already-idle\n", stderr: "" };
    }
  });

  assert.equal(await controller.stopDictation("send"), "already-idle");
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

test("an unconfirmed dictation start is classified and never treated as listening", async () => {
  const controller = new StableCodexController({
    async processRunner() {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Codex dictation start was not confirmed (-1708)"
      };
    }
  });

  await assert.rejects(
    () => controller.startDictation(),
    /start \(start-not-confirmed; exit 1\)/
  );
});

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

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
