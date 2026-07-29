import { OFFICIAL_STATE_COLORS, splitGraphemes } from "../core/model.js";
import type { KeyPresentation } from "../types.js";
import {
  keyIconForLabel,
  renderLucideIcon,
  stateIconForColor,
  svgDataUrl
} from "./icons.js";

// Stream Deck image updates are relatively expensive, so keep a modest 10 fps
// cadence while using a small per-frame step. This removes the old 8 px / 500 ms
// jumps without turning the plugin into a tight render loop.
export const KEY_MARQUEE_INTERVAL_MS = 100;

const TITLE_CLIP_X = 15;
const TITLE_CLIP_Y = 101;
const TITLE_CLIP_WIDTH = 74;
const TITLE_CLIP_HEIGHT = 25;
const TITLE_FONT_SIZE = 14;
const TITLE_STEP_PX = 10;
const TITLE_GAP_PX = 28;
const TITLE_PAUSE_FRAMES = 2;
const MAX_TASK_TITLE_CHARACTERS = 240;

type TaskTitleFrame = {
  mode: "static" | "marquee";
  first: string;
  firstX: number;
  second?: string;
  secondX?: number;
  offset: number;
};

/** Renders a complete 144 px Stream Deck key without relying on host titles. */
export function renderKeyImage(presentation: KeyPresentation, marqueeFrame = 0): string {
  const color = OFFICIAL_STATE_COLORS[presentation.color];
  const visibleAccent = presentation.color === "off" ? "#566075" : color;
  const glowOpacity = presentation.selected ? (presentation.pulse ? 0.95 : 0.42) : 0;
  const agentMatch = /^Agent ([1-6])$/.exec(presentation.primary);
  const isAgent = agentMatch !== null;
  const isVoice = presentation.primary === "Voice";
  const mainIcon = keyIconForLabel(presentation.primary);
  const mainOpacity = presentation.color === "off" ? 0.52 : 1;
  const iconSize = isAgent ? 60 : isVoice ? 68 : 76;
  const iconX = (144 - iconSize) / 2;
  const iconY = isAgent ? 28 : isVoice ? 24 : iconX;
  const titleBand = isAgent
    ? renderTaskTitleBand(presentation, visibleAccent, marqueeFrame)
    : "";
  const statusBadge = isAgent
    ? `<circle cx="113" cy="111" r="21" fill="#090C12" stroke="${visibleAccent}" stroke-width="4"/>
  ${renderLucideIcon(stateIconForColor(presentation.color), {
    x: 101,
    y: 99,
    size: 24,
    color: visibleAccent,
    strokeWidth: 2.4
  })}`
    : "";
  const numberBadge = agentMatch?.[1]
    ? `<circle cx="111" cy="32" r="20" fill="#F8FAFC" stroke="#090C12" stroke-width="4"/>
  <text x="111" y="40" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="24" font-weight="800" fill="#0A0D13">${agentMatch[1]}</text>`
    : "";
  const voiceLabel = isVoice
    ? `<text x="72" y="124" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="14" font-weight="700" fill="#F8FAFC">${escapeSvgText(presentation.secondary)}</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="24" fill="#07090D"/>
  <rect x="4" y="4" width="136" height="136" rx="21" fill="none" stroke="${visibleAccent}" stroke-width="5" opacity="${glowOpacity}"/>
  <rect x="9" y="9" width="126" height="126" rx="18" fill="#111620" stroke="#293142" stroke-width="2"/>
  <rect x="9" y="9" width="126" height="126" rx="18" fill="${color}" fill-opacity="${presentation.color === "off" ? 0 : 0.12}" stroke="${color}" stroke-width="3" stroke-opacity="${presentation.color === "off" ? 0.2 : 0.78}"/>
  ${renderLucideIcon(mainIcon, {
    x: iconX,
    y: iconY,
    size: iconSize,
    color: "#F8FAFC",
    opacity: mainOpacity,
    strokeWidth: 2.15
  })}
  ${numberBadge}
  ${titleBand}
  ${statusBadge}
  ${voiceLabel}
</svg>`;
  return svgDataUrl(svg);
}

/** Long names move while their Agent key is visible. */
export function taskTitleNeedsMarquee(value: string): boolean {
  return estimatedTextWidth(normalizeTaskTitle(value)) > TITLE_CLIP_WIDTH;
}

function renderTaskTitleBand(
  presentation: KeyPresentation,
  visibleAccent: string,
  marqueeFrame: number
): string {
  const title = normalizeTaskTitle(presentation.secondary);
  const frame = taskTitleFrame(title, marqueeFrame);
  const second = frame.second !== undefined && frame.secondX !== undefined
    ? `<text x="${frame.secondX}" y="119" ${taskTitleTextAttributes()}>${escapeSvgText(frame.second)}</text>`
    : "";
  return `<defs>
    <clipPath id="agent-title-clip">
      <rect x="${TITLE_CLIP_X}" y="${TITLE_CLIP_Y}" width="${TITLE_CLIP_WIDTH}" height="${TITLE_CLIP_HEIGHT}" rx="7"/>
    </clipPath>
  </defs>
  <rect x="12" y="100" width="80" height="27" rx="10" fill="#090C12" stroke="${visibleAccent}" stroke-width="1.5" stroke-opacity=".45"/>
  <g clip-path="url(#agent-title-clip)" data-title-mode="${frame.mode}" data-marquee-offset="${frame.offset}">
    <text x="${frame.firstX}" y="119" ${taskTitleTextAttributes()}>${escapeSvgText(frame.first)}</text>
    ${second}
  </g>`;
}

function taskTitleFrame(title: string, marqueeFrame: number): TaskTitleFrame {
  const titleWidth = estimatedTextWidth(title);
  if (titleWidth <= TITLE_CLIP_WIDTH) {
    return {
      mode: "static",
      first: title,
      firstX: TITLE_CLIP_X,
      offset: 0
    };
  }

  const normalizedFrame = Math.max(0, Math.trunc(marqueeFrame));
  const scrollingFrame = Math.max(0, normalizedFrame - TITLE_PAUSE_FRAMES);
  const cycleWidth = Math.ceil(titleWidth + TITLE_GAP_PX);
  const offset = scrollingFrame === 0 ? 0 : (scrollingFrame * TITLE_STEP_PX) % cycleWidth;
  return {
    mode: "marquee",
    first: title,
    firstX: TITLE_CLIP_X - offset,
    second: title,
    secondX: TITLE_CLIP_X - offset + cycleWidth,
    offset
  };
}

function normalizeTaskTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim() || "Untitled";
  return splitGraphemes(normalized).slice(0, MAX_TASK_TITLE_CHARACTERS).join("");
}

function estimatedTextWidth(value: string): number {
  return splitGraphemes(value).reduce((width, character) => (
    width + estimatedCharacterWidth(character)
  ), 0);
}

function estimatedCharacterWidth(character: string): number {
  if (/\s/u.test(character)) return 3.5;
  if (/[\u0000-\u007F]/u.test(character)) {
    if (/[ilI1.,'`:;|!]/u.test(character)) return 3.5;
    if (/[MWmw@#%&]/u.test(character)) return 8.5;
    return 6.2;
  }
  return TITLE_FONT_SIZE;
}

function taskTitleTextAttributes(): string {
  return `font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="${TITLE_FONT_SIZE}" font-weight="700" fill="#F8FAFC"`;
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
