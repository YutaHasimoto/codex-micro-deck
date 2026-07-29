import type { FeedbackPayload } from "@elgato/streamdeck";

import { OFFICIAL_STATE_COLORS } from "../core/model.js";
import type { EncoderPresentation } from "../types.js";
import { encoderIconFor, lucideIconDataUrl, svgDataUrl } from "./icons.js";

export const VOICE_WAVEFORM_INTERVAL_MS = 100;

const ENCODER_WIDTH = 200;
const ENCODER_HEIGHT = 100;
const ENCODER_COUNT = 4;
const WAVEFORM_WIDTH = ENCODER_WIDTH * ENCODER_COUNT;
const VOICE_BACKGROUND = "#070B12";
const TRANSPARENT_OVERLAY = svgDataUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ENCODER_WIDTH}" height="${ENCODER_HEIGHT}" viewBox="0 0 ${ENCODER_WIDTH} ${ENCODER_HEIGHT}" data-overlay="clear"><rect width="${ENCODER_WIDTH}" height="${ENCODER_HEIGHT}" fill="#000000" fill-opacity="0"/></svg>`
);

/**
 * Payload keys deliberately mirror layouts/encoder.json.
 *
 * Pass the same frame to all four voice presentations. Their `slice` values
 * select adjacent view boxes from one deterministic 800 x 100 waveform.
 */
export function renderEncoderFeedback(
  presentation: EncoderPresentation,
  frame = 0,
  voiceLevel = 0
): FeedbackPayload {
  if (presentation.mode === "voice") {
    return renderVoiceFeedback(presentation.slice, frame, voiceLevel);
  }

  const accent = OFFICIAL_STATE_COLORS[presentation.color];
  const visibleAccent = presentation.color === "off" ? "#566075" : accent;
  const icon = encoderIconFor(presentation.title, presentation.value);
  return {
    backdrop: {
      value: 100,
      bar_bg_c: "#0B0E14",
      bar_fill_c: "#0B0E14",
      background: "#0B0E14"
    },
    accent: {
      value: 100,
      bar_bg_c: visibleAccent,
      bar_fill_c: visibleAccent,
      background: visibleAccent
    },
    icon: lucideIconDataUrl(icon, "#F8FAFC", visibleAccent),
    value: presentation.value,
    // Replacing the previous pixmap with a transparent SVG explicitly clears
    // a voice overlay when dictation ends.
    waveform: TRANSPARENT_OVERLAY
  };
}

function renderVoiceFeedback(
  slice: number | undefined,
  frame: number,
  voiceLevel: number
): FeedbackPayload {
  const hiddenBar = {
    value: 100,
    bar_bg_c: VOICE_BACKGROUND,
    bar_fill_c: VOICE_BACKGROUND,
    background: VOICE_BACKGROUND
  };
  return {
    backdrop: { ...hiddenBar },
    accent: { ...hiddenBar },
    icon: TRANSPARENT_OVERLAY,
    value: "",
    waveform: voiceWaveformDataUrl(slice, frame, voiceLevel)
  };
}

function voiceWaveformDataUrl(
  slice: number | undefined,
  frame: number,
  voiceLevel: number
): string {
  const numericSlice = slice !== undefined && Number.isFinite(slice) ? Math.trunc(slice) : 0;
  const safeSlice = Math.max(0, Math.min(ENCODER_COUNT - 1, numericSlice));
  const safeFrame = Number.isFinite(frame) ? Math.max(0, Math.trunc(frame)) : 0;
  const safeVoiceLevel = Number.isFinite(voiceLevel)
    ? Math.max(0, Math.min(1, voiceLevel))
    : 0;
  const sliceX = safeSlice * ENCODER_WIDTH;
  const phase = safeFrame * 0.46;
  const amplitude = 1.5 + safeVoiceLevel * 24;
  const points: string[] = [];

  // These points describe the complete 800 px strip. Each dial receives the
  // same path and only changes its viewBox, so boundaries cannot drift apart.
  for (let x = 0; x <= WAVEFORM_WIDTH; x += 4) {
    const carrier =
      Math.sin(x * 0.031 + phase)
      + 0.52 * Math.sin(x * 0.083 - phase * 0.74)
      + 0.24 * Math.sin(x * 0.173 + phase * 1.31);
    const envelope = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(x * 0.012 - phase * 0.19));
    const y = 50 + carrier * amplitude * envelope;
    points.push(`${x},${y.toFixed(2)}`);
  }

  const path = `M${points.join(" L")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ENCODER_WIDTH}" height="${ENCODER_HEIGHT}" viewBox="${sliceX} 0 ${ENCODER_WIDTH} ${ENCODER_HEIGHT}" data-overlay="voice" data-frame="${safeFrame}" data-slice="${safeSlice}" data-level="${safeVoiceLevel.toFixed(3)}">
  <defs>
    <linearGradient id="voice-wave" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${WAVEFORM_WIDTH}" y2="0">
      <stop offset="0" stop-color="#304FFE"/>
      <stop offset=".5" stop-color="#00D9FF"/>
      <stop offset="1" stop-color="#8B5CF6"/>
    </linearGradient>
  </defs>
  <rect width="${WAVEFORM_WIDTH}" height="${ENCODER_HEIGHT}" fill="${VOICE_BACKGROUND}"/>
  <path d="M0 50 H${WAVEFORM_WIDTH}" fill="none" stroke="#304FFE" stroke-opacity=".22" stroke-width="1"/>
  <path data-waveform-glow="true" d="${path}" fill="none" stroke="#00D9FF" stroke-opacity=".2" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  <path data-waveform-main="true" d="${path}" fill="none" stroke="url(#voice-wave)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
  return svgDataUrl(svg);
}
