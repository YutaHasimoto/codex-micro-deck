import assert from "node:assert/strict";
import test from "node:test";

import { KeySlotLifecycle } from "../src/core/key-slot-lifecycle.ts";
import type { DeckCoordinates, KeySettings } from "../src/types.ts";

test("role changes clear the exact previous Agent role and coordinates", () => {
  const cleared: Array<{
    settings: KeySettings;
    coordinates: DeckCoordinates;
    ownerId?: string;
  }> = [];
  const lifecycle = new KeySlotLifecycle({
    clearAgentSlot(settings, coordinates, ownerId): void {
      cleared.push({
        settings: { ...settings },
        coordinates: { ...coordinates },
        ...(ownerId ? { ownerId } : {})
      });
    }
  });
  const fixedId = "f".repeat(16);

  // No explicit role means the old role must be resolved from its old
  // coordinate: column 1, row 1 is Agent 6 in the default profile.
  lifecycle.update(
    "key-context",
    { autoAssign: false, threadId: fixedId },
    { column: 1, row: 1 }
  );
  lifecycle.update(
    "key-context",
    { role: "approve" },
    { column: 1, row: 1 }
  );

  assert.deepEqual(cleared, [{
    settings: { autoAssign: false, threadId: fixedId },
    coordinates: { column: 1, row: 1 },
    ownerId: "key-context"
  }]);
});

test("a customized role on first appearance clears that coordinate's default Agent slot", () => {
  const cleared: Array<{
    settings: KeySettings;
    coordinates: DeckCoordinates;
    ownerId?: string;
  }> = [];
  const lifecycle = new KeySlotLifecycle({
    clearAgentSlot(settings, coordinates, ownerId): void {
      cleared.push({
        settings: { ...settings },
        coordinates: { ...coordinates },
        ...(ownerId ? { ownerId } : {})
      });
    }
  });

  lifecycle.update("custom-key", { role: "approve" }, { column: 0, row: 0 });
  assert.deepEqual(cleared, [{
    settings: { role: "agent-1", autoAssign: true },
    coordinates: { column: 0, row: 0 },
    ownerId: "custom-key"
  }]);
});

test("same-role setting edits do not clear, while disappearance clears the latest state", () => {
  const cleared: Array<{ settings: KeySettings; ownerId?: string }> = [];
  const lifecycle = new KeySlotLifecycle({
    clearAgentSlot(settings, _coordinates, ownerId): void {
      cleared.push({
        settings: { ...settings },
        ...(ownerId ? { ownerId } : {})
      });
    }
  });
  const firstId = "a".repeat(16);
  const secondId = "b".repeat(16);

  lifecycle.update(
    "fixed-agent",
    { role: "agent-3", autoAssign: false, threadId: firstId },
    { column: 3, row: 1 }
  );
  lifecycle.update(
    "fixed-agent",
    { role: "agent-3", autoAssign: false, threadId: secondId },
    { column: 3, row: 1 }
  );
  assert.deepEqual(cleared, []);

  lifecycle.remove("fixed-agent");
  lifecycle.remove("fixed-agent");
  assert.deepEqual(cleared, [{
    settings: { role: "agent-3", autoAssign: false, threadId: secondId },
    ownerId: "fixed-agent"
  }]);
});

test("non-Agent roles never clear an Agent slot on change or disappearance", () => {
  let clearCalls = 0;
  const lifecycle = new KeySlotLifecycle({
    clearAgentSlot(): void { clearCalls += 1; }
  });

  lifecycle.update("approval-key", { role: "approve" }, { column: 2, row: 1 });
  lifecycle.update("approval-key", { role: "decline" }, { column: 2, row: 1 });
  lifecycle.remove("approval-key");
  assert.equal(clearCalls, 0);
});
