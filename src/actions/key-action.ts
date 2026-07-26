import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent
} from "@elgato/streamdeck";

import { CodexDeckCoordinator, keyRole } from "../coordinator.js";
import { safeActionError } from "../core/errors.js";
import { KeySlotLifecycle } from "../core/key-slot-lifecycle.js";
import { defaultKeyRole } from "../core/model.js";
import {
  KEY_MARQUEE_INTERVAL_MS,
  renderKeyImage,
  taskTitleNeedsMarquee
} from "../render/key-image.js";
import { KEY_ACTION_UUID, type DeckCoordinates, type KeySettings } from "../types.js";

type KeyActionInstance = Extract<
  WillAppearEvent<KeySettings>["action"],
  { setImage: unknown }
>;

type MarqueeTarget = {
  action: KeyActionInstance;
  settings: KeySettings;
  coordinates: DeckCoordinates;
};

@action({ UUID: KEY_ACTION_UUID })
export class CodexKeyAction extends SingletonAction<KeySettings> {
  readonly #slotLifecycle: KeySlotLifecycle;
  #refreshQueued = false;
  #refreshPromise: Promise<void> | undefined;
  #marqueeTarget: MarqueeTarget | undefined;
  #marqueeRefreshInFlight = false;
  #marqueeClock = 0;
  #selectedMarqueeThreadId: string | undefined;
  #selectedMarqueeStartedAt = 0;

  constructor(readonly coordinator: CodexDeckCoordinator) {
    super();
    this.#slotLifecycle = new KeySlotLifecycle(coordinator);
    coordinator.onChange(() => this.refreshVisible());
    const marqueeTimer = setInterval(() => {
      const target = this.#marqueeTarget;
      if (!target || this.#marqueeRefreshInFlight) return;
      this.#marqueeClock += 1;
      this.#marqueeRefreshInFlight = true;
      void this.#renderMarqueeFrame(target)
        .catch((error) => {
          this.#logFailure("marquee", target.settings, target.coordinates, error);
        })
        .finally(() => {
          this.#marqueeRefreshInFlight = false;
        });
    }, KEY_MARQUEE_INTERVAL_MS);
    marqueeTimer.unref();
  }

  override async onWillAppear(event: WillAppearEvent<KeySettings>): Promise<void> {
    if (!event.action.isKey()) return;
    const coordinates = event.action.coordinates;
    if (!coordinates) return;
    let settings = event.payload.settings;
    if (!settings.role) {
      const role = defaultKeyRole(coordinates.column, coordinates.row);
      settings = {
        ...settings,
        role,
        ...(/^agent-/.test(role) && settings.autoAssign === undefined ? { autoAssign: true } : {})
      };
    }
    this.#slotLifecycle.update(event.action.id, settings, coordinates);
    if (settings !== event.payload.settings) await event.action.setSettings(settings);
    await this.render(event.action, settings, coordinates);
  }

  override async onDidReceiveSettings(event: DidReceiveSettingsEvent<KeySettings>): Promise<void> {
    if (!event.action.isKey() || !event.action.coordinates) return;
    this.#slotLifecycle.update(
      event.action.id,
      event.payload.settings,
      event.action.coordinates
    );
    await this.render(event.action, event.payload.settings, event.action.coordinates);
  }

  override onWillDisappear(event: WillDisappearEvent<KeySettings>): void {
    this.#slotLifecycle.remove(event.action.id);
    if (this.#marqueeTarget?.action.id === event.action.id) {
      this.#clearMarqueeTarget();
    }
  }

  override async onKeyDown(event: KeyDownEvent<KeySettings>): Promise<void> {
    const coordinates = event.action.coordinates;
    if (!coordinates) return;
    try {
      await this.coordinator.pressKey(event.payload.settings, coordinates);
      await this.render(event.action, event.payload.settings, coordinates);
    } catch (error) {
      this.#logFailure("down", event.payload.settings, coordinates, error);
      await event.action.showAlert().catch(() => undefined);
    }
  }

  override async onKeyUp(event: KeyUpEvent<KeySettings>): Promise<void> {
    const coordinates = event.action.coordinates;
    if (!coordinates) return;
    try {
      await this.coordinator.releaseKey(event.payload.settings, coordinates);
      if (keyRole(event.payload.settings, coordinates) === "ptt") {
        await this.render(event.action, event.payload.settings, coordinates);
      }
    } catch (error) {
      this.#logFailure("up", event.payload.settings, coordinates, error);
      await event.action.showAlert().catch(() => undefined);
    }
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
      const tasks: Promise<void>[] = [];
      this.actions.forEach((visibleAction) => {
        const coordinates = visibleAction.coordinates;
        if (!visibleAction.isKey() || !coordinates) return;
        tasks.push((async () => {
          const settings = await visibleAction.getSettings<KeySettings>();
          try {
            this.#slotLifecycle.update(visibleAction.id, settings, coordinates);
            await this.render(visibleAction, settings, coordinates as DeckCoordinates);
          } catch (error) {
            this.#logFailure("refresh", settings, coordinates, error);
          }
        })());
      });
      await Promise.allSettled(tasks);
    }
  }

  #logFailure(
    eventName: string,
    settings: KeySettings,
    coordinates: DeckCoordinates,
    error: unknown
  ): void {
    const role = keyRole(settings, coordinates);
    streamDeck.logger.error(`[key:${role}:${eventName}] ${safeActionError(error)}`);
  }

  private async render(
    actionInstance: KeyActionInstance,
    settings: KeySettings,
    coordinates: DeckCoordinates
  ): Promise<void> {
    const presentation = this.coordinator.keyPresentation(
      settings,
      coordinates,
      actionInstance.id
    );
    const isSelectedMarquee = presentation.selected === true
      && taskTitleNeedsMarquee(presentation.secondary);
    if (isSelectedMarquee) {
      this.#marqueeTarget = { action: actionInstance, settings, coordinates };
    } else if (this.#marqueeTarget?.action.id === actionInstance.id) {
      this.#clearMarqueeTarget();
    }
    await actionInstance.setImage(renderKeyImage(
      presentation,
      this.#marqueeFrame(presentation)
    ));
    // A non-breaking space also clears labels inherited from v0.1 profiles.
    // Stream Deck treats empty and zero-width strings as "use the saved
    // fallback title" on some upgraded profiles, which would put old text
    // over the icon-centric artwork.
    await actionInstance.setTitle("\u00A0");
  }

  async #renderMarqueeFrame(target: MarqueeTarget): Promise<void> {
    if (this.#marqueeTarget !== target) return;
    const presentation = this.coordinator.keyPresentation(
      target.settings,
      target.coordinates,
      target.action.id
    );
    if (!presentation.selected || !taskTitleNeedsMarquee(presentation.secondary)) {
      if (this.#marqueeTarget === target) this.#clearMarqueeTarget();
      return;
    }
    await target.action.setImage(renderKeyImage(
      presentation,
      this.#marqueeFrame(presentation)
    ));
  }

  #marqueeFrame(
    presentation: ReturnType<CodexDeckCoordinator["keyPresentation"]>
  ): number {
    if (!presentation.selected
      || !presentation.threadId
      || !taskTitleNeedsMarquee(presentation.secondary)) return 0;
    if (presentation.threadId !== this.#selectedMarqueeThreadId) {
      this.#selectedMarqueeThreadId = presentation.threadId;
      this.#selectedMarqueeStartedAt = this.#marqueeClock;
    }
    return this.#marqueeClock - this.#selectedMarqueeStartedAt;
  }

  #clearMarqueeTarget(): void {
    this.#marqueeTarget = undefined;
    this.#selectedMarqueeThreadId = undefined;
    this.#selectedMarqueeStartedAt = this.#marqueeClock;
  }
}

export function resolvedKeyRole(settings: KeySettings, coordinates: DeckCoordinates): string {
  return keyRole(settings, coordinates);
}
