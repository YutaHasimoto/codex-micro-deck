import assert from "node:assert/strict";
import test from "node:test";

import {
  dialPhysicalRoute,
  dialUsesTrailingAutoApply
} from "../src/core/dial-routing.ts";
import { TRAILING_APPLY_DELAY_MS } from "../src/core/trailing-apply.ts";

test("all four focused dials toggle dictation on down and only release their guard on up", () => {
  for (const role of ["model", "reasoning", "speed", "approval"] as const) {
    assert.equal(dialPhysicalRoute(role, "down"), "voice-toggle");
    assert.equal(dialPhysicalRoute(role, "up"), "voice-release");
  }
});

test("voice compatibility dials retain push-to-talk down and up routing", () => {
  for (const role of ["composer", "voice"] as const) {
    assert.equal(dialPhysicalRoute(role, "down"), "voice-start");
    assert.equal(dialPhysicalRoute(role, "up"), "voice-stop");
  }
});

test("legacy command dials also execute once on physical down", () => {
  for (const role of ["legacy-reasoning", "navigation", "skills", "review"] as const) {
    assert.equal(dialPhysicalRoute(role, "down"), "apply");
    assert.equal(dialPhysicalRoute(role, "up"), "ignore");
  }
});

test("all four focused configuration dials share an 300ms trailing auto-apply", () => {
  for (const role of ["model", "reasoning", "speed", "approval"] as const) {
    assert.equal(dialUsesTrailingAutoApply(role), true);
  }
  for (const role of ["legacy-reasoning", "navigation", "skills", "composer", "review", "voice"] as const) {
    assert.equal(dialUsesTrailingAutoApply(role), false);
  }
  assert.equal(TRAILING_APPLY_DELAY_MS, 300);
});
