import type { EncoderRole } from "../types.js";

export type DialPhysicalRoute =
  | "apply"
  | "voice-toggle"
  | "voice-release"
  | "voice-start"
  | "voice-stop"
  | "ignore";
export type TrailingAutoApplyRole = "model" | "reasoning" | "speed" | "approval";

/**
 * The four focused dials share one dictation toggle on physical down. Their
 * matching up event only releases the duplicate-down guard; configuration
 * still commits from the 80ms trailing rotation path.
 */
export function dialPhysicalRoute(
  role: EncoderRole,
  event: "down" | "up"
): DialPhysicalRoute {
  if (dialUsesTrailingAutoApply(role)) {
    return event === "down" ? "voice-toggle" : "voice-release";
  }
  if (role === "composer" || role === "voice") {
    return event === "down" ? "voice-start" : "voice-stop";
  }
  return event === "down" ? "apply" : "ignore";
}

/** All four focused config dials apply after rotation settles. */
export function dialUsesTrailingAutoApply(role: EncoderRole): role is TrailingAutoApplyRole {
  return role === "model" || role === "reasoning" || role === "speed" || role === "approval";
}
