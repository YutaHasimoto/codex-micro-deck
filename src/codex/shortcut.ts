export type ShortcutModifier = "command" | "control" | "option" | "shift";
export type ParsedShortcut = { key: string; modifiers: ShortcutModifier[] };

const MODIFIER_ALIASES: Record<string, ShortcutModifier> = {
  cmd: "command", command: "command", meta: "command",
  ctrl: "control", control: "control",
  alt: "option", opt: "option", option: "option",
  shift: "shift"
};

const NAMED_KEY_CODES: Record<string, number> = {
  enter: 36, return: 36, escape: 53, esc: 53, space: 49, tab: 48,
  left: 123, right: 124, down: 125, up: 126,
  delete: 51, backspace: 51
};

export function parseShortcut(value: string): ParsedShortcut | undefined {
  const tokens = value.toLowerCase().split("+").map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return undefined;
  const key = tokens.pop();
  if (!key || !(key in NAMED_KEY_CODES) && !/^[a-z0-9\[\]/.,\-=]$/.test(key)) return undefined;
  const modifiers: ShortcutModifier[] = [];
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token];
    if (!modifier) return undefined;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return { key, modifiers };
}

export function shortcutAppleScript(shortcut: ParsedShortcut, settleDelaySeconds = 0.08): string {
  const using = shortcut.modifiers.length
    ? ` using {${shortcut.modifiers.map((modifier) => `${modifier} down`).join(", ")}}`
    : "";
  const keyCode = NAMED_KEY_CODES[shortcut.key];
  const command = keyCode === undefined
    ? `keystroke ${JSON.stringify(shortcut.key)}${using}`
    : `key code ${keyCode}${using}`;
  return [
    "tell application id \"com.openai.codex\" to activate",
    "tell application \"System Events\"",
    "  tell first process whose bundle identifier is \"com.openai.codex\"",
    "    set frontmost to true",
    "    repeat 30 times",
    "      if frontmost then exit repeat",
    "      delay 0.05",
    "    end repeat",
    "    if not frontmost then error \"Codex did not become frontmost\" number 1708",
    "    if (count of windows) is 0 then error \"Codex has no focused window\" number 1708",
    `    delay ${normalizeDelay(settleDelaySeconds)}`,
    `    ${command}`,
    "  end tell",
    "end tell"
  ].join("\n");
}

/**
 * Opens Codex's command palette and selects one exact, caller-supplied label.
 * JSON string encoding keeps quotes, backslashes, and line breaks inside the
 * AppleScript string literal instead of letting them become script source.
 */
export function commandPaletteAppleScript(label: string): string {
  return [
    "tell application id \"com.openai.codex\" to activate",
    "tell application \"System Events\"",
    "  tell first process whose bundle identifier is \"com.openai.codex\"",
    "    set frontmost to true",
    "    repeat 30 times",
    "      if frontmost then exit repeat",
    "      delay 0.05",
    "    end repeat",
    "    if not frontmost then error \"Codex did not become frontmost\" number 1708",
    "    set originalFocus to missing value",
    "    repeat 20 times",
    "      delay 0.05",
    "      try",
    "        set candidateFocus to value of attribute \"AXFocusedUIElement\"",
    "        if candidateFocus is not missing value then",
    "          set originalFocus to candidateFocus",
    "          exit repeat",
    "        end if",
    "      end try",
    "    end repeat",
    "    if originalFocus is missing value then error \"Codex did not become ready\" number 1708",
    "    keystroke \"k\" using {command down}",
    "    set paletteFocus to missing value",
    "    repeat 20 times",
    "      delay 0.05",
    "      try",
    "        set candidateFocus to value of attribute \"AXFocusedUIElement\"",
    "        if candidateFocus is not originalFocus then",
    "          set paletteFocus to candidateFocus",
    "          exit repeat",
    "        end if",
    "      end try",
    "    end repeat",
    "    if paletteFocus is missing value then error \"Codex command palette did not receive focus\" number 1708",
    "    try",
    `      set value of attribute \"AXValue\" of paletteFocus to ${JSON.stringify(label)}`,
    "    on error",
    `      keystroke ${JSON.stringify(label)}`,
    "    end try",
    "    delay 0.12",
    "    set currentFocus to value of attribute \"AXFocusedUIElement\"",
    "    if currentFocus is not paletteFocus then error \"Codex command palette lost focus\" number 1708",
    "    key code 36",
    "  end tell",
    "end tell"
  ].join("\n");
}

function normalizeDelay(value: number): string {
  if (!Number.isFinite(value)) return "0.08";
  return Math.max(0.02, Math.min(1, value)).toFixed(2);
}
