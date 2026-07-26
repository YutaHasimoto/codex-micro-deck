import { agentIndex, defaultKeyRole } from "./model.js";
import type { DeckCoordinates, KeyRole, KeySettings } from "../types.js";

export type AgentSlotLifecycleSink = {
  clearAgentSlot(
    settings: KeySettings,
    coordinates: DeckCoordinates,
    ownerId?: string
  ): void;
};

type VisibleKeyState = {
  settings: KeySettings;
  coordinates: DeckCoordinates;
};

/**
 * Remembers the previous role for each physical Stream Deck action context.
 * Settings-change events contain only the new settings, while disappear
 * events no longer expose key coordinates on the action object.
 */
export class KeySlotLifecycle {
  readonly #sink: AgentSlotLifecycleSink;
  readonly #visible = new Map<string, VisibleKeyState>();

  constructor(sink: AgentSlotLifecycleSink) {
    this.#sink = sink;
  }

  update(actionId: string, settings: KeySettings, coordinates: DeckCoordinates): void {
    const previous = this.#visible.get(actionId);
    if (previous) {
      if (resolvedRole(previous.settings, previous.coordinates)
        !== resolvedRole(settings, coordinates)) {
        this.#clearIfAgent(previous, actionId);
      }
    } else {
      const defaultRole = defaultKeyRole(coordinates.column, coordinates.row);
      if (defaultRole !== resolvedRole(settings, coordinates)) {
        this.#clearIfAgent({
          settings: { role: defaultRole, autoAssign: true },
          coordinates
        }, actionId);
      }
    }
    this.#visible.set(actionId, {
      settings: { ...settings },
      coordinates: { ...coordinates }
    });
  }

  remove(actionId: string): void {
    const previous = this.#visible.get(actionId);
    if (!previous) return;
    this.#visible.delete(actionId);
    this.#clearIfAgent(previous, actionId);
  }

  #clearIfAgent(previous: VisibleKeyState, ownerId: string): void {
    if (agentIndex(resolvedRole(previous.settings, previous.coordinates)) === undefined) return;
    this.#sink.clearAgentSlot(previous.settings, previous.coordinates, ownerId);
  }
}

function resolvedRole(settings: KeySettings, coordinates: DeckCoordinates): KeyRole {
  return settings.role ?? defaultKeyRole(coordinates.column, coordinates.row);
}
