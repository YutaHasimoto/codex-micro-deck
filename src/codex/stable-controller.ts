import {
  commandPaletteAppleScript,
  parseShortcut,
  shortcutAppleScript,
  type ParsedShortcut
} from "./shortcut.js";
import {
  dictationButtonAppleScript,
  type DictationButtonAction
} from "./accessibility-controller.js";
import { runProcess, type ProcessResult } from "../system/process.js";

export type StableCommand = "submit" | "new-chat" | "interrupt";
export type DictationDisposition = "insert" | "send";
export type PaletteCommand =
  | "fast" | "plan" | "fork" | "skills" | "review"
  | "reasoning-open" | "reasoning-up" | "reasoning-down";

const OFFICIAL_SHORTCUTS: Record<StableCommand, string> = {
  submit: "return",
  "new-chat": "cmd+n",
  interrupt: "escape"
};

/** Exact Japanese command labels embedded in the current Codex desktop app. */
const PALETTE_LABELS: Record<PaletteCommand, string> = {
  fast: "高速モードを切り替え",
  plan: "プランモードの切り替え",
  fork: "新しいタスクで続ける",
  skills: "スキルに移動",
  review: "レビュータブを開く",
  "reasoning-open": "推論の負荷を切り替える",
  "reasoning-up": "推論の負荷を上げる",
  "reasoning-down": "推論の負荷を下げる"
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
    await this.#enqueueUi(async () => {
      const result = await this.#processRunner(
        "/usr/bin/osascript",
        ["-e", commandPaletteAppleScript(PALETTE_LABELS[command])],
        { timeoutMs: 3500, maxOutputBytes: 16 * 1024 }
      );
      if (result.exitCode !== 0) throw new Error(`Codex command palette action failed: ${command}`);
    });
  }

  async navigate(direction: "back" | "forward"): Promise<void> {
    await this.runShortcutText(direction === "back" ? "cmd+[" : "cmd+]");
  }

  async startDictation(): Promise<void> {
    await this.#pressDictationButton("start");
  }

  async stopDictation(disposition: DictationDisposition): Promise<void> {
    await this.#pressDictationButton(disposition);
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

  async #pressDictationButton(action: DictationButtonAction): Promise<void> {
    this.#requireAccessibility();
    await this.#enqueueUi(async () => {
      const result = await this.#processRunner(
        "/usr/bin/osascript",
        ["-e", dictationButtonAppleScript(action)],
        { timeoutMs: 3500, maxOutputBytes: 16 * 1024 }
      );
      if (result.exitCode !== 0) {
        const reason = classifyDictationFailure(result);
        throw new Error(
          `Codex dictation accessibility action failed: ${action} (${reason}; exit ${result.exitCode})`
        );
      }
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
  if (diagnostic.includes("composer accessibility path changed")) return "composer-path-changed";
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
