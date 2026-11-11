import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  renderEncoderFeedback,
  VOICE_WAVEFORM_INTERVAL_MS
} from "../src/render/encoder-feedback.ts";
import {
  KEY_MARQUEE_INTERVAL_MS,
  renderKeyImage,
  taskTitleNeedsMarquee
} from "../src/render/key-image.ts";
import type { StateColor } from "../src/types.ts";

function decodeDataUrl(dataUrl: string): string {
  assert.match(dataUrl, /^data:image\/svg\+xml;base64,/);
  return Buffer.from(dataUrl.split(",")[1] ?? "", "base64").toString("utf8");
}

function feedbackRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function waveformRange(svg: string): number {
  const path = svg.match(/data-waveform-main="true" d="([^"]+)"/)?.[1] ?? "";
  const ys = [...path.matchAll(/(?:M|L)[\d.]+,([\d.]+)/g)].map((match) => Number(match[1]));
  return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
}

test("Agent task marquee uses a smooth bounded update cadence", () => {
  assert.equal(KEY_MARQUEE_INTERVAL_MS, 100);
});

test("agent keys keep their bot, number, state, and selected frame while adding a short static title", () => {
  const states: ReadonlyArray<[StateColor, string, string]> = [
    ["white", "circle-dot", "#FFFFFF"],
    ["blue", "loader-circle", "#304FFE"],
    ["green", "circle-check", "#00FF4C"],
    ["amber", "circle-alert", "#FF6D00"],
    ["red", "triangle-alert", "#FF0033"],
    ["off", "circle-off", "#000000"]
  ];

  for (const [color, statusIcon, hex] of states) {
    const svg = decodeDataUrl(renderKeyImage({
      color,
      primary: "Agent 3",
      secondary: "短いタスク",
      selected: color === "blue",
      pulse: color === "blue"
    }));
    assert.match(svg, /data-lucide="bot"/);
    assert.match(svg, new RegExp(`data-lucide="${statusIcon}"`));
    assert.match(svg, new RegExp(hex));
    assert.match(svg, />3<\/text>/);
    assert.match(svg, /data-title-mode="static"/);
    assert.match(svg, />短いタスク<\/text>/);
    assert.equal((svg.match(/<text\b/g) ?? []).length, 2);
    assert.doesNotMatch(svg, /Agent 3/);
  }
});

test("all visible long Japanese and English task names enter marquee mode", () => {
  for (const title of [
    "長い日本語のタスク名をキーの中で安全に読みやすく表示する",
    "Implement a long English task title without covering the status badge"
  ]) {
    assert.equal(taskTitleNeedsMarquee(title), true);
    const svg = decodeDataUrl(renderKeyImage({
      color: "white",
      primary: "Agent 1",
      secondary: title,
      selected: false
    }, 20));
    assert.match(svg, /clip-path="url\(#agent-title-clip\)"/);
    assert.match(svg, /data-title-mode="marquee"/);
    assert.equal((svg.match(new RegExp(title, "g")) ?? []).length, 2);
  }
});

test("all visible long task names marquee left after a short pause in 10px steps", () => {
  for (const title of [
    "表示中の長い日本語タスク名がそれぞれゆっくり横へ流れる",
    "Every visible long English task title should scroll independently"
  ]) {
    const paused = decodeDataUrl(renderKeyImage({
      color: "blue",
      primary: "Agent 2",
      secondary: title,
      selected: false
    }, 2));
    const moving = decodeDataUrl(renderKeyImage({
      color: "blue",
      primary: "Agent 2",
      secondary: title,
      selected: false
    }, 5));
    assert.match(paused, /data-title-mode="marquee" data-marquee-offset="0"/);
    assert.match(moving, /data-title-mode="marquee" data-marquee-offset="30"/);
    assert.equal((paused.match(new RegExp(title, "g")) ?? []).length, 2);
    assert.equal((moving.match(new RegExp(title, "g")) ?? []).length, 2);
  }
});

test("task names escape XML special characters before entering the SVG", () => {
  const title = `R&D <QA> "release" 'one' requires a safe marquee`;
  const svg = decodeDataUrl(renderKeyImage({
    color: "green",
    primary: "Agent 4",
    secondary: title,
    selected: true
  }, 5));
  const escaped = "R&amp;D &lt;QA&gt; &quot;release&quot; &apos;one&apos; requires a safe marquee";
  assert.equal((svg.match(new RegExp(escaped, "g")) ?? []).length, 2);
  assert.doesNotMatch(svg, /R&D <QA>/);
});

test("task title fitting keeps compound emoji graphemes intact", () => {
  const family = "👨‍👩‍👧‍👦";
  const title = `${"あ".repeat(239)}${family}末尾`;
  const svg = decodeDataUrl(renderKeyImage({
    color: "blue",
    primary: "Agent 5",
    secondary: title,
    selected: true
  }, 5));

  assert.equal((svg.match(new RegExp(family, "gu")) ?? []).length, 2);
  assert.doesNotMatch(svg, /末尾/);
});

test("approve and decline keys are icon-only and use upstream Lucide geometry", () => {
  const approve = decodeDataUrl(renderKeyImage({
    color: "amber", primary: "Approve", secondary: "Enter"
  }));
  const decline = decodeDataUrl(renderKeyImage({
    color: "red", primary: "Decline", secondary: "Escape"
  }));

  assert.match(approve, /data-lucide="circle-check-big"/);
  assert.match(approve, /M21\.801 10A10 10 0 1 1 17 3\.335/);
  assert.match(decline, /data-lucide="circle-x"/);
  assert.match(decline, /m15 9-6 6/);
  assert.doesNotMatch(`${approve}${decline}`, /<text\b|Approve|Decline|Enter|Escape/);
});

test("voice key uses the microphone icon and exposes its recording state", () => {
  const idle = decodeDataUrl(renderKeyImage({
    color: "white", primary: "Voice", secondary: "Tap to talk"
  }));
  const active = decodeDataUrl(renderKeyImage({
    color: "blue", primary: "Voice", secondary: "Listening…"
  }));

  assert.match(idle, /data-lucide="mic"/);
  assert.match(idle, />Tap to talk<\/text>/);
  assert.match(active, /data-lucide="mic"/);
  assert.match(active, /#304FFE/);
  assert.match(active, />Listening…<\/text>/);
});

test("each default encoder has a central Lucide pixmap and only a short current value", () => {
  const cases = [
    [{ color: "white", title: "Model", value: "5.6 Sol", hint: "long help" }, "cpu"],
    [{ color: "blue", title: "Reasoning", value: "High", hint: "long help" }, "brain-circuit"],
    [{ color: "green", title: "Speed", value: "Fast", hint: "long help" }, "gauge"],
    [{ color: "amber", title: "Access", value: "Ask", hint: "long help" }, "shield-check"]
  ] as const;

  for (const [presentation, expectedIcon] of cases) {
    const feedback = renderEncoderFeedback(presentation);
    const backdrop = feedbackRecord(feedback.backdrop);
    const accent = feedbackRecord(feedback.accent);
    assert.deepEqual(Object.keys(feedback).sort(), ["accent", "backdrop", "icon", "value", "waveform"]);
    assert.equal(feedback.value, presentation.value);
    assert.equal(backdrop.bar_fill_c, backdrop.bar_bg_c);
    assert.equal(accent.bar_fill_c, accent.bar_bg_c);
    assert.match(decodeDataUrl(feedback.icon as string), new RegExp(`data-lucide="${expectedIcon}"`));
    assert.match(decodeDataUrl(feedback.waveform as string), /data-overlay="clear"/);
  }
});

test("default-only and warning results fit the encoder value row", () => {
  for (const value of ["✓ Default", "⚠ 4/6", "⚠ 0/6"]) {
    const feedback = renderEncoderFeedback({
      color: value.startsWith("⚠") ? "amber" : "blue",
      title: "Model",
      value,
      hint: "result detail"
    });
    assert.equal(feedback.value, value);
    assert.deepEqual(Object.keys(feedback).sort(), ["accent", "backdrop", "icon", "value", "waveform"]);
  }
});

test("voice mode renders four synchronized slices of one full-width waveform", () => {
  assert.equal(VOICE_WAVEFORM_INTERVAL_MS, 100);
  const frame = 7;
  const feedback = [0, 1, 2, 3].map((slice) => renderEncoderFeedback({
    color: "blue",
    title: "Voice",
    value: "Listening…",
    hint: "press again to send",
    mode: "voice",
    slice
  }, frame));
  const svgs = feedback.map((item) => decodeDataUrl(item.waveform as string));

  for (const [slice, item] of feedback.entries()) {
    assert.equal(item.value, "");
    assert.match(decodeDataUrl(item.icon as string), /data-overlay="clear"/);
    assert.equal(feedbackRecord(item.backdrop).background, "#070B12");
    assert.equal(feedbackRecord(item.accent).background, "#070B12");
    assert.match(svgs[slice] ?? "", new RegExp(`viewBox="${slice * 200} 0 200 100"`));
    assert.match(svgs[slice] ?? "", new RegExp(`data-frame="${frame}" data-slice="${slice}"`));
  }

  const mainPaths = svgs.map((svg) => svg.match(/data-waveform-main="true" d="([^"]+)"/)?.[1]);
  assert.ok(mainPaths[0]);
  assert.deepEqual(mainPaths, Array(4).fill(mainPaths[0]));
});

test("voice waveform advances by frame while safely clamping its dial slice", () => {
  const presentation = {
    color: "blue",
    title: "Voice",
    value: "Listening…",
    hint: "",
    mode: "voice"
  } as const;
  const first = decodeDataUrl(renderEncoderFeedback({ ...presentation, slice: -9 }, 0).waveform as string);
  const next = decodeDataUrl(renderEncoderFeedback({ ...presentation, slice: 99 }, 1).waveform as string);

  assert.match(first, /viewBox="0 0 200 100"/);
  assert.match(next, /viewBox="600 0 200 100"/);
  assert.notEqual(
    first.match(/data-waveform-main="true" d="([^"]+)"/)?.[1],
    next.match(/data-waveform-main="true" d="([^"]+)"/)?.[1]
  );
});

test("voice waveform amplitude follows the bounded microphone RMS level", () => {
  const presentation = {
    color: "blue",
    title: "Voice",
    value: "Listening…",
    hint: "",
    mode: "voice",
    slice: 0
  } as const;
  const quiet = decodeDataUrl(
    renderEncoderFeedback(presentation, 4, 0).waveform as string
  );
  const loud = decodeDataUrl(
    renderEncoderFeedback(presentation, 4, 1).waveform as string
  );

  assert.match(quiet, /data-level="0\.000"/);
  assert.match(loud, /data-level="1\.000"/);
  assert.ok(waveformRange(loud) > waveformRange(quiet) * 8);
});

test("missing optional RMS input keeps the voice waveform active without a permission warning", () => {
  const feedback = renderEncoderFeedback({
    color: "blue",
    title: "Voice",
    value: "Listening…",
    hint: "",
    mode: "voice",
    slice: 0
  }, 5, 0);
  const serialized = JSON.stringify(feedback);

  assert.equal(feedback.value, "");
  assert.match(decodeDataUrl(feedback.waveform as string), /data-level="0\.000"/);
  assert.doesNotMatch(serialized, /Allow Mic|#FF6D00/);
});

test("the four focused encoder icons use vendored upstream Lucide geometry", () => {
  const presentations = [
    { color: "white", title: "Model", value: "5.6 Sol", hint: "" },
    { color: "blue", title: "Reasoning", value: "High", hint: "" },
    { color: "green", title: "Speed", value: "Fast", hint: "" },
    { color: "amber", title: "Access", value: "Ask", hint: "" }
  ] as const;
  const svgs = presentations.map((presentation) => decodeDataUrl(
    renderEncoderFeedback(presentation).icon as string
  ));

  assert.match(svgs[0] ?? "", /<rect width="6" height="6" x="9" y="9" rx="1"\/>/);
  assert.match(svgs[1] ?? "", /M12 5a3 3 0 1 0-5\.997\.125/);
  assert.match(svgs[2] ?? "", /M3\.34 19a10 10 0 1 1 17\.32 0/);
  assert.match(svgs[3] ?? "", /m9 12 2 2 4-4/);
});

test("property inspector separates trailing config apply from the shared voice toggle", () => {
  const inspector = readFileSync(
    new URL("../works.kawaii.codex-shortcuts-plugin.sdPlugin/ui/property-inspector.js", import.meta.url),
    "utf8"
  );
  const encoderRoles = inspector.match(/const ENCODER_ROLES = \[([\s\S]*?)\n  \];/)?.[1] ?? "";

  assert.deepEqual(
    [...encoderRoles.matchAll(/role\("([^"]+)"/g)].map((match) => match[1]),
    ["model", "reasoning", "speed", "approval"]
  );
  for (const copy of [
    "Choose a", "Reload current settings", "Reset to",
    "next turn", "new-task default", "does not need to restart"
  ]) {
    assert.match(encoderRoles, new RegExp(copy));
  }
  assert.equal((encoderRoles.match(/automatically applies 300 ms after rotation stops/g) ?? []).length, 4);
  assert.equal(
    (encoderRoles.match(/Start dictation \/ press again to transcribe and send/g) ?? []).length,
    4
  );
  assert.doesNotMatch(encoderRoles, /apply immediately|press Full again within 4 seconds/);
  assert.match(inspector, /successful update keeps the selected value visible/);
  assert.match(inspector, /uses the shared dictation control/);
  for (const accessDetail of ["workspace writes", "delegated approval", "full access"]) {
    assert.match(encoderRoles, new RegExp(accessDetail));
  }
  for (const accessValue of ["Ask", "Delegate", "Full", "Custom"]) {
    assert.match(encoderRoles, new RegExp(accessValue));
  }
  assert.match(encoderRoles, /including Full/);
  assert.match(encoderRoles, /Only Custom leaves config\.toml unchanged/);
  assert.match(inspector, /role\("legacy-reasoning", "Legacy Layout: Reasoning"/);
  assert.match(inspector, /function isFocusedEncoder\(value\)/);
  assert.match(inspector, /function rolesForCurrentAction\(\)/);
  assert.match(inspector, /return legacy \? \[legacy, \.\.\.ENCODER_ROLES\] : ENCODER_ROLES/);
});

test("marketplace-facing manifest and property inspector copy are English", () => {
  const pluginRoot = new URL(
    "../works.kawaii.codex-shortcuts-plugin.sdPlugin/",
    import.meta.url
  );
  const publicCopy = [
    readFileSync(new URL("manifest.json", pluginRoot), "utf8"),
    readFileSync(new URL("ui/property-inspector.html", pluginRoot), "utf8"),
    readFileSync(new URL("ui/property-inspector.js", pluginRoot), "utf8")
  ].join("\n");

  assert.doesNotMatch(publicCopy, /[ぁ-んァ-ン一-龯々]/u);
});

test("encoder layout centers the icon and covers the full dial strip slice with its waveform overlay", () => {
  const layout = JSON.parse(readFileSync(
    new URL("../works.kawaii.codex-shortcuts-plugin.sdPlugin/layouts/encoder.json", import.meta.url),
    "utf8"
  )) as {
    items: Array<{
      key: string;
      type: string;
      rect: number[];
      bar_bg_c?: string;
      bar_fill_c?: string;
    }>;
  };
  const keys = layout.items.map((item) => item.key);
  const icon = layout.items.find((item) => item.key === "icon");
  const waveform = layout.items.find((item) => item.key === "waveform");
  const bars = layout.items.filter((item) => item.type === "bar");

  assert.deepEqual(keys, ["backdrop", "accent", "icon", "value", "waveform"]);
  assert.equal(icon?.type, "pixmap");
  assert.equal((icon?.rect[0] ?? 0) + (icon?.rect[2] ?? 0) / 2, 100);
  assert.equal(waveform?.type, "pixmap");
  assert.deepEqual(waveform?.rect, [0, 0, 200, 100]);
  assert.ok(bars.length > 0);
  for (const bar of bars) {
    assert.ok(bar.bar_fill_c);
    assert.equal(bar.bar_fill_c, bar.bar_bg_c);
  }
  assert.ok(!keys.includes("title"));
  assert.ok(!keys.includes("hint"));
});

test("manifest icons use the same vendored Lucide geometry", () => {
  const iconDir = new URL("../works.kawaii.codex-shortcuts-plugin.sdPlugin/imgs/", import.meta.url);
  const keyIcon = readFileSync(new URL("action-key.svg", iconDir), "utf8");
  const encoderIcon = readFileSync(new URL("action-encoder.svg", iconDir), "utf8");
  const categoryIcon = readFileSync(new URL("category-icon.svg", iconDir), "utf8");

  assert.match(keyIcon, /M12 8V4H8/);
  assert.match(encoderIcon, /M15 6v12a3 3 0 1 0 3-3H6/);
  assert.match(categoryIcon, /M12 8V4H8/);
});

test("the distributed plugin carries the Lucide and Feather license notices", () => {
  const notice = readFileSync(
    new URL(
      "../works.kawaii.codex-shortcuts-plugin.sdPlugin/THIRD_PARTY_NOTICES.md",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(notice, /658573b0171e693bc965c167592cc0b92d002a3e/);
  assert.match(notice, /ISC License/);
  assert.match(notice, /The MIT License \(MIT\)/);
});
