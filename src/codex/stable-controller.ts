import {
  parseShortcut,
  shortcutAppleScript,
  type ParsedShortcut
} from "./shortcut.js";
import {
  DICTATION_PRESS_MARKER,
  dictationButtonAppleScript,
  type DictationButtonAction
} from "./accessibility-controller.js";
import { runProcess, type ProcessResult } from "../system/process.js";

export type StableCommand = "submit" | "new-chat" | "interrupt";
export type DictationDisposition = "insert" | "send";
export type DictationStartResult = "start-confirmed" | "already-active";
export type DictationStopResult = "pressed" | "already-idle";
export type PaletteCommand =
  | "fast" | "plan" | "fork" | "skills" | "review"
  | "reasoning-open" | "reasoning-up" | "reasoning-down";

const OFFICIAL_SHORTCUTS: Record<StableCommand, string> = {
  submit: "return",
  "new-chat": "cmd+n",
  interrupt: "escape"
};

type ProcessRunner = typeof runProcess;
type StableControllerOptions = {
  processRunner?: ProcessRunner;
  now?: () => number;
};

export class StableCodexController {
  readonly #processRunner: ProcessRunner;
  readonly #now: () => number;
  #lastSuccessfulThreadPress: { threadId: string; pressedAt: number } | undefined;
  #threadOpenQueue: Promise<void> = Promise.resolve();
  #uiQueue: Promise<void> = Promise.resolve();
  accessibilityEnabled = true;

  constructor(options: StableControllerOptions = {}) {
    this.#processRunner = options.processRunner ?? runProcess;
    this.#now = options.now ?? Date.now;
  }

  async openThread(threadId: string): Promise<"background" | "foreground"> {
    validateThreadId(threadId);
    const pressedAt = this.#now();
    return this.#enqueueThreadOpen(async () => {
      const previous = this.#lastSuccessfulThreadPress;
      const foreground = previous?.threadId === threadId
        && pressedAt >= previous.pressedAt
        && pressedAt - previous.pressedAt <= 350;
      const url = threadUrl(threadId);
      const result = await this.#processRunner("/usr/bin/open", foreground ? [url] : ["-g", url]);
      if (result.exitCode !== 0) throw new Error("Could not open the Codex thread");
      this.#lastSuccessfulThreadPress = { threadId, pressedAt };
      return foreground ? "foreground" : "background";
    });
  }

  async openApp(): Promise<void> {
    const result = await this.#processRunner("/usr/bin/open", ["-b", "com.openai.codex"]);
    if (result.exitCode !== 0) throw new Error("Could not open Codex");
  }

  async runCommand(command: StableCommand, override?: string): Promise<void> {
    const parsed = parseShortcut(override || OFFICIAL_SHORTCUTS[command]);
    if (!parsed) throw new Error("Invalid shortcut setting");
    await this.runShortcut(parsed);
  }

  async runShortcut(shortcut: ParsedShortcut): Promise<void> {
    this.#requireAccessibility();
    await this.#enqueueUi(() => this.#runShortcutNow(shortcut));
  }

  async runShortcutText(value: string): Promise<void> {
    const parsed = parseShortcut(value);
    if (!parsed) throw new Error("Invalid shortcut setting");
    await this.runShortcut(parsed);
  }

  async runPaletteCommand(command: PaletteCommand): Promise<void> {
    this.#requireAccessibility();
    throw new Error(
      `Codex command palette action is unavailable because the selected command row cannot be verified: ${command}`
    );
  }

  async navigate(direction: "back" | "forward"): Promise<void> {
    await this.runShortcutText(direction === "back" ? "cmd+[" : "cmd+]");
  }

  async startDictation(): Promise<DictationStartResult> {
    const result = await this.#pressDictationButton("start");
    if (result === "start-confirmed" || result === "already-active") return result;
    throw new Error("Unreachable dictation start result");
  }

  async stopDictation(disposition: DictationDisposition): Promise<DictationStopResult> {
    const result = await this.#pressDictationButton(disposition);
    if (result === "pressed" || result === "already-idle") return result;
    throw new Error("Unreachable dictation stop result");
  }

  #requireAccessibility(): void {
    if (!this.accessibilityEnabled) {
      throw new Error("Codex keyboard control is disabled in plugin settings");
    }
  }

  async #runShortcutNow(shortcut: ParsedShortcut, settleDelaySeconds = 0.08): Promise<void> {
    const result = await this.#processRunner(
      "/usr/bin/osascript",
      ["-e", shortcutAppleScript(shortcut, settleDelaySeconds)],
      { timeoutMs: 3500, maxOutputBytes: 16 * 1024 }
    );
    if (result.exitCode !== 0) throw new Error("Codex keyboard shortcut failed");
  }

  async #pressDictationButton(
    action: DictationButtonAction
  ): Promise<DictationStartResult | DictationStopResult> {
    this.#requireAccessibility();
    return this.#enqueueUi(async () => {
      const result = await this.#processRunner(
        "/usr/bin/osascript",
        ["-e", dictationButtonAppleScript(action)],
        { timeoutMs: action === "start" ? 10_000 : 8_000, maxOutputBytes: 16 * 1024 }
      );
      // Dictation actions are not idempotent. In particular, retrying send
      // after an outer timeout could submit the same transcription twice.
      // The generated AppleScript bounds AXPress acknowledgement separately,
      // so this controller always issues at most one physical press.
      if (result.exitCode !== 0) {
        const reason = classifyDictationFailure(result);
        throw dictationActionError(action, reason, result.exitCode);
      }
      const token = result.stdout.trim();
      if (
        action === "start"
        && (token === "start-confirmed" || token === "already-active")
      ) {
        return token;
      }
      if (
        action !== "start"
        && (token === "pressed" || token === "already-idle")
      ) {
        return token;
      }
      const reason = token === "press-indeterminate"
        ? "press-indeterminate"
        : token.length === 0
          ? "empty-result"
          : "invalid-result";
      throw dictationActionError(action, reason, result.exitCode);
    });
  }

  #enqueueThreadOpen<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#threadOpenQueue.then(operation);
    this.#threadOpenQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  #enqueueUi<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#uiQueue.then(operation);
    this.#uiQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateThreadId(threadId: string): void {
  if (!/^[0-9a-f-]{16,64}$/i.test(threadId)) throw new Error("Invalid Codex thread ID");
}

function threadUrl(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function classifyDictationFailure(result: ProcessResult): string {
  const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.exitCode === -1) {
    return diagnostic.includes(DICTATION_PRESS_MARKER.toLowerCase())
      ? "press-indeterminate"
      : "timed-out";
  }
  if (diagnostic.includes("composer accessibility path changed")) return "composer-path-changed";
  if (diagnostic.includes("dictation start was not confirmed")) return "start-not-confirmed";
  if (diagnostic.includes("dictation control was not found")) return "control-not-found";
  if (diagnostic.includes("dictation control is ambiguous")) return "control-ambiguous";
  if (diagnostic.includes("main window is unavailable or ambiguous")) return "main-window-unavailable";
  if (diagnostic.includes("process is unavailable or ambiguous")) return "process-unavailable";
  if (diagnostic.includes("did not become ready")) return "window-not-ready";
  if (
    diagnostic.includes("-1743")
    || diagnostic.includes("not authorized to send apple events")
    || diagnostic.includes("オートメーション")
  ) {
    return "automation-permission-denied";
  }
  if (
    diagnostic.includes("-25211")
    || diagnostic.includes("assistive access")
    || diagnostic.includes("アクセシビリティ")
  ) {
    return "accessibility-permission-denied";
  }
  return "unknown";
}

function dictationActionError(
  action: DictationButtonAction,
  reason: string,
  exitCode: number
): Error {
  return new Error(
    `Codex dictation accessibility action failed: ${action} (${reason}; exit ${exitCode})`
  );
}
