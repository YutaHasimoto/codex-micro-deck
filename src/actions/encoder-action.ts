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
import { TrailingApplyScheduler } from "../core/trailing-apply.js";
import {
  renderEncoderFeedback,
  VOICE_WAVEFORM_INTERVAL_MS
} from "../render/encoder-feedback.js";
import {
  ENCODER_ACTION_UUID,
  type DeckCoordinates,
  type EncoderPresentation,
  type EncoderSettings
} from "../types.js";

@action({ UUID: ENCODER_ACTION_UUID })
export class CodexEncoderAction extends SingletonAction<EncoderSettings> {
  readonly #autoApply = new TrailingApplyScheduler<TrailingAutoApplyRole>();
  #refreshQueued = false;
  #refreshPromise: Promise<void> | undefined;
  #voiceFrame = 0;
  #voiceTransitions = 0;

  constructor(readonly coordinator: CodexDeckCoordinator) {
    super();
    coordinator.onEncoderChange(() => this.refreshVisible());
    const voiceTimer = setInterval(() => {
      if (!coordinator.voiceActive) return;
      this.#voiceFrame += 1;
      void this.refreshVisible();
    }, VOICE_WAVEFORM_INTERVAL_MS);
    voiceTimer.unref();
  }

  override async onWillAppear(event: WillAppearEvent<EncoderSettings>): Promise<void> {
    if (!event.action.isDial()) return;
    this.#autoApply.cancel(event.action.id);
    const coordinates = event.action.coordinates;
    const settings = migrateEncoderSettings(event.payload.settings, coordinates.column);
    if (settings !== event.payload.settings) {
      await event.action.setSettings(settings);
    }
    await this.render(event.action, settings, coordinates);
  }

  override async onDidReceiveSettings(event: DidReceiveSettingsEvent<EncoderSettings>): Promise<void> {
    if (!event.action.isDial()) return;
    await this.#autoApply.cancelAndWait(event.action.id);
    await this.render(event.action, event.payload.settings, event.action.coordinates);
  }

  override async onDialRotate(event: DialRotateEvent<EncoderSettings>): Promise<void> {
    try {
      if (this.#voiceTransitions > 0 || this.coordinator.voiceActive) {
        this.#autoApply.cancel(event.action.id);
        await this.render(event.action, event.payload.settings, event.action.coordinates);
        return;
      }
      await this.#autoApply.cancelAndWait(event.action.id);
      const settings = await this.coordinator.rotateEncoder(
        event.payload.settings,
        event.action.coordinates,
        event.payload.ticks
      );
      if (settings !== event.payload.settings) await event.action.setSettings(settings);
      const role = encoderRole(settings, event.action.coordinates);
      if (event.payload.ticks !== 0
        && dialUsesTrailingAutoApply(role)
        && !hasAutoApplyOverride(settings, event.payload.ticks, role)) {
        // Commit the Codex selection independently of the feedback repaint.
        // A slow or transient Stream Deck display update must not turn a
        // rotation into a press-only operation.
        streamDeck.logger.info(`[dial:${role}:rotate] auto apply scheduled`);
        this.#scheduleTrailingApply(event.action, settings, event.action.coordinates, role);
      }
      await this.render(event.action, settings, event.action.coordinates);
    } catch (error) {
      this.#logFailure("rotate", event.payload.settings, event.action.coordinates, error);
      await event.action.showAlert().catch(() => undefined);
    }
  }

  override async onDialDown(event: DialDownEvent<EncoderSettings>): Promise<void> {
    try {
      const role = encoderRole(event.payload.settings, event.action.coordinates);
      const route = dialPhysicalRoute(role, "down");
      if (route === "voice-toggle") {
        const starting = !this.coordinator.voiceActive;
        if (starting) this.#voiceTransitions += 1;
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

  async #drainRefreshes(): Promise<void> {
    while (this.#refreshQueued) {
      this.#refreshQueued = false;
      const frame = this.#voiceFrame;
      const tasks: Promise<void>[] = [];
      this.actions.forEach((visibleAction) => {
        if (!visibleAction.isDial()) return;
        tasks.push((async () => {
          const settings = await visibleAction.getSettings<EncoderSettings>();
          try {
            await this.render(visibleAction, settings, visibleAction.coordinates, frame);
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
    frame = this.#voiceFrame
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
      actionInstance.setFeedback(renderEncoderFeedback(presentation, frame)),
      actionInstance.setTriggerDescription(triggerDescriptionForRole(settings, coordinates))
    ]);
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
  // must not disable their independent 80ms rotation apply.
  if (settings.pressShortcut && !isConfigRole(role)) return true;
  if (ticks > 0) return Boolean(settings.clockwiseShortcut);
  if (ticks < 0) return Boolean(settings.counterClockwiseShortcut);
  return true;
}
