import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The profile generator is an executable JavaScript module without declarations.
import {
  PLUGIN_VERSION,
  expectedPageManifest,
  expectedRootManifest,
  validateManifests
} from "../scripts/generate-plus-profile.mjs";

test("profile manifests accept the current plugin version", () => {
  assert.doesNotThrow(() => {
    validateManifests(expectedRootManifest(), expectedPageManifest());
  });
});

test("every profile action rejects a stale embedded plugin version", () => {
  const expectedPage = expectedPageManifest();
  let checked = 0;

  for (const controller of expectedPage.Controllers) {
    const kind = controller.Type === "Keypad" ? "key" : "encoder";
    for (const coordinate of Object.keys(controller.Actions)) {
      const stalePage = structuredClone(expectedPage);
      const staleController = stalePage.Controllers.find(
        (candidate: { Type: string }) => candidate.Type === controller.Type
      );
      assert.ok(staleController);
      staleController.Actions[coordinate].Plugin.Version = "0.4.12.0";

      assert.throws(
        () => validateManifests(expectedRootManifest(), stalePage),
        new RegExp(
          `Invalid ${kind} plugin version at ${coordinate}: expected ${PLUGIN_VERSION}`
        )
      );
      checked += 1;
    }
  }

  assert.equal(checked, 12);
});
