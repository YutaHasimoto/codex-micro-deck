import streamDeck, {
  action,
  type DialAction as StreamDeckDialAction,
  type DialDownEvent,
  type DialRotateEvent,
  type DialUpEvent,
  type DidReceiveSettingsEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent
} from "@elgato/streamdeck";

import { CodexDeckCoordinator, encoderRole } from "../coordinator.js";
import { triggerDescriptionForRole } from "../core/encoder-triggers.js";
import {
  dialPhysicalRoute,
  dialUsesTrailingAutoApply,
  type TrailingAutoApplyRole
} from "../core/dial-routing.js";
import { safeActionError } from "../core/errors.js";
import { defaultEncoderRole } from "../core/model.js";
import { OrderedRotations } from "../core/ordered-rotations.js";
import { TrailingApplyScheduler } from "../core/trailing-apply.js";
import {
  renderEncoderFeedback,
  VOICE_WAVEFORM_INTERVAL_MS
} from "../render/encoder-feedback.js";
import { MicrophoneLevelMonitor } from "../system/microphone-level.js";
import {
  ENCODER_ACTION_UUID,
  type DeckCoordinates,
  type EncoderPresentation,
  type EncoderSettings
} from "../types.js";

@action({ UUID: ENCODER_ACTION_UUID })
export class CodexEncoderAction extends SingletonAction<EncoderSettings> {
  readonly #autoApply = new TrailingApplyScheduler<TrailingAutoApplyRole>();
  readonly #rotations = new OrderedRotations();
  readonly #rotationSettings = new Map<string, EncoderSettings>();
  readonly #disappearedDials = new Set<string>();
  #refreshQueued = false;
  #refreshPromise: Promise<void> | undefined;
  #voiceFrame = 0;
  #voiceLevel = 0;
  #voiceTransitions = 0;
  readonly #microphoneMonitor = new MicrophoneLevelMonitor({
    // This helper only animates the Deck waveform. Codex records through its
    // own microphone permission, so a denied helper must remain non-fatal.
    logger: (message) => streamDeck.logger.info(message)
  });

  constructor(readonly coordinator: CodexDeckCoordinator) {
    super();
    coordinator.onEncoderChange(() => {
      if (!coordinator.voiceActive) {
        this.#resetMicrophoneSession();
      }
      return this.refreshVisible();
    });
    const voiceTimer = setInterval(() => {
      if (!coordinator.voiceActive) {
        this.#resetMicrophoneSession();
        return;
      }
      this.#microphoneMonitor.start();
      this.#voiceLevel = this.#microphoneMonitor.level;
      this.#voiceFrame += 1;
      void this.refreshVisible();
    }, VOICE_WAVEFORM_INTERVAL_MS);
    voiceTimer.unref();
  }

  override async onWillAppear(event: WillAppearEvent<EncoderSettings>): Promise<void> {
    if (!event.action.isDial()) return;
    this.#disappearedDials.delete(event.action.id);
    this.#autoApply.cancel(event.action.id);
    const coordinates = event.action.coordinates;
    const settings = migrateEncoderSettings(event.payload.settings, coordinates.column);
    this.#rotationSettings.set(event.action.id, settings);
    if (settings !== event.payload.settings) {
      await event.action.setSettings(settings);
    }
    await this.render(event.action, settings, coordinates);
  }

  override async onDidReceiveSettings(event: DidReceiveSettingsEvent<EncoderSettings>): Promise<void> {
    if (!event.action.isDial()) return;
    this.#rotationSettings.set(event.action.id, event.payload.settings);
    await this.#autoApply.cancelAndWait(event.action.id);
    await this.render(event.action, event.payload.settings, event.action.coordinates);
  }

  override async onDialRotate(event: DialRotateEvent<EncoderSettings>): Promise<void> {
    const id = event.action.id;
    // Admit each detent before the first await. A running owner write can take
    // seconds, while the SDK can deliver more rotations in that interval.
    this.#autoApply.cancel(id);
    await this.#rotations.enqueue(id, async (isLast) => {
      let settings = this.#rotationSettings.get(id) ?? event.payload.settings;
      let succeeded = false;
      try {
        if (this.#voiceTransitions > 0 || this.coordinator.voiceActive) return;
        await this.#autoApply.cancelAndWait(id);
        if (this.#voiceTransitions > 0 || this.coordinator.voiceActive) return;
        const inputSettings = settings;
        settings = await this.coordinator.rotateEncoder(
          settings,
          event.action.coordinates,
          event.payload.ticks
        );
        if (settings !== inputSettings) await event.action.setSettings(settings);
        this.#rotationSettings.set(id, settings);
        succeeded = true;
      } catch (error) {
        this.#logFailure("rotate", event.payload.settings, event.action.coordinates, error);
        await event.action.showAlert().catch(() => undefined);
      } finally {
        // Only the last queued detent starts the quiet-period timer. This
        // avoids sending every intermediate selection during a fast spin.
        if (isLast()) {
          const role = encoderRole(settings, event.action.coordinates);
          if (!this.#disappearedDials.has(id) && succeeded && event.payload.ticks !== 0
            && dialUsesTrailingAutoApply(role)
            && !hasAutoApplyOverride(settings, event.payload.ticks, role)) {
            streamDeck.logger.info(`[dial:${role}:rotate] auto apply scheduled`);
            this.#scheduleTrailingApply(event.action, settings, event.action.coordinates, role);
          }
          if (!this.#disappearedDials.has(id)) {
            await this.render(event.action, settings, event.action.coordinates).catch((error) => {
              this.#logFailure("rotate-render", settings, event.action.coordinates, error);
            });
          }
        }
      }
    });
  }

  override async onDialDown(event: DialDownEvent<EncoderSettings>): Promise<void> {
    try {
      await this.#waitForRotations(event.action.id);
      const role = encoderRole(event.payload.settings, event.action.coordinates);
      const route = dialPhysicalRoute(role, "down");
      if (route === "voice-toggle") {
        const starting = !this.coordinator.voiceActive;
        if (starting) {
          this.#voiceTransitions += 1;
        }
        try {
          if (starting) {
            // Show an immediate full-strip waveform while Accessibility moves
            // focus and presses the real Codex composer button.
            await this.refreshVisible();
            await this.#autoApply.cancelAllAndWait();
          }
          const outcome = await this.coordinator.dialDown(
            event.payload.settings,
            event.action.coordinates,
            event.action.id
          );
          streamDeck.logger.info(`[dial:${role}:down] dictation ${outcome}`);
        } finally {
          if (starting) {
            this.#voiceTransitions = Math.max(0, this.#voiceTransitions - 1);
            await this.refreshVisible().catch(() => undefined);
          }
        }
      } else if (route === "voice-start") {
        await this.coordinator.dialDown(
          event.payload.settings,
          event.action.coordinates,
          event.action.id
        );
      } else if (route === "apply") {
        const settledAutoApply = await this.#autoApply.cancelAndWait(event.action.id);
        const alreadyApplied = settledAutoApply?.tag === role && settledAutoApply.succeeded;
        if (!alreadyApplied) {
          // A pressShortcut override runs a keyboard shortcut instead of a
          // config apply, so it must not be logged as one.
          const logsApply = isConfigRole(role) && !event.payload.settings.pressShortcut;
          if (logsApply) streamDeck.logger.info(`[dial:${role}:down] apply requested`);
          const outcome = await this.coordinator.pressEncoder(event.payload.settings, event.action.coordinates);
          if (logsApply) streamDeck.logger.info(`[dial:${role}:down] ${describeApplyOutcome(outcome)}`);
        }
      }
      await this.render(event.action, event.payload.settings, event.action.coordinates);
    } catch (error) {
      this.#logFailure("down", event.payload.settings, event.action.coordinates, error);
      await event.action.showAlert().catch(() => undefined);
    }
  }

  override async onDialUp(event: DialUpEvent<EncoderSettings>): Promise<void> {
    try {
      const role = event.payload.settings.role ?? defaultEncoderRole(event.action.coordinates.column);
      const route = dialPhysicalRoute(role, "up");
      if (route === "voice-release" || route === "voice-stop") {
        await this.coordinator.dialUp(
          event.payload.settings,
          event.action.coordinates,
          event.action.id
        );
      }
      await this.render(event.action, event.payload.settings, event.action.coordinates);
    } catch (error) {
      this.#logFailure("up", event.payload.settings, event.action.coordinates, error);
      await event.action.showAlert().catch(() => undefined);
    }
  }

  override async onTouchTap(event: TouchTapEvent<EncoderSettings>): Promise<void> {
    try {
      await this.#waitForRotations(event.action.id);
      await this.#autoApply.cancelAndWait(event.action.id);
      await this.coordinator.touchEncoder(
        event.payload.settings,
        event.action.coordinates,
        event.payload.hold
      );
      await this.render(event.action, event.payload.settings, event.action.coordinates);
    } catch (error) {
      this.#logFailure(event.payload.hold ? "hold" : "touch", event.payload.settings, event.action.coordinates, error);
      await event.action.showAlert().catch(() => undefined);
    }
  }

  override onWillDisappear(event: WillDisappearEvent<EncoderSettings>): void {
    this.#disappearedDials.add(event.action.id);
    this.#rotationSettings.delete(event.action.id);
    this.#autoApply.cancel(event.action.id);
    void this.coordinator.releaseDial(event.action.id).catch(() => undefined);
  }

  async refreshVisible(): Promise<void> {
    this.#refreshQueued = true;
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.#drainRefreshes().finally(() => {
        this.#refreshPromise = undefined;
      });
    }
    await this.#refreshPromise;
  }

  async #waitForRotations(id: string): Promise<void> {
    await this.#rotations.drain(id);
  }

  async #drainRefreshes(): Promise<void> {
    while (this.#refreshQueued) {
      this.#refreshQueued = false;
      const frame = this.#voiceFrame;
      const voiceLevel = this.#voiceLevel;
      const tasks: Promise<void>[] = [];
      this.actions.forEach((visibleAction) => {
        if (!visibleAction.isDial()) return;
        tasks.push((async () => {
          const settings = await visibleAction.getSettings<EncoderSettings>();
          try {
            await this.render(visibleAction, settings, visibleAction.coordinates, frame, voiceLevel);
          } catch (error) {
            this.#logFailure("refresh", settings, visibleAction.coordinates, error);
          }
        })());
      });
      await Promise.allSettled(tasks);
    }
  }

  private async render(
    actionInstance: StreamDeckDialAction<EncoderSettings>,
    settings: EncoderSettings,
    coordinates: DeckCoordinates,
    frame = this.#voiceFrame,
    voiceLevel = this.#voiceLevel
  ): Promise<void> {
    const presentation: EncoderPresentation =
      this.#voiceTransitions > 0 && !this.coordinator.voiceActive
        ? {
            color: "blue",
            title: "Voice",
            value: "",
            hint: "Starting dictation",
            mode: "voice",
            slice: coordinates.column
          }
        : this.coordinator.encoderPresentation(settings, coordinates);
    await Promise.all([
      actionInstance.setFeedback(renderEncoderFeedback(presentation, frame, voiceLevel)),
      actionInstance.setTriggerDescription(triggerDescriptionForRole(settings, coordinates))
    ]);
  }

  #resetMicrophoneSession(): void {
    this.#microphoneMonitor.stop();
    this.#voiceLevel = 0;
  }

  #scheduleTrailingApply(
    actionInstance: StreamDeckDialAction<EncoderSettings>,
    settings: EncoderSettings,
    coordinates: DeckCoordinates,
    role: TrailingAutoApplyRole
  ): void {
    this.#autoApply.schedule(actionInstance.id, role, async () => {
      streamDeck.logger.info(`[dial:${role}:auto] apply requested`);
      let outcome: Awaited<ReturnType<CodexDeckCoordinator["pressEncoder"]>>;
      try {
        outcome = await this.coordinator.pressEncoder(settings, coordinates, "auto");
      } catch (error) {
        this.#logFailure("auto", settings, coordinates, error);
        await actionInstance.showAlert().catch(() => undefined);
        return false;
      }
      streamDeck.logger.info(`[dial:${role}:auto] ${describeApplyOutcome(outcome)}`);
      try {
        await this.render(actionInstance, settings, coordinates);
      } catch (error) {
        this.#logFailure("auto-render", settings, coordinates, error);
      }
      return true;
    });
  }

  #logFailure(
    eventName: string,
    settings: EncoderSettings,
    coordinates: DeckCoordinates,
    error: unknown
  ): void {
    const role = encoderRole(settings, coordinates);
    streamDeck.logger.error(`[dial:${role}:${eventName}] ${safeActionError(error)}`);
  }
}

const LEGACY_DEFAULT_ENCODER_ROLES = ["reasoning", "navigation", "skills", "composer"] as const;
const ENCODER_LAYOUT_VERSION = 2;

/** Preserves customized mappings while upgrading untouched v1 profiles. */
export function migrateEncoderSettings(settings: EncoderSettings, column: number): EncoderSettings {
  if (settings.layoutVersion === ENCODER_LAYOUT_VERSION) return settings;
  const safeColumn = Math.max(0, Math.min(3, column));
  const legacyRole = LEGACY_DEFAULT_ENCODER_ROLES[safeColumn] ?? "reasoning";
  const hasShortcutOverride = Boolean(
    settings.counterClockwiseShortcut || settings.clockwiseShortcut || settings.pressShortcut
  );
  const shouldUseNewDefault = !hasShortcutOverride
    && (settings.role === undefined || settings.role === legacyRole);
  const preservedRole = (settings.role ?? legacyRole) === "reasoning"
    ? "legacy-reasoning"
    : (settings.role ?? legacyRole);
  return {
    ...settings,
    role: shouldUseNewDefault ? defaultEncoderRole(safeColumn) : preservedRole,
    layoutVersion: ENCODER_LAYOUT_VERSION
  };
}

function isConfigRole(role: EncoderSettings["role"]): boolean {
  return role === "model" || role === "reasoning" || role === "speed" || role === "approval";
}

function describeApplyOutcome(outcome: "applied" | "default" | "confirmation" | undefined): string {
  if (outcome === "applied") return "applied to tracked tasks and new default (next turn; running turn unchanged)";
  if (outcome === "default") return "saved as new-task default only (no live target)";
  if (outcome === "confirmation") return "Full Access awaiting second press";
  return "apply confirmed";
}

function hasAutoApplyOverride(
  settings: EncoderSettings,
  ticks: number,
  role: EncoderSettings["role"]
): boolean {
  // Focused dial presses are reserved for dictation. A legacy pressShortcut
  // must not disable their independent 300ms rotation apply.
  if (settings.pressShortcut && !isConfigRole(role)) return true;
  if (ticks > 0) return Boolean(settings.clockwiseShortcut);
  if (ticks < 0) return Boolean(settings.counterClockwiseShortcut);
  return true;
}
