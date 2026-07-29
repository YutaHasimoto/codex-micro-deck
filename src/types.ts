export const PLUGIN_UUID = "works.kawaii.codex-shortcuts-plugin";
export const KEY_ACTION_UUID = `${PLUGIN_UUID}.key`;
export const ENCODER_ACTION_UUID = `${PLUGIN_UUID}.encoder`;

export type AgentKeyRole =
  | "agent-1" | "agent-2" | "agent-3"
  | "agent-4" | "agent-5" | "agent-6";

export type KeyRole = AgentKeyRole
  | "approve" | "decline" | "fast" | "submit" | "new-chat" | "fork"
  | "ptt" | "voice-toggle" | "interrupt" | "review" | "skills" | "open-codex" | "refresh";

export type EncoderRole =
  | "model" | "reasoning" | "speed" | "approval"
  // Legacy roles remain valid so customized profiles do not break on update.
  | "legacy-reasoning" | "navigation" | "skills" | "composer" | "review" | "voice";
/** The four Access choices exposed by the fourth default Stream Deck + dial. */
export type AccessMode = "ask" | "delegate" | "full" | "custom";
export type AgentPhase = "idle" | "working" | "approval" | "error";
export type StateColor = "white" | "blue" | "green" | "amber" | "red" | "off";

export type KeySettings = {
  role?: KeyRole;
  autoAssign?: boolean;
  threadId?: string;
  shortcut?: string;
};

export type EncoderSettings = {
  role?: EncoderRole;
  layoutVersion?: number;
  modeIndex?: number;
  counterClockwiseShortcut?: string;
  clockwiseShortcut?: string;
  pressShortcut?: string;
};

export type SeenThread = {
  seenUpdatedAt: number;
  unread: boolean;
};

export type GlobalSettings = {
  accessibilityEnabled?: boolean;
  pollIntervalMs?: number;
  seenThreads?: Record<string, SeenThread>;
  /** Last Agent-key selection, restored after a plugin restart. */
  selectedThreadId?: string;
  /** True when the restored selection came from a pinned (non-auto) key. */
  selectedThreadPinned?: boolean;
  /** Persisted independently of config.toml so other dial changes do not reset Access. */
  accessMode?: AccessMode;
};

export type ThreadSnapshot = {
  id: string;
  title: string;
  rolloutPath?: string;
  updatedAt: number;
  phase: AgentPhase;
  completedAt?: number;
  sourceUnread?: boolean;
  sourceUnreadAt?: number;
};

export type KeyPresentation = {
  color: StateColor;
  primary: string;
  secondary: string;
  threadId?: string;
  selected?: boolean;
  pulse?: boolean;
};

export type EncoderPresentation = {
  color: StateColor;
  title: string;
  value: string;
  hint: string;
  /** Replaces the regular dial UI with one slice of the shared voice waveform. */
  mode?: "voice";
  /** Zero-based 200 px slice within the Stream Deck + 800 px dial strip. */
  slice?: number;
};

export type DeckCoordinates = { column: number; row: number };

export const DEFAULT_GLOBAL_SETTINGS: Required<
  Omit<GlobalSettings, "seenThreads" | "selectedThreadId" | "selectedThreadPinned">
> = {
  accessibilityEnabled: true,
  pollIntervalMs: 2000,
  accessMode: "custom"
};
