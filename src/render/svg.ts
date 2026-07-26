import { OFFICIAL_STATE_COLORS } from "../core/model.js";
import type { EncoderPresentation, KeyPresentation, StateColor } from "../types.js";
import { renderEncoderFeedback } from "./encoder-feedback.js";
import { renderKeyImage } from "./key-image.js";

/** @deprecated Use renderKeyImage. Kept as a compatibility wrapper. */
export function keySvgDataUrl(presentation: KeyPresentation): string {
  return renderKeyImage(presentation);
}

/** @deprecated Use renderEncoderFeedback. Kept as a compatibility wrapper. */
export function encoderFeedback(presentation: EncoderPresentation): Record<string, unknown> {
  return renderEncoderFeedback(presentation);
}

export function stateHex(color: StateColor): string {
  return OFFICIAL_STATE_COLORS[color];
}
