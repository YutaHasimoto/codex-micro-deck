export const OFFICIAL_STATE_COLORS = {
  white: "#FFFFFF",
  blue: "#304FFE",
  green: "#00FF4C",
  amber: "#FF6D00",
  red: "#FF0033",
  off: "#000000"
} as const;

export type ModelKeyRole =
  | "agent-1" | "agent-2" | "agent-3" | "agent-4" | "agent-5" | "agent-6"
  | "approve" | "decline" | "fast" | "submit" | "new-chat" | "fork"
  | "ptt" | "voice-toggle" | "interrupt" | "review" | "skills" | "open-codex" | "refresh";
export type ModelEncoderRole =
  | "model" | "reasoning" | "speed" | "approval"
  | "legacy-reasoning" | "navigation" | "skills" | "composer" | "review" | "voice";
export type ModelAgentPhase = "idle" | "working" | "approval" | "error";
export type ModelStateColor = keyof typeof OFFICIAL_STATE_COLORS;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const KEY_ROLES: readonly ModelKeyRole[] = [
  "agent-1", "agent-2", "agent-3", "agent-4",
  "agent-5", "agent-6", "approve", "voice-toggle"
];
const ENCODER_ROLES: readonly ModelEncoderRole[] = ["model", "reasoning", "speed", "approval"];

export function defaultKeyRole(column: number, row: number): ModelKeyRole {
  const index = Math.max(0, Math.min(7, row * 4 + column));
  return KEY_ROLES[index] ?? "agent-1";
}

export function defaultEncoderRole(column: number): ModelEncoderRole {
  return ENCODER_ROLES[Math.max(0, Math.min(3, column))] ?? "model";
}

export function agentIndex(role: string): number | undefined {
  const match = /^agent-([1-6])$/.exec(role);
  return match?.[1] ? Number(match[1]) - 1 : undefined;
}

export function stateColor(phase: ModelAgentPhase | undefined, unread: boolean): ModelStateColor {
  if (!phase) return "off";
  if (phase === "error") return "red";
  if (phase === "approval") return "amber";
  if (phase === "working") return "blue";
  if (unread) return "green";
  return "white";
}

export function roleLabel(role: ModelKeyRole | ModelEncoderRole): string {
  const index = agentIndex(role);
  if (index !== undefined) return `Agent ${index + 1}`;
  const labels: Record<string, string> = {
    approve: "Approve", decline: "Decline", fast: "Fast", submit: "Submit",
    "new-chat": "New Chat", fork: "Fork", ptt: "Voice", "voice-toggle": "Voice", interrupt: "Stop",
    review: "Review", skills: "Skills", "open-codex": "Codex", refresh: "Refresh",
    model: "Model", reasoning: "Reasoning", speed: "Speed", approval: "Access",
    "legacy-reasoning": "Reasoning (Legacy)",
    navigation: "Navigation", composer: "Composer", voice: "Voice"
  };
  return labels[role] ?? role;
}

export function compactTitle(value: string, maxLength = 18): string {
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) return "Untitled";
  const graphemes = splitGraphemes(title);
  return graphemes.length <= maxLength
    ? title
    : `${graphemes.slice(0, Math.max(1, maxLength - 1)).join("")}…`;
}

/** Keeps emoji sequences and combining marks intact while fitting tiny Deck labels. */
export function splitGraphemes(value: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(value), ({ segment }) => segment);
}

export function normalizeModeIndex(value: number | undefined, count: number): number {
  if (!Number.isFinite(value) || count <= 0) return 0;
  return ((Math.trunc(value ?? 0) % count) + count) % count;
}
