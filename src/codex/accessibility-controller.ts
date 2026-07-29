export type DictationButtonAction = "start" | "insert" | "send";

const DICTATION_IDLE_LABELS = [
  "音声入力",
  "Dictate",
  "音声入力を再試行",
  "Retry dictation"
] as const;
const DICTATION_BUTTON_LABELS: Readonly<Record<DictationButtonAction, readonly string[]>> = {
  start: DICTATION_IDLE_LABELS,
  insert: ["音声入力を停止", "Stop dictation"],
  send: ["文字起こしして送信する", "Transcribe and send"]
};
const DICTATION_ACTIVE_LABELS = [
  ...DICTATION_BUTTON_LABELS.insert,
  ...DICTATION_BUTTON_LABELS.send
] as const;
const EDIT_MENU_LABELS = ["編集", "Edit"] as const;
const DICTATION_START_MENU_LABELS = [
  "音声入力を開始…",
  "Start Dictation…"
] as const;

/** Written to osascript stderr immediately before the one allowed AXPress. */
export const DICTATION_PRESS_MARKER = "CODEX_MICRO_DECK_DICTATION_AXPRESS";

/**
 * Electron exposes the task footer through a stable chain of AX groups below
 * the main ChatGPT window. The final descendants can change while Codex is
 * generating or recording, so every dictation action keeps the stable prefix
 * and recurses only inside child 3, the bounded composer branch. It never scans
 * conversation history.
 */
const COMPOSER_ROOT_PATH = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1,
  1, 1, 1, 1, 2, 1, 1, 2, 2
] as const;
const COMPOSER_BRANCH_INDEX = 3;

/**
 * Presses at most one enabled Codex dictation control.
 *
 * Dictation deliberately has no keyboard fallback: a missing or ambiguous
 * button means Codex is not in the state we expected, so guessing could submit
 * unrelated composer text.
 */
export function dictationButtonAppleScript(action: DictationButtonAction): string {
  if (action === "start") return dictationStartAppleScript();

  const targetLabels = appleScriptList(DICTATION_BUTTON_LABELS[action]);
  const idleLabels = appleScriptList(DICTATION_IDLE_LABELS);
  return [
    ...dictationComposerPreludeAppleScript(),
    `    set targetLabels to {${targetLabels}}`,
    `    set idleLabels to {${idleLabels}}`,
    "    set composerItems to {composerBranch}",
    "    try",
    "      set composerItems to composerItems & entire contents of composerBranch",
    "    end try",
    "    set targetItems to {}",
    "    set idleItems to {}",
    ...classifyComposerItemsAppleScript("composerItems", [
      { labels: "targetLabels", matches: "targetItems" },
      { labels: "idleLabels", matches: "idleItems" }
    ], 4),
    "    if (count of targetItems) > 1 or (count of idleItems) > 1 then error \"Codex dictation control is ambiguous\" number 1708",
    "    if (count of targetItems) is 1 and (count of idleItems) is 1 then error \"Codex dictation control is ambiguous\" number 1708",
    "    if (count of targetItems) is 1 then",
    ...pressStopControlAppleScript("item 1 of targetItems", 6),
    "    end if",
    "    if (count of idleItems) is 1 then return \"already-idle\"",
    "  end tell",
    "end tell",
    "error \"Codex dictation control was not found\" number 1708"
  ].join("\n");
}

/**
 * Starts dictation through Codex's localized Edit menu or the already-resolved
 * composer control, then proves that the
 * composer changed to its recording controls before the Deck can show
 * Listening. AXPress acknowledgement alone is not a successful start.
 */
function dictationStartAppleScript(): string {
  const idleLabels = appleScriptList(DICTATION_IDLE_LABELS);
  const activeLabels = appleScriptList(DICTATION_ACTIVE_LABELS);
  return [
    ...dictationComposerPreludeAppleScript(),
    `    set idleLabels to {${idleLabels}}`,
    `    set activeLabels to {${activeLabels}}`,
    "    set composerItems to {composerBranch}",
    "    try",
    "      set composerItems to composerItems & entire contents of composerBranch",
    "    end try",
    "    set idleItems to {}",
    "    set activeItems to {}",
    ...classifyComposerItemsAppleScript("composerItems", [
      { labels: "idleLabels", matches: "idleItems" },
      { labels: "activeLabels", matches: "activeItems" }
    ], 4),
    "    if (count of idleItems) > 1 or (count of activeItems) > 1 then error \"Codex dictation control is ambiguous\" number 1708",
    "    if (count of idleItems) is 1 and (count of activeItems) is 1 then error \"Codex dictation control is ambiguous\" number 1708",
    "    if (count of activeItems) is 1 then return \"already-active\"",
    "    if (count of idleItems) is not 1 then error \"Codex dictation control was not found\" number 1708",
    "    set startMenuItems to {}",
    ...directStartMenuCandidatesAppleScript(4),
    "    if (count of startMenuItems) > 1 then error \"Codex dictation control is ambiguous\" number 1708",
    "    if frontmost of targetProcess is not true then error \"Codex lost focus before dictation\" number 1708",
    "    if (count of startMenuItems) is 1 then",
    ...pressStartControlAppleScript("item 1 of startMenuItems", 6),
    "    else",
    ...pressStartControlAppleScript("item 1 of idleItems", 6),
    "    end if",
    "    repeat 3 times",
    "      delay 0.15",
    "      set confirmationItems to {composerBranch}",
    "      try",
    "        set confirmationItems to confirmationItems & entire contents of composerBranch",
    "      end try",
    "      set confirmationActiveItems to {}",
    "      set confirmationIdleItems to {}",
    ...classifyComposerItemsAppleScript("confirmationItems", [
      { labels: "activeLabels", matches: "confirmationActiveItems" },
      { labels: "idleLabels", matches: "confirmationIdleItems" }
    ], 6),
    "      if (count of confirmationActiveItems) > 1 or (count of confirmationIdleItems) > 1 then error \"Codex dictation control is ambiguous\" number 1708",
    "      if (count of confirmationActiveItems) is 1 and (count of confirmationIdleItems) is 1 then error \"Codex dictation control is ambiguous\" number 1708",
    "      if (count of confirmationActiveItems) is 1 then return \"start-confirmed\"",
    "    end repeat",
    "  end tell",
    "end tell",
    "error \"Codex dictation start was not confirmed\" number 1708"
  ].join("\n");
}

function dictationComposerPreludeAppleScript(): string[] {
  const path = COMPOSER_ROOT_PATH.join(", ");
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
    "    set composerRoot to item 1 of candidateWindows",
    `    repeat with childIndex in {${path}}`,
    "      try",
    "        set childItems to value of attribute \"AXChildren\" of composerRoot",
    "        set composerRoot to item (childIndex as integer) of childItems",
    "      on error",
    "        error \"Codex composer accessibility path changed\" number 1708",
    "      end try",
    "    end repeat",
    "    try",
    "      set rootChildren to value of attribute \"AXChildren\" of composerRoot",
    `      set composerBranch to item ${COMPOSER_BRANCH_INDEX} of rootChildren`,
    "    on error",
    "      error \"Codex composer accessibility path changed\" number 1708",
    "    end try"
  ];
}

function directStartMenuCandidatesAppleScript(spaces: number): string[] {
  const indent = " ".repeat(spaces);
  return EDIT_MENU_LABELS.flatMap((editMenuLabel) =>
    DICTATION_START_MENU_LABELS.flatMap((startMenuLabel) => [
      `${indent}try`,
      `${indent}  set menuItemRef to menu item ${appleScriptString(startMenuLabel)} of menu 1 of menu bar item ${appleScriptString(editMenuLabel)} of menu bar 1`,
      `${indent}  set menuItemRole to role of menuItemRef as text`,
      `${indent}  if menuItemRole is "AXMenuItem" then`,
      `${indent}    set menuItemEnabled to enabled of menuItemRef as boolean`,
      `${indent}    if menuItemEnabled is true then set end of startMenuItems to contents of menuItemRef`,
      `${indent}  end if`,
      `${indent}end try`
    ])
  );
}

type ComposerClassification = {
  labels: string;
  matches: string;
};

function classifyComposerItemsAppleScript(
  items: string,
  classifications: readonly ComposerClassification[],
  spaces: number
): string[] {
  const indent = " ".repeat(spaces);
  const comparisons = classifications.flatMap(({ labels, matches }) => [
    `${indent}        if (${labels} contains itemTitle) or (${labels} contains itemDescription) then`,
    `${indent}          set end of ${matches} to contents of itemRef`,
    `${indent}        end if`
  ]);
  return [
    `${indent}repeat with itemRef in ${items}`,
    `${indent}  try`,
    `${indent}    set itemRole to role of itemRef as text`,
    `${indent}    if itemRole is "AXButton" then`,
    `${indent}      set itemEnabled to enabled of itemRef as boolean`,
    `${indent}      if itemEnabled is true then`,
    `${indent}        set itemTitle to ""`,
    `${indent}        set itemDescription to ""`,
    `${indent}        try`,
    `${indent}          set itemTitle to title of itemRef as text`,
    `${indent}        end try`,
    `${indent}        try`,
    `${indent}          set itemDescription to description of itemRef as text`,
    `${indent}        end try`,
    ...comparisons,
    `${indent}      end if`,
    `${indent}    end if`,
    `${indent}  end try`,
    `${indent}end repeat`
  ];
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n")}"`;
}

function appleScriptList(values: readonly string[]): string {
  return values.map(appleScriptString).join(", ");
}

/**
 * Electron can invalidate the pressed renderer element before System Events
 * acknowledges AXPress. A -1712 response therefore leaves delivery
 * indeterminate and must never be followed by an automatic retry.
 */
function pressStopControlAppleScript(
  controlExpression: string,
  spaces: number
): string[] {
  const indent = " ".repeat(spaces);
  return [
    `${indent}log ${appleScriptString(DICTATION_PRESS_MARKER)}`,
    `${indent}try`,
    `${indent}  with timeout of 1 second`,
    `${indent}    perform action "AXPress" of ${controlExpression}`,
    `${indent}  end timeout`,
    `${indent}on error errorMessage number errorNumber`,
    `${indent}  if errorNumber is -1712 then return "press-indeterminate"`,
    `${indent}  error errorMessage number errorNumber`,
    `${indent}end try`,
    `${indent}return "pressed"`
  ];
}

/**
 * Start treats -1712 as an uncertain acknowledgement and relies exclusively
 * on the bounded post-press composer scan to establish success.
 */
function pressStartControlAppleScript(
  controlExpression: string,
  spaces: number
): string[] {
  const indent = " ".repeat(spaces);
  return [
    `${indent}log ${appleScriptString(DICTATION_PRESS_MARKER)}`,
    `${indent}try`,
    `${indent}  with timeout of 1 second`,
    `${indent}    perform action "AXPress" of ${controlExpression}`,
    `${indent}  end timeout`,
    `${indent}on error errorMessage number errorNumber`,
    `${indent}  if errorNumber is not -1712 then error errorMessage number errorNumber`,
    `${indent}end try`
  ];
}
