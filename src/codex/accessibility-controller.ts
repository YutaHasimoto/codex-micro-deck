import { runProcess } from "../system/process.js";

export type AccessibleTarget = "fast" | "plan" | "skills" | "review" | "voice" | "fork" | "reasoning";
export type DictationButtonAction = "start" | "insert" | "send";

const LABELS: Record<AccessibleTarget, readonly string[]> = {
  fast: ["Fast", "高速"],
  plan: ["Plan", "計画"],
  skills: ["Skills", "スキル"],
  review: ["Review", "レビュー"],
  voice: ["Voice", "Microphone", "音声", "マイク"],
  fork: ["Fork", "フォーク"],
  reasoning: ["Reasoning", "思考", "推論"]
};

const DICTATION_BUTTON_LABELS: Readonly<Record<DictationButtonAction, readonly string[]>> = {
  start: ["音声入力", "Dictate"],
  insert: ["音声入力を停止", "Stop dictation"],
  send: ["文字起こしして送信する", "Transcribe and send"]
};

/**
 * Electron exposes the composer through a stable chain of AX groups below the
 * main ChatGPT window. Walking this chain is sub-second; asking System Events
 * for `entire contents` takes tens of seconds on a busy Codex window.
 *
 * The final group contains the idle Dictate button and, while recording, the
 * Stop dictation / Transcribe and send buttons.
 */
const COMPOSER_BUTTON_PARENT_PATH = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1,
  1, 1, 1, 1, 2, 1, 1, 2, 2, 3, 1, 1, 1
] as const;

/** UI fallback for controls that have no public deep link or verified shortcut. */
export class MacAccessibilityController {
  enabled = true;

  async press(target: AccessibleTarget): Promise<void> {
    if (!this.enabled) throw new Error("Accessibility fallback is disabled");
    const result = await runProcess("/usr/bin/osascript", ["-e", clickElementScript(LABELS[target])], {
      timeoutMs: 3500,
      maxOutputBytes: 16 * 1024
    });
    if (result.exitCode !== 0) throw new Error(`Codex accessibility action failed: ${target}`);
  }

  async adjustReasoning(direction: "down" | "up"): Promise<void> {
    await this.press("reasoning");
    const keyCode = direction === "up" ? 124 : 123;
    const script = [
      "tell application \"System Events\"",
      `  key code ${keyCode}`,
      "  key code 36",
      "end tell"
    ].join("\n");
    const result = await runProcess("/usr/bin/osascript", ["-e", script]);
    if (result.exitCode !== 0) throw new Error("Could not adjust reasoning effort");
  }
}

/**
 * Presses exactly one visible, enabled Codex dictation button.
 *
 * Dictation deliberately has no keyboard fallback: a missing or ambiguous
 * button means Codex is not in the state we expected, so guessing could submit
 * unrelated composer text.
 */
export function dictationButtonAppleScript(action: DictationButtonAction): string {
  const labels = DICTATION_BUTTON_LABELS[action].map(appleScriptString).join(", ");
  const path = COMPOSER_BUTTON_PARENT_PATH.join(", ");
  return [
    "tell application \"System Events\"",
    "  set targetProcesses to every process whose bundle identifier is \"com.openai.codex\"",
    "  if (count of targetProcesses) is not 1 then error \"Codex process is unavailable or ambiguous\" number 1708",
    "  set targetProcess to item 1 of targetProcesses",
    "  set frontmost of targetProcess to true",
    "  set becameReady to false",
    "  repeat 30 times",
    "    try",
    "      if frontmost of targetProcess is true and (count of windows of targetProcess) > 0 then",
    "        set becameReady to true",
    "        exit repeat",
    "      end if",
    "    end try",
    "    delay 0.05",
    "  end repeat",
    "  if becameReady is false then error \"Codex did not become ready\" number 1708",
    "  tell targetProcess",
    "    set candidateWindows to {}",
    "    repeat with windowRef in windows",
    "      set windowTitle to \"\"",
    "      set windowMain to false",
    "      try",
    "        set windowTitle to title of windowRef as text",
    "      end try",
    "      try",
    "        set windowMain to value of attribute \"AXMain\" of windowRef as boolean",
    "      end try",
    "      if windowMain is true or windowTitle is \"ChatGPT\" then",
    "        set end of candidateWindows to contents of windowRef",
    "      end if",
    "    end repeat",
    "    if (count of candidateWindows) is not 1 then error \"Codex main window is unavailable or ambiguous\" number 1708",
    "    set composerParent to item 1 of candidateWindows",
    `    repeat with childIndex in {${path}}`,
    "      try",
    "        set childItems to value of attribute \"AXChildren\" of composerParent",
    "        set composerParent to item (childIndex as integer) of childItems",
    "      on error",
    "        error \"Codex composer accessibility path changed\" number 1708",
    "      end try",
    "    end repeat",
    "    set directItems to value of attribute \"AXChildren\" of composerParent",
    `    repeat with candidateLabel in {${labels}}`,
    "      set matchedItems to {}",
    "      repeat with itemRef in directItems",
    "        try",
    "          set itemVisible to true",
    "          try",
    "            set itemVisible to visible of itemRef as boolean",
    "          end try",
    "          if (role of itemRef as text) is \"AXButton\" and (enabled of itemRef as boolean) is true and itemVisible is true then",
    "            set itemTitle to \"\"",
    "            set itemDescription to \"\"",
    "            try",
    "              set itemTitle to title of itemRef as text",
    "            end try",
    "            try",
    "              set itemDescription to description of itemRef as text",
    "            end try",
    "            if itemTitle is (candidateLabel as text) or itemDescription is (candidateLabel as text) then",
    "              set end of matchedItems to contents of itemRef",
    "            end if",
    "          end if",
    "        end try",
    "      end repeat",
    "      if (count of matchedItems) > 1 then error \"Codex dictation control is ambiguous\" number 1708",
    "      if (count of matchedItems) is 1 then",
    "        perform action \"AXPress\" of item 1 of matchedItems",
    "        return",
    "      end if",
    "    end repeat",
    "  end tell",
    "end tell",
    "error \"Codex dictation control was not found\" number 1708"
  ].join("\n");
}

function clickElementScript(labels: readonly string[]): string {
  const comparisons = labels.map((label) => {
    const escaped = label.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
    return `labelText contains \"${escaped}\"`;
  }).join(" or ");
  return [
    "tell application id \"com.openai.codex\" to activate",
    "tell application \"System Events\"",
    "  delay 0.08",
    "  tell first process whose bundle identifier is \"com.openai.codex\"",
    "    set frontmost to true",
    "    set allItems to entire contents of front window",
    "    repeat with itemRef in allItems",
    "      try",
    "        set itemRole to role of itemRef as text",
    "        if itemRole is \"AXButton\" or itemRole is \"AXMenuItem\" then",
    "          set labelText to \"\"",
    "          try",
    "            set labelText to labelText & (title of itemRef as text)",
    "          end try",
    "          try",
    "            set labelText to labelText & \" \" & (description of itemRef as text)",
    "          end try",
    `          if ${comparisons} then`,
    "            perform action \"AXPress\" of itemRef",
    "            return",
    "          end if",
    "        end if",
    "      end try",
    "    end repeat",
    "  end tell",
    "end tell",
    "error \"Codex control was not found\" number 1708"
  ].join("\n");
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n")}"`;
}
