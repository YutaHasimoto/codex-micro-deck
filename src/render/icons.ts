/**
 * Lucide icon geometry vendored from lucide-icons/lucide at
 * 658573b0171e693bc965c167592cc0b92d002a3e.
 *
 * The node geometry below is intentionally kept identical to the upstream
 * 24 x 24 SVGs. See THIRD_PARTY_NOTICES.md for the ISC and Feather MIT terms.
 */

import type { StateColor } from "../types.js";

export type LucideIconName =
  | "arrow-left-right"
  | "bot"
  | "brain-circuit"
  | "circle-alert"
  | "circle-check"
  | "circle-check-big"
  | "circle-dot"
  | "circle-off"
  | "circle-x"
  | "command"
  | "cpu"
  | "gauge"
  | "loader-circle"
  | "message-square-text"
  | "mic"
  | "scan-search"
  | "shield-check"
  | "triangle-alert";

const LUCIDE_NODES: Readonly<Record<LucideIconName, string>> = {
  "arrow-left-right": `<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>`,
  bot: `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
  "brain-circuit": `<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M12 13h4"/><path d="M12 18h6a2 2 0 0 1 2 2v1"/><path d="M12 8h8"/><path d="M16 8V5a2 2 0 0 1 2-2"/><circle cx="16" cy="13" r=".5"/><circle cx="18" cy="3" r=".5"/><circle cx="20" cy="21" r=".5"/><circle cx="20" cy="8" r=".5"/>`,
  "circle-alert": `<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>`,
  "circle-check": `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`,
  "circle-check-big": `<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>`,
  "circle-dot": `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>`,
  "circle-off": `<path d="m2 2 20 20"/><path d="M8.35 2.69A10 10 0 0 1 21.3 15.65"/><path d="M19.08 19.08A10 10 0 1 1 4.92 4.92"/>`,
  "circle-x": `<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>`,
  command: `<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>`,
  cpu: `<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>`,
  gauge: `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`,
  "loader-circle": `<path d="M21 12a9 9 0 1 1-6.219-8.56"/>`,
  "message-square-text": `<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M7 11h10"/><path d="M7 15h6"/><path d="M7 7h8"/>`,
  mic: `<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>`,
  "scan-search": `<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>`,
  "shield-check": `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>`,
  "triangle-alert": `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`
};

export type LucideRenderOptions = {
  x: number;
  y: number;
  size: number;
  color: string;
  opacity?: number;
  strokeWidth?: number;
};

/** Renders an upstream Lucide 24 px icon inside a larger SVG canvas. */
export function renderLucideIcon(name: LucideIconName, options: LucideRenderOptions): string {
  const scale = options.size / 24;
  const opacity = options.opacity === undefined ? "" : ` opacity="${options.opacity}"`;
  return `<g data-lucide="${name}" transform="translate(${options.x} ${options.y}) scale(${scale})" fill="none" stroke="${options.color}" stroke-width="${options.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round"${opacity}>${LUCIDE_NODES[name]}</g>`;
}

/** Creates the transparent data URL consumed by a Stream Deck pixmap item. */
export function lucideIconDataUrl(
  name: LucideIconName,
  color: string,
  accent: string,
  size = 72
): string {
  const padding = Math.round(size * 0.18);
  const iconSize = size - padding * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="2" y="2" width="${size - 4}" height="${size - 4}" rx="${Math.round(size * 0.25)}" fill="${accent}" fill-opacity=".12" stroke="${accent}" stroke-opacity=".55" stroke-width="2"/>
  ${renderLucideIcon(name, { x: padding, y: padding, size: iconSize, color, strokeWidth: 2.15 })}
</svg>`;
  return svgDataUrl(svg);
}

export function keyIconForLabel(label: string): LucideIconName {
  if (/^Agent [1-6]$/.test(label)) return "bot";
  if (label === "Approve") return "circle-check-big";
  if (label === "Decline") return "circle-x";
  return "command";
}

export function stateIconForColor(color: StateColor): LucideIconName {
  const icons: Readonly<Record<StateColor, LucideIconName>> = {
    white: "circle-dot",
    blue: "loader-circle",
    green: "circle-check",
    amber: "circle-alert",
    red: "triangle-alert",
    off: "circle-off"
  };
  return icons[color];
}

export function encoderIconFor(title: string, value: string): LucideIconName {
  const normalizedTitle = title.trim().toLowerCase();
  if (normalizedTitle === "model" || normalizedTitle === "モデル") return "cpu";
  if (normalizedTitle === "reasoning" || normalizedTitle === "推論") return "brain-circuit";
  if (normalizedTitle === "speed" || normalizedTitle === "速度") return "gauge";
  if (normalizedTitle === "approval" || normalizedTitle === "承認" || normalizedTitle === "access") {
    return "shield-check";
  }

  // Keep old custom profiles recognizable while they migrate to the focused
  // model / reasoning / speed / approval layout.
  if (title === "Navigation") return "arrow-left-right";
  if (title === "Composer") return value.startsWith("Listening") ? "mic" : "message-square-text";
  if (title === "Review") return "scan-search";
  return "command";
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
