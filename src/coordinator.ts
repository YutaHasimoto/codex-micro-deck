import { LocalCodexStateProvider } from "./codex/local-state-provider.js";
import {
  StableCodexController,
  type DictationStartResult,
  type DictationStopResult
} from "./codex/stable-controller.js";
import {
  CodexAppServerClient,
  resolveCodexCliPath
} from "./codex/app-server-client.js";
import {
  CodexDesktopIpcClient,
  threadSettingsMatchResume,
  threadSettingsForSnapshot
} from "./codex/desktop-ipc-client.js";
import {
  CodexDesktopFollower,
  type PendingApproval
} from "./codex/desktop-follower.js";
import {
  CodexConfigController,
  FALLBACK_MODELS,
  type ApprovalSetting,
  type CodexControlSnapshot,
  type ConfigControlRole
} from "./codex/config-controller.js";
import {
  agentIndex,
  compactTitle,
  defaultEncoderRole,
  defaultKeyRole,
  normalizeModeIndex,
  roleLabel,
  stateColor
} from "./core/model.js";
import { UnreadTracker } from "./core/unread.js";
import type {
  DeckCoordinates,
  EncoderPresentation,
  EncoderRole,
  EncoderSettings,
  GlobalSettings,
  KeyPresentation,
  KeyRole,
  KeySettings,
  AccessMode,
  ThreadSnapshot
} from "./types.js";
import { DEFAULT_GLOBAL_SETTINGS } from "./types.js";

export const SKILL_DIAL_MODES = ["skills", "review", "plan", "fast"] as const;
export type SkillDialMode = typeof SKILL_DIAL_MODES[number];
export const CONTROL_SUCCESS_FEEDBACK_MS = 1_500;
export const CONTROL_WARNING_FEEDBACK_MS = 4_000;
export const FULL_ACCESS_CONFIRMATION_MS = 4_000;
const APP_SERVER_SETTINGS_TIMEOUT_MS = 15_000;
const CONVERSATION_ID_PATTERN = /^[0-9a-f-]{16,64}$/i;

type PersistGlobalSettings = (settings: GlobalSettings) => Promise<void>;
type ChangeListener = () => void | Promise<void>;
type CoordinatorCodexController = Pick<StableCodexController,
  "accessibilityEnabled" | "openThread" | "openApp" | "runCommand"
  | "runShortcutText" | "runPaletteCommand" | "navigate"> & {
    startDictation(): Promise<DictationStartResult | void>;
    stopDictation(
      disposition: Parameters<StableCodexController["stopDictation"]>[0]
    ): Promise<DictationStopResult | void>;
  };
type VoiceToggleResult =
  | "started" | "synced" | "sent" | "already-idle" | "ignored";

export type CoordinatorDependencies = {
  provider?: Pick<LocalCodexStateProvider, "listRecentThreads">;
  codex?: CoordinatorCodexController;
  config?: Pick<CodexConfigController, "read" | "applyControl" | "resetControl">;
  liveSettings?: Pick<CodexDesktopIpcClient, "updateThreadSettings">;
  appServer?: Pick<CodexAppServerClient, "start" | "stop" | "request">;
  /**
   * Optional isolated App Server used only for the user-facing thread names.
   * Keeping it separate means the settings-sync lifecycle remains unchanged.
   */
  threadNames?: Pick<CodexAppServerClient, "start" | "stop" | "pollRecentThreads">;
  resolveCodexCliPath?: () => Promise<string>;
  follower?: Pick<CodexDesktopFollower,
    "start" | "stop" | "onChange" | "setDesiredConversations" | "isConnected"
    | "desktopFollowedIds" | "pendingApprovals" | "decideApproval" | "updateThreadSettings">;
};

type ControlFeedbackKind = "default" | "partial" | "warning" | "confirm";
type ControlFeedback = {
  kind: ControlFeedbackKind;
  expiresAt: number;
  synced?: number;
  total?: number;
};
type AgentSlotAssignment = {
  autoEnabled: boolean;
  fixedId?: string;
  ownerId?: string;
};
export type ControlApplyOutcome = "applied" | "default" | "confirmation";

type LiveTargetResolution =
  | { kind: "target"; target: string }
  | { kind: "none" }
  | { kind: "ambiguous" };

/** Owns Codex state and control mappings; Stream Deck SDK objects stay in action classes. */
export class CodexDeckCoordinator {
  readonly #provider: Pick<LocalCodexStateProvider, "listRecentThreads">;
  readonly #codex: NonNullable<CoordinatorDependencies["codex"]>;
  readonly #config: NonNullable<CoordinatorDependencies["config"]>;
  readonly #liveSettings: NonNullable<CoordinatorDependencies["liveSettings"]>;
  readonly #appServer: NonNullable<CoordinatorDependencies["appServer"]>;
  readonly #threadNames: NonNullable<CoordinatorDependencies["threadNames"]> | undefined;
  readonly #resolveCodexCliPath: NonNullable<CoordinatorDependencies["resolveCodexCliPath"]>;
  readonly #follower: NonNullable<CoordinatorDependencies["follower"]>;
  readonly #listeners = new Set<ChangeListener>();
  readonly #encoderListeners = new Set<ChangeListener>();
  #settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS, seenThreads: {} };
  #unread = new UnreadTracker();
  #rawThreads: ThreadSnapshot[] = [];
  #threads: ThreadSnapshot[] = [];
  #persist: PersistGlobalSettings | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #pulseTimer: NodeJS.Timeout | undefined;
  #polling = false;
  #threadNamesStart: Promise<void> | undefined;
  #threadNamesRefresh: Promise<ThreadSnapshot[]> | undefined;
  readonly #threadNameCache = new Map<string, string>();
  #selectedThreadId: string | undefined;
  #selectedAutoAssigned = false;
  #pulse = false;
  #controlSnapshot: CodexControlSnapshot = defaultControlSnapshot();
  #controlSelection: Record<ConfigControlRole, string> = selectionFromSnapshot(this.#controlSnapshot);
  readonly #pendingControlRoles = new Set<ConfigControlRole>();
  readonly #controlFeedback = new Map<ConfigControlRole, ControlFeedback>();
  readonly #controlSuccessTimers = new Map<ConfigControlRole, NodeJS.Timeout>();
  #controlApplyQueue: Promise<void> = Promise.resolve();
  #accessMode: AccessMode | ApprovalSetting = DEFAULT_GLOBAL_SETTINGS.accessMode;
  #hasPersistedAccessMode = false;
  #fullAccessConfirmationExpiresAt: number | undefined;
  #autoAssignedThreadIds: Array<string | undefined> = Array.from({ length: 6 });
  #agentSlotAssignments: Array<AgentSlotAssignment | undefined> = Array.from(
    { length: 6 },
    () => ({ autoEnabled: true })
  );
  #approvalInFlight = false;
  #dialDictationActive = false;
  #voiceToggleInFlight = false;
  readonly #voiceTogglePressOwners = new Set<string>();
  #legacyVoiceOwner: string | undefined;
  #legacyVoiceActuallyActive = false;
  #legacyVoiceSync: Promise<void> = Promise.resolve();

  constructor(dependencies: CoordinatorDependencies = {}) {
    this.#provider = dependencies.provider ?? new LocalCodexStateProvider();
    this.#codex = dependencies.codex ?? new StableCodexController();
    this.#config = dependencies.config ?? new CodexConfigController();
    this.#liveSettings = dependencies.liveSettings ?? new CodexDesktopIpcClient();
    this.#appServer = dependencies.appServer ?? new CodexAppServerClient();
    this.#threadNames = dependencies.threadNames;
    this.#resolveCodexCliPath = dependencies.resolveCodexCliPath ?? resolveCodexCliPath;
    // The default follower does not touch the socket until start().
    this.#follower = dependencies.follower ?? new CodexDesktopFollower();
    this.#follower.onChange(() => {
      this.#mergeThreads();
      this.#notify();
    });
  }

  configure(settings: GlobalSettings, persist?: PersistGlobalSettings): void {
    this.#settings = normalizeGlobalSettings(settings);
    this.#hasPersistedAccessMode = isAccessMode(this.#settings.accessMode);
    if (this.#hasPersistedAccessMode) this.#accessMode = this.#settings.accessMode!;
    this.#controlSelection.approval = this.#accessMode;
    this.#unread = new UnreadTracker(this.#settings.seenThreads ?? {});
    this.#codex.accessibilityEnabled = this.#settings.accessibilityEnabled !== false;
    if (!this.#selectedThreadId && this.#settings.selectedThreadId) {
      // Restore the last Agent selection across plugin restarts. Auto-assigned
      // selections are cleared by poll() if the thread no longer exists;
      // pinned selections survive even outside the recent-thread window.
      this.#selectedThreadId = this.#settings.selectedThreadId;
      this.#selectedAutoAssigned = this.#settings.selectedThreadPinned !== true;
    }
    if (persist) this.#persist = persist;
    if (this.#pollTimer) this.#restartPollTimer();
    this.#notify();
  }

  start(): void {
    this.#restartPollTimer();
    if (!this.#pulseTimer) {
      this.#pulseTimer = setInterval(() => {
        if (!this.#selectedThreadId) return;
        this.#pulse = !this.#pulse;
        this.#notify();
      }, 520);
      this.#pulseTimer.unref();
    }
    this.#follower.start();
    if (this.#threadNames) {
      void this.#ensureThreadNamesStarted().catch(() => undefined);
    }
    void this.reloadConfigControls().catch(() => undefined);
    void this.poll().catch(() => undefined);
  }

  stop(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#pulseTimer) clearInterval(this.#pulseTimer);
    this.#pollTimer = undefined;
    this.#pulseTimer = undefined;
    this.#follower.stop();
    void this.#appServer.stop().catch(() => undefined);
    void this.#threadNames?.stop().catch(() => undefined);
    this.#threadNamesStart = undefined;
    this.#threadNamesRefresh = undefined;
    for (const timer of this.#controlSuccessTimers.values()) clearTimeout(timer);
    this.#controlSuccessTimers.clear();
    this.#controlFeedback.clear();
    this.#dialDictationActive = false;
    this.#voiceToggleInFlight = false;
    this.#voiceTogglePressOwners.clear();
    this.#legacyVoiceOwner = undefined;
    this.#legacyVoiceActuallyActive = false;
  }

  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onEncoderChange(listener: ChangeListener): () => void {
    this.#encoderListeners.add(listener);
    return () => this.#encoderListeners.delete(listener);
  }

  get threads(): readonly ThreadSnapshot[] {
    return this.#threads;
  }

  get globalSettings(): GlobalSettings {
    return structuredClone(this.#settings);
  }

  get voiceActive(): boolean {
    return this.#dialDictationActive || this.#legacyVoiceActuallyActive;
  }

  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const localThreads = await this.#provider.listRecentThreads();
      this.#rawThreads = await this.#withThreadNames(localThreads);
      this.#mergeThreads();
      this.#reconcileAutoAssignments();
      this.#syncFollowerDesiredConversations();
      if (this.#selectedAutoAssigned
        && this.#selectedThreadId
        && !this.#threads.some((thread) => thread.id === this.#selectedThreadId)) {
        this.#selectedThreadId = undefined;
        this.#selectedAutoAssigned = false;
        this.#pulse = false;
      }
      let seenChanged = false;
      for (const thread of this.#threads) {
        if (this.#unread.reconcile(thread).changed) seenChanged = true;
      }
      if (this.#unread.prune(this.#threads.map((thread) => thread.id))) seenChanged = true;
      if (seenChanged) await this.#persistSettings();
      this.#notify();
    } finally {
      this.#polling = false;
    }
  }

  /**
   * SQLite keeps the first user message in `title`/`preview`, while the App
   * Server owns the optional human-facing `thread.name`. Merge only that
   * field by exact thread ID; all ordering, status, and unread evidence stays
   * authoritative from the local provider.
   */
  async #withThreadNames(localThreads: ThreadSnapshot[]): Promise<ThreadSnapshot[]> {
    if (!this.#threadNames || !localThreads.length) return localThreads;
    const fallback = localThreads.map((thread) => {
      const cachedName = this.#threadNameCache.get(thread.id);
      return cachedName ? { ...thread, title: cachedName } : thread;
    });
    if (this.#threadNamesRefresh) return this.#threadNamesRefresh;

    const refresh = (async (): Promise<ThreadSnapshot[]> => {
      try {
        await this.#ensureThreadNamesStarted();
        const remoteThreads = await this.#threadNames!.pollRecentThreads();
        const localIds = new Set(localThreads.map((thread) => thread.id));
        const fetched = new Map<string, string>();
        for (const thread of remoteThreads) {
          const name = thread.title.trim();
          if (!name || name === "Untitled") {
            // A successful row with no name means a previously cached name was
            // cleared. Only clear exact local IDs; omitted rows stay cached.
            if (localIds.has(thread.id)) this.#threadNameCache.delete(thread.id);
            continue;
          }
          fetched.set(thread.id, compactTitle(name, 240));
        }
        for (const id of this.#threadNameCache.keys()) {
          if (!localIds.has(id)) this.#threadNameCache.delete(id);
        }
        for (const [id, name] of fetched) this.#threadNameCache.set(id, name);
        return localThreads.map((thread) => {
          const name = this.#threadNameCache.get(thread.id);
          return name ? { ...thread, title: name } : thread;
        });
      } catch {
        return fallback;
      }
    })();
    this.#threadNamesRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.#threadNamesRefresh === refresh) this.#threadNamesRefresh = undefined;
    }
  }

  async #ensureThreadNamesStarted(): Promise<void> {
    if (!this.#threadNames) return;
    if (this.#threadNamesStart) return this.#threadNamesStart;
    const start = (async () => {
      const cliPath = await this.#resolveCodexCliPath();
      await this.#threadNames!.start(cliPath, { experimentalApi: true });
    })();
    this.#threadNamesStart = start;
    try {
      await start;
    } catch (error) {
      if (this.#threadNamesStart === start) this.#threadNamesStart = undefined;
      throw error;
    }
  }

  /**
   * Rollouts never record approval requests, so the provider's phase is
   * overlaid with the live pending-approval state from the Desktop follower.
   * Requests this client has already answered are hidden inside the follower,
   * so no extra suppression window is needed here.
   */
  #mergeThreads(): void {
    const pending = this.#follower.pendingApprovals();
    this.#threads = this.#rawThreads.map((thread) => (
      pending.has(thread.id) ? { ...thread, phase: "approval" } : { ...thread }
    ));
  }

  keyPresentation(
    settings: KeySettings,
    coordinates: DeckCoordinates,
    ownerId?: string
  ): KeyPresentation {
    const role = keyRole(settings, coordinates);
    const index = agentIndex(role);
    if (index !== undefined) {
      const thread = resolveAgentThread(settings, index, this.#threads, this.#autoAssignedThreadIds);
      this.#rememberAgentSlot(index, settings, ownerId);
      if (!thread) {
        return {
          color: "off",
          primary: `Agent ${index + 1}`,
          secondary: "Unassigned"
        };
      }
      const unread = this.#unread.isUnread(thread.id);
      return {
        color: stateColor(thread.phase, unread),
        primary: `Agent ${index + 1}`,
        // Keep enough of the SQLite title for the selected-key marquee. The
        // renderer still clips every frame to the small physical title band.
        secondary: compactTitle(thread.title, 240),
        threadId: thread.id,
        selected: thread.id === this.#selectedThreadId,
        pulse: thread.id === this.#selectedThreadId && this.#pulse
      };
    }

    const secondary: Record<string, string> = {
      approve: "Accept", decline: "Reject", fast: "Toggle", submit: "Enter",
      "new-chat": "⌘N", fork: "New task", ptt: "Hold to talk",
      "voice-toggle": this.voiceActive ? "Listening…" : "Tap to talk", interrupt: "Stop",
      review: "Open tab", skills: "Open", "open-codex": "Launch", refresh: "Reload"
    };
    if (role === "approve" || role === "decline") {
      const actionable = this.#actionableApprovals();
      return {
        color: actionable.size
          ? role === "approve" ? "amber" : "red"
          : "off",
        primary: roleLabel(role),
        secondary: actionable.size ? secondary[role] ?? "Codex" : "No request"
      };
    }
    if (role === "voice-toggle") {
      return {
        color: this.voiceActive ? "blue" : "white",
        primary: roleLabel(role),
        secondary: secondary[role] ?? "Tap to talk"
      };
    }
    return {
      color: "white",
      primary: roleLabel(role),
      secondary: secondary[role] ?? "Codex"
    };
  }

  encoderPresentation(settings: EncoderSettings, coordinates: DeckCoordinates): EncoderPresentation {
    if (this.voiceActive) {
      return {
        color: "blue",
        title: "Voice",
        value: "Listening…",
        hint: "press again to transcribe and send",
        mode: "voice",
        slice: Math.max(0, Math.min(3, Math.trunc(coordinates.column)))
      };
    }
    const role = encoderRole(settings, coordinates);
    if (isConfigControlRole(role)) {
      const pending = this.#pendingControlRoles.has(role);
      const feedback = this.#controlFeedback.get(role);
      const colors: Record<ConfigControlRole, EncoderPresentation["color"]> = {
        model: "blue", reasoning: "green", speed: "white", approval: "white"
      };
      const feedbackValue = feedback?.kind === "partial"
          ? `⚠ ${feedback.synced ?? 0}/${feedback.total ?? 0}`
          : feedback?.kind === "warning"
            ? feedback.total
              ? `⚠ ${feedback.synced ?? 0}/${feedback.total}`
              : "⚠ Default"
            : feedback?.kind === "confirm"
              ? "Full · again"
            : "✓ Default";
      const feedbackHint = feedback?.kind === "partial"
          ? "Partial sync · retry"
          : feedback?.kind === "warning"
            ? "Live failed · default saved"
            : feedback?.kind === "confirm"
              ? "press again within 4 sec"
            : "New task default only";
      return {
        color: pending || feedback?.kind === "warning" || feedback?.kind === "partial" || feedback?.kind === "confirm"
          ? "amber"
          : colors[role],
        title: roleLabel(role),
        value: feedback ? feedbackValue : this.#controlDisplayValue(role),
        hint: feedback
          ? feedbackHint
          : pending ? pendingApplyHint(role) : "rotate choose · tap reload"
      };
    }
    if (role === "legacy-reasoning") {
      return { color: "green", title: "Reasoning", value: "Legacy", hint: "custom profile compatibility" };
    }
    if (role === "navigation") {
      return { color: "white", title: "Navigation", value: "Back / Forward", hint: "press Sidebar · tap New" };
    }
    if (role === "skills") {
      const index = normalizeModeIndex(settings.modeIndex, SKILL_DIAL_MODES.length);
      const mode = SKILL_DIAL_MODES[index] ?? "skills";
      return { color: "green", title: "Codex command", value: displayMode(mode), hint: "rotate select · press run" };
    }
    if (role === "composer" || role === "voice") {
      return { color: "blue", title: "Composer", value: "Voice / Cursor", hint: "tap Submit · hold Fork" };
    }
    return { color: "white", title: roleLabel(role), value: "Open", hint: "press to run" };
  }

  async pressKey(
    settings: KeySettings,
    coordinates: DeckCoordinates,
    actionId?: string
  ): Promise<VoiceToggleResult | void> {
    const role = keyRole(settings, coordinates);
    if (this.voiceActive && role !== "voice-toggle") return "ignored";
    if (role === "voice-toggle") {
      const owner = `key:${actionId ?? `${coordinates.column}:${coordinates.row}`}`;
      if (this.#voiceTogglePressOwners.has(owner)) return "ignored";
      this.#voiceTogglePressOwners.add(owner);
      return this.#toggleDialDictation();
    }
    if (settings.shortcut && agentIndex(role) === undefined) {
      await this.#codex.runShortcutText(settings.shortcut);
      return;
    }
    const index = agentIndex(role);
    if (index !== undefined) {
      const thread = resolveAgentThread(settings, index, this.#threads, this.#autoAssignedThreadIds);
      this.#rememberAgentSlot(index, settings);
      if (!thread) throw new Error(`Agent ${index + 1} is not assigned`);
      await this.#codex.openThread(thread.id);
      this.#selectedThreadId = thread.id;
      this.#selectedAutoAssigned = settings.autoAssign !== false;
      this.#pulse = true;
      this.#unread.markSeen(thread.id, thread.updatedAt);
      await this.#persistSettings();
      this.#notify();
      return;
    }
    if (role === "ptt") {
      await this.#startLegacyVoice(`key:${coordinates.column}:${coordinates.row}`);
      return;
    }
    await this.#runKeyRole(role);
  }

  async releaseKey(
    settings: KeySettings,
    coordinates: DeckCoordinates,
    actionId?: string
  ): Promise<void> {
    if (actionId) this.releaseVoiceToggleKey(actionId);
    const role = keyRole(settings, coordinates);
    if (role === "voice-toggle") {
      if (!actionId) {
        this.#voiceTogglePressOwners.delete(`key:${coordinates.column}:${coordinates.row}`);
      }
      return;
    }
    if (role === "ptt") {
      await this.#stopLegacyVoice(`key:${coordinates.column}:${coordinates.row}`);
      return;
    }
    if (settings.shortcut) return;
  }

  releaseVoiceToggleKey(actionId: string): void {
    this.#voiceTogglePressOwners.delete(`key:${actionId}`);
  }

  async rotateEncoder(settings: EncoderSettings, coordinates: DeckCoordinates, ticks: number): Promise<EncoderSettings> {
    if (!ticks || this.voiceActive) return settings;
    const role = encoderRole(settings, coordinates);
    const direction = ticks > 0 ? 1 : -1;
    const tickCount = Math.min(8, Math.max(1, Math.abs(Math.trunc(ticks))));
    const override = direction > 0 ? settings.clockwiseShortcut : settings.counterClockwiseShortcut;
    if (override) {
      await repeat(tickCount, () => this.#codex.runShortcutText(override));
      return settings;
    }
    if (isConfigControlRole(role)) {
      // A previous save/live update may still be reconciling the shared
      // snapshot. Stage this detent only after that operation settles so an
      // older merge cannot erase the user's newer selection.
      await this.#controlApplyQueue;
      this.#cycleConfigControl(role, direction * tickCount);
    } else if (role === "legacy-reasoning") {
      await repeat(tickCount, () => this.#codex.runPaletteCommand(direction > 0 ? "reasoning-up" : "reasoning-down"));
    } else if (role === "navigation") {
      await repeat(tickCount, () => this.#codex.navigate(direction > 0 ? "forward" : "back"));
    } else if (role === "skills") {
      const modeIndex = normalizeModeIndex((settings.modeIndex ?? 0) + ticks, SKILL_DIAL_MODES.length);
      this.#notify();
      return { ...settings, modeIndex };
    } else if (role === "composer" || role === "voice") {
      await repeat(tickCount, () => this.#codex.runShortcutText(direction > 0 ? "right" : "left"));
    } else if (role === "review") {
      await repeat(tickCount, () => this.#codex.navigate(direction > 0 ? "forward" : "back"));
    }
    this.#notify();
    return settings;
  }

  async pressEncoder(
    settings: EncoderSettings,
    coordinates: DeckCoordinates,
    source: "press" | "auto" = "press"
  ): Promise<ControlApplyOutcome | undefined> {
    if (this.voiceActive) return undefined;
    if (source === "press" && settings.pressShortcut) {
      await this.#codex.runShortcutText(settings.pressShortcut);
      return undefined;
    }
    const role = encoderRole(settings, coordinates);
    if (isConfigControlRole(role)) return this.#applyConfigControl(role, source);
    if (role === "legacy-reasoning") await this.#codex.runPaletteCommand("reasoning-open");
    else if (role === "navigation") await this.#codex.runShortcutText("cmd+b");
    else if (role === "skills") await this.#runSkillMode(settings.modeIndex);
    else if (role === "review") await this.#codex.runPaletteCommand("review");
    else if (role !== "composer" && role !== "voice") await this.#codex.openApp();
  }

  async dialDown(
    settings: EncoderSettings,
    coordinates: DeckCoordinates,
    actionId?: string
  ): Promise<VoiceToggleResult | void> {
    const role = encoderRole(settings, coordinates);
    const owner = `dial:${actionId ?? `${coordinates.column}:${coordinates.row}`}`;
    if (isConfigControlRole(role)) {
      if (this.#voiceTogglePressOwners.has(owner)) return "ignored";
      this.#voiceTogglePressOwners.add(owner);
      return this.#toggleDialDictation();
    }
    if (role !== "composer" && role !== "voice") return;
    await this.#startLegacyVoice(owner);
  }

  async dialUp(
    settings: EncoderSettings,
    coordinates: DeckCoordinates,
    actionId?: string
  ): Promise<void> {
    const role = encoderRole(settings, coordinates);
    const owner = `dial:${actionId ?? `${coordinates.column}:${coordinates.row}`}`;
    this.#voiceTogglePressOwners.delete(owner);
    if (isConfigControlRole(role)) return;
    if (role !== "composer" && role !== "voice") return;
    await this.#stopLegacyVoice(owner);
  }

  async releaseDial(actionId: string): Promise<void> {
    const owner = `dial:${actionId}`;
    this.#voiceTogglePressOwners.delete(owner);
    await this.#stopLegacyVoice(owner);
  }

  async touchEncoder(settings: EncoderSettings, coordinates: DeckCoordinates, hold: boolean): Promise<void> {
    if (this.voiceActive) return;
    const role = encoderRole(settings, coordinates);
    if (isConfigControlRole(role)) {
      if (role === "approval") this.#clearFullAccessConfirmation();
      if (hold) await this.#resetConfigControl(role);
      else await this.reloadConfigControls();
    }
    else if (role === "legacy-reasoning") await this.#codex.runPaletteCommand(hold ? "plan" : "fast");
    else if (role === "navigation") await this.#codex.runShortcutText(hold ? "cmd+option+n" : "cmd+n");
    else if (role === "skills") await this.#codex.runPaletteCommand(hold ? "review" : "skills");
    else if (role === "composer" || role === "voice") {
      if (hold) await this.#codex.runPaletteCommand("fork");
      else await this.#codex.runCommand("submit");
    } else if (role === "review") await this.#codex.runPaletteCommand("review");
  }

  async #runKeyRole(role: KeyRole): Promise<void> {
    if (role === "approve" || role === "decline") {
      if (this.#approvalInFlight) throw new Error("An approval action is already in progress");
      if (!this.#follower.isConnected) {
        throw new Error("Codex Desktop is not reachable; open the Codex app and retry");
      }
      // Approval state comes from the live Desktop IPC stream: rollout files
      // never contain approval requests, so only the follower can see amber.
      const actionable = [...this.#actionableApprovals().entries()];
      if (!actionable.length) throw new Error("No Codex task is waiting for approval");
      const target = this.#resolveActionableApprovalTarget(actionable);
      if (!target) {
        throw new Error("Select the amber Codex task before approving or declining");
      }
      const [threadId, requests] = target;
      if (requests.length !== 1) {
        throw new Error("This Codex task has multiple approval requests; resolve them inside Codex");
      }
      const request = requests[0]!;
      this.#approvalInFlight = true;
      try {
        await this.#follower.decideApproval(threadId, request, role === "approve" ? "accept" : "decline");
        this.#mergeThreads();
        this.#notify();
      } finally {
        this.#approvalInFlight = false;
      }
      return;
    }
    if (role === "submit" || role === "new-chat" || role === "interrupt") {
      await this.#codex.runCommand(role);
    } else if (role === "fast" || role === "fork" || role === "skills" || role === "review") {
      await this.#codex.runPaletteCommand(role);
    } else if (role === "open-codex") {
      await this.#codex.openApp();
    } else if (role === "refresh") {
      await this.poll();
    }
  }

  async #runSkillMode(index: number | undefined): Promise<void> {
    const mode = SKILL_DIAL_MODES[normalizeModeIndex(index, SKILL_DIAL_MODES.length)] ?? "skills";
    await this.#codex.runPaletteCommand(mode);
  }

  async reloadConfigControls(): Promise<void> {
    await this.#enqueueControlApply(async () => {
      this.#adoptControlSnapshot(await this.#config.read());
      this.#notify();
    });
  }

  async #applyConfigControl(
    role: ConfigControlRole,
    source: "press" | "auto" = "press"
  ): Promise<ControlApplyOutcome> {
    const value = this.#controlSelection[role];
    let outcome: ControlApplyOutcome = "default";
    await this.#enqueueControlApply(async () => {
      if (role === "approval") {
        if (!isAccessMode(value)) {
          throw new Error("Legacy Access value is read-only; rotate to Ask, Delegate, Full, or Custom before applying");
        }
        // A physical press keeps the former Full double-confirmation as an
        // immediate-apply safeguard. A settled rotation is the user's chosen
        // hands-free path and applies Full exactly once after its longer wait.
        if (value === "full" && source !== "auto" && !this.#confirmFullAccess()) {
          this.#showControlFeedback(role, "confirm");
          outcome = "confirmation";
          return;
        }
        this.#clearFullAccessConfirmation();
        this.#accessMode = toAccessMode(value);
        this.#hasPersistedAccessMode = true;
        this.#settings = { ...this.#settings, accessMode: this.#accessMode };
        // Ask, Delegate, and Full establish the new-task default too. Custom
        // is intentionally read-only: it applies the current config.toml
        // values to tracked tasks without changing that file.
        const snapshot = this.#accessMode === "custom"
          ? await this.#config.read()
          : await this.#config.applyControl(role, this.#accessMode);
        this.#mergeAppliedControlSnapshot(snapshot, role);
        await this.#persistSettings();
        outcome = await this.#syncTrackedControls(role);
        return;
      }
      const snapshot = await this.#config.applyControl(role, value);
      this.#mergeAppliedControlSnapshot(snapshot, role);
      outcome = await this.#syncTrackedControls(role);
    });
    return outcome;
  }

  async #resetConfigControl(role: ConfigControlRole): Promise<ControlApplyOutcome> {
    let outcome: ControlApplyOutcome = "default";
    await this.#enqueueControlApply(async () => {
      if (role === "approval") {
        this.#clearFullAccessConfirmation();
        this.#accessMode = "ask";
        this.#hasPersistedAccessMode = true;
        this.#settings = { ...this.#settings, accessMode: this.#accessMode };
        this.#mergeAppliedControlSnapshot(await this.#config.resetControl(role), role);
        await this.#persistSettings();
        outcome = await this.#syncTrackedControls(role);
        return;
      }
      const snapshot = await this.#config.resetControl(role);
      this.#mergeAppliedControlSnapshot(snapshot, role);
      outcome = await this.#syncTrackedControls(role);
    });
    return outcome;
  }

  #enqueueControlApply(operation: () => Promise<void>): Promise<void> {
    const result = this.#controlApplyQueue.then(operation);
    this.#controlApplyQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #syncTrackedControls(role: ConfigControlRole): Promise<ControlApplyOutcome> {
    const targets = this.#trackedThreadIds();
    // Include the task currently open in Codex Desktop even when Agent keys
    // already track other tasks. Ambiguous and missing live targets add nothing.
    const liveTarget = this.#resolveLiveTarget();
    if (liveTarget.kind === "target" && !targets.includes(liveTarget.target)) {
      targets.push(liveTarget.target);
    }
    if (!targets.length) {
      this.#showControlFeedback(role, "default");
      return "default";
    }
    const patch = threadSettingsForSnapshot(this.#controlSnapshot, this.#accessMode);
    const followed = new Set(
      this.#follower.desktopFollowedIds.filter((id) => CONVERSATION_ID_PATTERN.test(id))
    );
    // Begin the optional Desktop refresh before booting the isolated App
    // Server. The batch still waits for every refresh to settle below, so a
    // slow older IPC request cannot overtake the next queued dial snapshot.
    // It is deliberately best effort: only the App Server readback counts as
    // a durable next-turn setting.
    const desktopHotRefreshes = targets.map((conversationId) => {
      if (!followed.has(conversationId)) return Promise.resolve();
      try {
        return Promise.resolve(this.#follower.updateThreadSettings(conversationId, patch))
          .catch(() => undefined);
      } catch {
        // Defensive for external follower implementations that violate the
        // async contract by throwing before returning a Promise.
        return Promise.resolve();
      }
    });
    let appServerUsed = false;
    const updateViaAppServer = async (conversationId: string): Promise<void> => {
      await this.#appServer.request(
        "thread/resume",
        { threadId: conversationId, excludeTurns: true },
        APP_SERVER_SETTINGS_TIMEOUT_MS
      );
      await this.#appServer.request(
        "thread/settings/update",
        { threadId: conversationId, ...patch },
        APP_SERVER_SETTINGS_TIMEOUT_MS
      );
      let verified = await this.#appServer.request(
        "thread/resume",
        { threadId: conversationId, excludeTurns: true },
        APP_SERVER_SETTINGS_TIMEOUT_MS
      );
      if (!threadSettingsMatchResume(verified, patch)) {
        // A resumed task can race with another local settings writer. Retry the
        // exact patch once, then fail honestly instead of showing a false ✓.
        await this.#appServer.request(
          "thread/settings/update",
          { threadId: conversationId, ...patch },
          APP_SERVER_SETTINGS_TIMEOUT_MS
        );
        verified = await this.#appServer.request(
          "thread/resume",
          { threadId: conversationId, excludeTurns: true },
          APP_SERVER_SETTINGS_TIMEOUT_MS
        );
      }
      if (!threadSettingsMatchResume(verified, patch)) {
        throw new Error("Codex task settings verification failed");
      }
    };
    // Keep one deterministic batch inside #controlApplyQueue. A later dial
    // cannot overtake this snapshot while any Agent task is still updating.
    // Within the batch the App Server is shared, while each exact thread keeps
    // its own resume -> update -> readback order. This removes avoidable
    // cross-task latency without allowing settings from a later batch to win
    // out of order.
    try {
      appServerUsed = true;
      const appServerStart = (async () => {
        const cliPath = await this.#resolveCodexCliPath();
        await this.#appServer.start(cliPath, { experimentalApi: true });
      })();
      const results = await Promise.all(targets.map(async (conversationId) => {
        try {
          await appServerStart;
          await updateViaAppServer(conversationId);
          return { succeeded: true as const };
        } catch (error) {
          return {
            succeeded: false as const,
            failure: error instanceof Error ? error.message : "task settings update failed"
          };
        }
      }));
      const synced = results.filter((result) => result.succeeded).length;
      const failures = results.flatMap((result) => result.succeeded ? [] : [result.failure]);
      if (synced === targets.length) {
        this.#clearControlFeedback(role);
        this.#notify();
        return "applied";
      }
      if (synced > 0) {
        this.#showControlFeedback(role, "partial", { synced, total: targets.length });
        throw new Error(
          `Default saved; synced ${synced}/${targets.length} tracked tasks. Partial sync; retry`
        );
      }
      this.#showControlFeedback(role, "warning", { synced: 0, total: targets.length });
      const reason = failures[0] ? `: ${failures[0]}` : "";
      throw new Error(`Default saved, but live sync failed for all ${targets.length} tracked tasks${reason}`);
    } finally {
      await Promise.allSettled(desktopHotRefreshes);
      if (appServerUsed) await this.#appServer.stop().catch(() => undefined);
    }
  }

  #actionableApprovals(): Map<string, PendingApproval[]> {
    const result = new Map<string, PendingApproval[]>();
    for (const [conversationId, requests] of this.#follower.pendingApprovals()) {
      const actionable = requests.filter(
        (request) => request.kind === "command" || request.kind === "file"
      );
      if (actionable.length) result.set(conversationId, actionable);
    }
    return result;
  }

  #trackedThreadIds(): string[] {
    const resolved = this.#agentSlotAssignments.map((slot, index) => (
      slot?.autoEnabled ? this.#autoAssignedThreadIds[index] : slot?.fixedId
    ));
    return uniqueTrackedThreadIds(resolved);
  }

  /**
   * Removes the assignment owned by a key action that no longer represents
   * its previous Agent role. The old settings and coordinates are required so
   * a role-less default key clears the correct logical Agent index.
   */
  clearAgentSlot(
    settings: KeySettings,
    coordinates: DeckCoordinates,
    ownerId?: string
  ): void {
    const index = agentIndex(keyRole(settings, coordinates));
    if (index === undefined) return;
    const current = this.#agentSlotAssignments[index];
    if (!current) return;
    const expected = agentSlotAssignment(settings);
    if (current.autoEnabled !== expected.autoEnabled || current.fixedId !== expected.fixedId) return;
    if (ownerId && current.ownerId && current.ownerId !== ownerId) return;
    this.#agentSlotAssignments[index] = undefined;
    this.#syncFollowerDesiredConversations();
  }

  #rememberAgentSlot(index: number, settings: KeySettings, ownerId?: string): void {
    const autoEnabled = settings.autoAssign !== false;
    const fixedId = !autoEnabled
      && settings.threadId
      && CONVERSATION_ID_PATTERN.test(settings.threadId)
      ? settings.threadId
      : undefined;
    const current = this.#agentSlotAssignments[index];
    if (current?.autoEnabled === autoEnabled
      && current.fixedId === fixedId
      && (!ownerId || current.ownerId === ownerId)) return;
    this.#agentSlotAssignments[index] = {
      autoEnabled,
      ...(fixedId ? { fixedId } : {}),
      ...(ownerId ? { ownerId } : {})
    };
    this.#syncFollowerDesiredConversations();
  }

  #syncFollowerDesiredConversations(): void {
    this.#follower.setDesiredConversations(this.#trackedThreadIds());
  }

  #resolveActionableApprovalTarget(
    actionable: ReadonlyArray<readonly [string, PendingApproval[]]>
  ): readonly [string, PendingApproval[]] | undefined {
    if (actionable.length === 1) return actionable[0];
    const byConversation = new Map(actionable);
    if (this.#selectedThreadId) {
      const selectedRequests = byConversation.get(this.#selectedThreadId);
      if (selectedRequests) return [this.#selectedThreadId, selectedRequests];
    }
    const liveTarget = this.#resolveLiveTarget();
    if (liveTarget.kind === "target") {
      const requests = byConversation.get(liveTarget.target);
      if (requests) return [liveTarget.target, requests];
    }
    return undefined;
  }

  #resolveLiveTarget(): LiveTargetResolution {
    const followed = this.#follower.desktopFollowedIds;
    // The Desktop often follows an empty new-tab conversation next to the real
    // task; tasks known to the local state DB disambiguate those cases.
    const known = new Set(this.#rawThreads.map((thread) => thread.id));
    if (followed.length === 1 && followed[0]) {
      const single = followed[0];
      if (known.has(single) || !this.#selectedThreadId) return { kind: "target", target: single };
      // A lone scratch tab unknown to the state DB loses to an explicit
      // Agent-key selection.
      return { kind: "target", target: this.#selectedThreadId };
    }
    if (followed.length === 0) {
      return this.#selectedThreadId
        ? { kind: "target", target: this.#selectedThreadId }
        : { kind: "none" };
    }
    if (this.#selectedThreadId && followed.includes(this.#selectedThreadId)) {
      return { kind: "target", target: this.#selectedThreadId };
    }
    const knownFollowed = followed.filter((id) => known.has(id));
    if (knownFollowed.length === 1 && knownFollowed[0]) {
      return { kind: "target", target: knownFollowed[0] };
    }
    return { kind: "ambiguous" };
  }

  #cycleConfigControl(role: ConfigControlRole, ticks: number): void {
    this.#clearControlFeedback(role);
    if (role === "approval") this.#clearFullAccessConfirmation();
    const options = this.#controlOptions(role);
    if (!options.length) return;
    const current = this.#controlSelection[role];
    // A legacy config value is display-only.  Treat the first positive detent
    // as an explicit move to the safest writable Access preset (Ask), rather
    // than accidentally skipping it to Delegate just because the legacy value
    // is not present in the four current options.
    const configuredIndex = options.indexOf(current);
    const currentIndex = configuredIndex === -1 ? -1 : configuredIndex;
    this.#controlSelection[role] = options[normalizeModeIndex(currentIndex + ticks, options.length)]!;
    if (this.#controlSelection[role] === this.#appliedControlValue(role)) {
      this.#pendingControlRoles.delete(role);
    } else {
      this.#pendingControlRoles.add(role);
    }
  }

  #controlOptions(role: ConfigControlRole): string[] {
    if (role === "model") return this.#controlSnapshot.models.map((model) => model.id);
    if (role === "reasoning") {
      const selectedModel = this.#controlSnapshot.models.find(
        (model) => model.id === this.#controlSelection.model
      ) ?? this.#controlSnapshot.models[0];
      return selectedModel?.reasoning ?? ["low", "medium", "high", "xhigh"];
    }
    if (role === "speed") return ["standard", "fast"];
    return ["ask", "delegate", "full", "custom"];
  }

  #controlDisplayValue(role: ConfigControlRole): string {
    const value = this.#controlSelection[role];
    if (role === "model") {
      return this.#controlSnapshot.models.find((model) => model.id === value)?.label ?? "5.6 Sol";
    }
    const labels: Record<string, string> = {
      low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", ultra: "Ultra",
      standard: "Standard", fast: "Fast", flex: "Flex",
      ask: "Ask", delegate: "Delegate", full: "Full", custom: "Custom",
      strict: "Strict", auto: "Auto", never: "Never"
    };
    return labels[value] ?? value;
  }

  #adoptControlSnapshot(snapshot: CodexControlSnapshot): void {
    this.#controlSnapshot = cloneControlSnapshot(snapshot);
    if (!this.#hasPersistedAccessMode) this.#accessMode = inferAccessModeFromSnapshot(snapshot);
    this.#controlSelection = selectionFromSnapshot(this.#controlSnapshot);
    this.#controlSelection.approval = this.#accessMode;
    this.#pendingControlRoles.clear();
    this.#clearAllControlSuccess();
  }

  #mergeAppliedControlSnapshot(snapshot: CodexControlSnapshot, appliedRole: ConfigControlRole): void {
    const pendingSelections = { ...this.#controlSelection };
    const pendingRoles = new Set(this.#pendingControlRoles);
    pendingRoles.delete(appliedRole);

    this.#controlSnapshot = cloneControlSnapshot(snapshot);
    if (!this.#hasPersistedAccessMode) this.#accessMode = inferAccessModeFromSnapshot(snapshot);
    this.#controlSelection = selectionFromSnapshot(this.#controlSnapshot);
    this.#controlSelection.approval = this.#accessMode;
    this.#pendingControlRoles.clear();
    const appliedSelections = selectionFromSnapshot(this.#controlSnapshot);
    appliedSelections.approval = this.#accessMode;
    // Restore model before reasoning so reasoning validation uses the model the
    // user has staged, regardless of which physical dial was turned first.
    for (const role of ["model", "reasoning", "speed", "approval"] as const) {
      if (!pendingRoles.has(role)) continue;
      const value = pendingSelections[role];
      if (!this.#isValidControlSelection(role, value)) continue;
      this.#controlSelection[role] = value;
      if (value !== appliedSelections[role]) {
        this.#pendingControlRoles.add(role);
      }
    }
  }

  #isValidControlSelection(role: ConfigControlRole, value: string): boolean {
    if (role === "model") return this.#controlSnapshot.models.some((model) => model.id === value);
    if (role === "reasoning") {
      const selectedModel = this.#controlSnapshot.models.find(
        (model) => model.id === this.#controlSelection.model
      ) ?? this.#controlSnapshot.models[0];
      return Boolean(selectedModel?.reasoning.includes(value));
    }
    if (role === "speed") return value === "standard" || value === "fast" || value === "flex";
    return value === "ask" || value === "delegate" || value === "full" || value === "custom"
      || value === "strict" || value === "auto" || value === "never";
  }

  #appliedControlValue(role: ConfigControlRole): string {
    return role === "approval" ? this.#accessMode : selectionFromSnapshot(this.#controlSnapshot)[role];
  }

  #confirmFullAccess(): boolean {
    const now = Date.now();
    if (this.#fullAccessConfirmationExpiresAt && this.#fullAccessConfirmationExpiresAt >= now) return true;
    this.#fullAccessConfirmationExpiresAt = now + FULL_ACCESS_CONFIRMATION_MS;
    return false;
  }

  #clearFullAccessConfirmation(): void {
    this.#fullAccessConfirmationExpiresAt = undefined;
  }

  #showControlFeedback(
    role: ConfigControlRole,
    kind: ControlFeedbackKind,
    counts?: { synced: number; total: number }
  ): void {
    this.#clearControlFeedback(role);
    const duration = kind === "confirm"
      ? FULL_ACCESS_CONFIRMATION_MS
      : kind === "warning" || kind === "partial"
      ? CONTROL_WARNING_FEEDBACK_MS
      : CONTROL_SUCCESS_FEEDBACK_MS;
    const expiresAt = Date.now() + duration;
    this.#controlFeedback.set(role, {
      kind,
      expiresAt,
      ...(counts ? counts : {})
    });
    const timer = setTimeout(() => {
      if (this.#controlFeedback.get(role)?.expiresAt !== expiresAt) return;
      this.#controlFeedback.delete(role);
      this.#controlSuccessTimers.delete(role);
      this.#notify();
    }, duration);
    timer.unref();
    this.#controlSuccessTimers.set(role, timer);
    this.#notify();
  }

  #clearControlFeedback(role: ConfigControlRole): void {
    const timer = this.#controlSuccessTimers.get(role);
    if (timer) clearTimeout(timer);
    this.#controlSuccessTimers.delete(role);
    this.#controlFeedback.delete(role);
  }

  #clearAllControlSuccess(): void {
    for (const timer of this.#controlSuccessTimers.values()) clearTimeout(timer);
    this.#controlSuccessTimers.clear();
    this.#controlFeedback.clear();
  }

  #restartPollTimer(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    const interval = this.#settings.pollIntervalMs ?? DEFAULT_GLOBAL_SETTINGS.pollIntervalMs;
    this.#pollTimer = setInterval(() => void this.poll().catch(() => undefined), interval);
    this.#pollTimer.unref();
  }

  async #persistSettings(): Promise<void> {
    const next: GlobalSettings = { ...this.#settings, seenThreads: this.#unread.snapshot() };
    if (this.#selectedThreadId) {
      next.selectedThreadId = this.#selectedThreadId;
      if (this.#selectedAutoAssigned) delete next.selectedThreadPinned;
      else next.selectedThreadPinned = true;
    } else {
      delete next.selectedThreadId;
      delete next.selectedThreadPinned;
    }
    this.#settings = next;
    try {
      await this.#persist?.(this.globalSettings);
    } catch {
      // Stream Deck settings persistence is best-effort. A transient host
      // failure must never make an otherwise successful agent press look broken.
    }
  }

  #reconcileAutoAssignments(): void {
    const available = new Map(this.#threads.map((thread) => [thread.id, thread]));
    const used = new Set<string>();
    const next = this.#autoAssignedThreadIds.map((id) => {
      if (!id || !available.has(id) || used.has(id)) return undefined;
      used.add(id);
      return id;
    });
    for (let index = 0; index < next.length; index += 1) {
      if (next[index]) continue;
      const replacement = this.#threads.find((thread) => !used.has(thread.id));
      if (!replacement) continue;
      next[index] = replacement.id;
      used.add(replacement.id);
    }
    this.#autoAssignedThreadIds = next;
  }

  async #toggleDialDictation(): Promise<VoiceToggleResult> {
    if (this.#voiceToggleInFlight) return "ignored";
    this.#voiceToggleInFlight = true;
    try {
      if (this.#legacyVoiceOwner !== undefined || this.#legacyVoiceActuallyActive) {
        throw new Error("Legacy push-to-talk is already controlling Codex dictation");
      }
      if (!this.#dialDictationActive) {
        const result = await this.#codex.startDictation();
        this.#dialDictationActive = true;
        this.#notify();
        return result === "already-active" ? "synced" : "started";
      }
      let result: DictationStopResult | void;
      try {
        result = await this.#codex.stopDictation("send");
      } catch (error) {
        this.#dialDictationActive = false;
        this.#notify();
        throw error;
      }
      this.#dialDictationActive = false;
      this.#notify();
      return result === "already-idle" ? "already-idle" : "sent";
    } finally {
      this.#voiceToggleInFlight = false;
    }
  }

  async #startLegacyVoice(owner: string): Promise<void> {
    if (this.#dialDictationActive) {
      throw new Error("Toggle dictation is already active");
    }
    if (this.#legacyVoiceOwner === owner) return;
    if (this.#legacyVoiceOwner !== undefined) return;
    this.#legacyVoiceOwner = owner;
    try {
      await this.#queueLegacyVoiceSync();
    } catch (error) {
      if (this.#legacyVoiceOwner === owner && !this.#legacyVoiceActuallyActive) {
        this.#legacyVoiceOwner = undefined;
      }
      throw error;
    }
  }

  async #stopLegacyVoice(owner: string): Promise<void> {
    if (this.#legacyVoiceOwner !== owner) return;
    this.#legacyVoiceOwner = undefined;
    try {
      await this.#queueLegacyVoiceSync();
    } catch (error) {
      this.#legacyVoiceOwner = undefined;
      this.#legacyVoiceActuallyActive = false;
      this.#notify();
      throw error;
    }
  }

  #queueLegacyVoiceSync(): Promise<void> {
    const operation = this.#legacyVoiceSync.then(async () => {
      const shouldBeActive = this.#legacyVoiceOwner !== undefined;
      if (shouldBeActive === this.#legacyVoiceActuallyActive) return;
      if (shouldBeActive) await this.#codex.startDictation();
      else await this.#codex.stopDictation("insert");
      this.#legacyVoiceActuallyActive = shouldBeActive;
      this.#notify();
    });
    this.#legacyVoiceSync = operation.catch(() => undefined);
    return operation;
  }

  #notify(): void {
    this.#notifyListeners(this.#listeners);
    this.#notifyListeners(this.#encoderListeners);
  }

  #notifyEncoders(): void {
    this.#notifyListeners(this.#encoderListeners);
  }

  #notifyListeners(listeners: ReadonlySet<ChangeListener>): void {
    for (const listener of listeners) {
      Promise.resolve(listener()).catch(() => undefined);
    }
  }
}

export function keyRole(settings: KeySettings, coordinates: DeckCoordinates): KeyRole {
  return settings.role ?? defaultKeyRole(coordinates.column, coordinates.row);
}

export function encoderRole(settings: EncoderSettings, coordinates: DeckCoordinates): EncoderRole {
  return settings.role ?? defaultEncoderRole(coordinates.column);
}

function resolveAgentThread(
  settings: KeySettings,
  index: number,
  threads: readonly ThreadSnapshot[],
  autoAssignedThreadIds: readonly (string | undefined)[]
): ThreadSnapshot | undefined {
  if (settings.autoAssign === false) {
    if (!settings.threadId) return undefined;
    return threads.find((thread) => thread.id === settings.threadId) ?? {
      id: settings.threadId,
      title: "Pinned task",
      updatedAt: 0,
      phase: "idle"
    };
  }
  const assignedId = autoAssignedThreadIds[index];
  return assignedId ? threads.find((thread) => thread.id === assignedId) : undefined;
}

function displayMode(mode: SkillDialMode): string {
  const labels: Record<SkillDialMode, string> = {
    skills: "Skills", review: "Review", plan: "Plan", fast: "Fast"
  };
  return labels[mode];
}

function normalizeGlobalSettings(settings: GlobalSettings): GlobalSettings {
  const requestedInterval = Number(settings.pollIntervalMs);
  const pollIntervalMs = Number.isFinite(requestedInterval)
    ? Math.max(1000, Math.min(30000, requestedInterval))
    : DEFAULT_GLOBAL_SETTINGS.pollIntervalMs;
  const selectedThreadId = typeof settings.selectedThreadId === "string"
    && /^[0-9a-f-]{16,64}$/i.test(settings.selectedThreadId)
    ? settings.selectedThreadId
    : undefined;
  const accessMode = isAccessMode(settings.accessMode) ? settings.accessMode : undefined;
  return {
    accessibilityEnabled: settings.accessibilityEnabled ?? DEFAULT_GLOBAL_SETTINGS.accessibilityEnabled,
    pollIntervalMs,
    ...(accessMode ? { accessMode } : {}),
    seenThreads: normalizeSeenThreads(settings.seenThreads),
    ...(selectedThreadId !== undefined ? { selectedThreadId } : {}),
    ...(selectedThreadId !== undefined && settings.selectedThreadPinned === true
      ? { selectedThreadPinned: true }
      : {})
  };
}

function normalizeSeenThreads(value: GlobalSettings["seenThreads"]): NonNullable<GlobalSettings["seenThreads"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: NonNullable<GlobalSettings["seenThreads"]> = {};
  for (const [threadId, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const seenUpdatedAt = Number(entry.seenUpdatedAt);
    if (!Number.isFinite(seenUpdatedAt) || seenUpdatedAt < 0) continue;
    result[threadId] = { seenUpdatedAt, unread: entry.unread === true };
  }
  return result;
}

function defaultControlSnapshot(): CodexControlSnapshot {
  const models = FALLBACK_MODELS.map((model) => ({ ...model, reasoning: [...model.reasoning] }));
  const model = models[0]!;
  return {
    models,
    model: model.id,
    reasoning: model.defaultReasoning,
    speed: "standard",
    approval: "ask",
    customAccess: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false }
    }
  };
}

function cloneControlSnapshot(snapshot: CodexControlSnapshot): CodexControlSnapshot {
  const customAccess = snapshot.customAccess ?? defaultCustomAccess();
  return {
    ...snapshot,
    models: snapshot.models.map((model) => ({ ...model, reasoning: [...model.reasoning] })),
    customAccess: {
      ...customAccess,
      sandboxPolicy: customAccess.sandboxPolicy.type === "workspaceWrite"
        ? { ...customAccess.sandboxPolicy, writableRoots: [...customAccess.sandboxPolicy.writableRoots] }
        : { ...customAccess.sandboxPolicy }
    }
  };
}

function defaultCustomAccess(): CodexControlSnapshot["customAccess"] {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false }
  };
}

/**
 * On the first run there is no saved Deck Access choice yet. Prefer the
 * complete config.toml-derived settings over the old approval-only display so
 * a mixed configuration cannot masquerade as Ask. Older snapshots that did
 * not expose customAccess retain their historical approval display.
 */
function inferAccessModeFromSnapshot(
  snapshot: Pick<CodexControlSnapshot, "approval"> & Partial<Pick<CodexControlSnapshot, "customAccess">>
): AccessMode | ApprovalSetting {
  const access = snapshot.customAccess;
  if (!access) return snapshot.approval;

  const isWorkspaceDefault = access.sandboxPolicy.type === "workspaceWrite"
    && access.sandboxPolicy.writableRoots.length === 0
    && access.sandboxPolicy.networkAccess === false
    && access.sandboxPolicy.excludeTmpdirEnvVar === false
    && access.sandboxPolicy.excludeSlashTmp === false;
  if (access.approvalPolicy === "on-request"
    && access.approvalsReviewer === "user"
    && isWorkspaceDefault) {
    return "ask";
  }
  if (access.approvalPolicy === "on-request"
    && (access.approvalsReviewer === "guardian_subagent" || access.approvalsReviewer === "auto_review")
    && isWorkspaceDefault) {
    return "delegate";
  }
  if (access.approvalPolicy === "never"
    && access.approvalsReviewer === "user"
    && access.sandboxPolicy.type === "dangerFullAccess") {
    return "full";
  }
  return "custom";
}

function selectionFromSnapshot(snapshot: CodexControlSnapshot): Record<ConfigControlRole, string> {
  return {
    model: snapshot.model,
    reasoning: snapshot.reasoning,
    speed: snapshot.speed,
    approval: snapshot.approval
  };
}

function agentSlotAssignment(settings: KeySettings): AgentSlotAssignment {
  const autoEnabled = settings.autoAssign !== false;
  const fixedId = !autoEnabled
    && settings.threadId
    && CONVERSATION_ID_PATTERN.test(settings.threadId)
    ? settings.threadId
    : undefined;
  return {
    autoEnabled,
    ...(fixedId ? { fixedId } : {})
  };
}

function uniqueTrackedThreadIds(...groups: ReadonlyArray<readonly (string | undefined)[]>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ids of groups) {
    for (const id of ids) {
      if (!id || !CONVERSATION_ID_PATTERN.test(id) || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function isConfigControlRole(role: EncoderRole): role is ConfigControlRole {
  return role === "model" || role === "reasoning" || role === "speed" || role === "approval";
}

function pendingApplyHint(role: ConfigControlRole): string {
  if (role === "approval") return "auto in 80ms · next turn";
  return "auto apply · next turn";
}

function isAccessMode(value: unknown): value is AccessMode {
  return value === "ask" || value === "delegate" || value === "full" || value === "custom";
}

function toAccessMode(value: string): AccessMode {
  if (isAccessMode(value)) return value;
  throw new Error("Unsupported Codex Access selection");
}

async function repeat(count: number, operation: () => Promise<void>): Promise<void> {
  for (let index = 0; index < count; index += 1) await operation();
}
