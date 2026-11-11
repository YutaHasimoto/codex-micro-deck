#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const PLUGIN_DIR = join(PROJECT_DIR, "works.kawaii.codex-shortcuts-plugin.sdPlugin");
const MANIFEST_PATH = join(PLUGIN_DIR, "manifest.json");
const PACKAGE_PATH = join(PROJECT_DIR, "package.json");
const LICENSE_PATH = join(PROJECT_DIR, "LICENSE");
const THIRD_PARTY_NOTICES_PATH = join(PROJECT_DIR, "THIRD_PARTY_NOTICES.md");
const PLUGIN_SOURCE_PATH = join(PROJECT_DIR, "src", "plugin.ts");
const MICROPHONE_METER_BUILD_PATH = join(PROJECT_DIR, "scripts", "build-mic-level-meter.mjs");

const PLUGIN_UUID = "works.kawaii.codex-shortcuts-plugin";
const PLUGIN_NAME = "Codex Shortcuts Plugin";
const PLUGIN_AUTHOR = "KAWAII";
const KEY_UUID = `${PLUGIN_UUID}.key`;
const ENCODER_UUID = `${PLUGIN_UUID}.encoder`;
const DEVICE_MODEL = "20GBD9901";
const EXPECTED_KEYS = new Map([
  ["0,0", "agent-1"],
  ["1,0", "agent-2"],
  ["2,0", "agent-3"],
  ["3,0", "agent-4"],
  ["0,1", "agent-5"],
  ["1,1", "agent-6"],
  ["2,1", "approve"],
  ["3,1", "voice-toggle"]
]);
const EXPECTED_ENCODERS = new Map([
  ["0,0", "model"],
  ["1,0", "reasoning"],
  ["2,0", "speed"],
  ["3,0", "approval"]
]);
const RESOURCE_EXTENSIONS = ["", ".svg", ".png", ".jpg", ".jpeg", ".gif"];

let checkCount = 0;

function check(condition, message) {
  checkCount += 1;
  if (!condition) throw new Error(message);
}

function readJson(path, label) {
  check(existsSync(path), `${label} is missing: ${relative(PROJECT_DIR, path)}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveInsidePlugin(resourcePath, label) {
  check(typeof resourcePath === "string" && resourcePath.length > 0, `${label} must be a non-empty path.`);
  check(!isAbsolute(resourcePath), `${label} must be relative to the plugin directory.`);
  const target = resolve(PLUGIN_DIR, resourcePath);
  check(target === PLUGIN_DIR || target.startsWith(`${PLUGIN_DIR}${sep}`), `${label} escapes the plugin directory.`);
  return target;
}

function requireResource(resourcePath, label, extensions = RESOURCE_EXTENSIONS) {
  if (typeof resourcePath === "string" && resourcePath.startsWith("$")) return resourcePath;
  const base = resolveInsidePlugin(resourcePath, label);
  const candidate = extensions.map((extension) => `${base}${extension}`).find((path) => existsSync(path));
  check(Boolean(candidate), `${label} does not exist: ${resourcePath}`);
  check(statSync(candidate).isFile(), `${label} must point to a file: ${resourcePath}`);
  check(statSync(candidate).size > 0, `${label} is empty: ${resourcePath}`);
  return candidate;
}

function validatePackageAndManifest() {
  const packageJson = readJson(PACKAGE_PATH, "package.json");
  const manifest = readJson(MANIFEST_PATH, "plugin manifest");
  const pluginSource = readFileSync(PLUGIN_SOURCE_PATH, "utf8");
  const microphoneMeterBuild = readFileSync(MICROPHONE_METER_BUILD_PATH, "utf8");
  const license = readFileSync(LICENSE_PATH, "utf8");
  const thirdPartyNotices = readFileSync(THIRD_PARTY_NOTICES_PATH, "utf8");

  check(manifest.UUID === PLUGIN_UUID, `Plugin UUID must be ${PLUGIN_UUID}.`);
  check(manifest.Name === PLUGIN_NAME, `Plugin name must be ${PLUGIN_NAME}.`);
  check(manifest.Author === PLUGIN_AUTHOR, `Plugin author must be ${PLUGIN_AUTHOR}.`);
  check(packageJson.license === "SEE LICENSE IN LICENSE",
    "package.json must point readers to the custom LICENSE file.");
  check(manifest.SDKVersion === 3, "SDKVersion must be 3 for the Stream Deck + profile.");
  check(manifest.Nodejs?.Version === "24", "The plugin runtime must target Node.js 24.");
  check(Number.parseFloat(manifest.Software?.MinimumVersion) >= 7.1, "Stream Deck 7.1 or newer is required.");
  check(Array.isArray(manifest.OS) && manifest.OS.some((entry) => entry.Platform === "mac"), "The manifest must declare macOS support.");
  check(Array.isArray(manifest.ApplicationsToMonitor?.mac)
    && manifest.ApplicationsToMonitor.mac.includes("com.openai.codex"),
  "The manifest must monitor the Codex desktop bundle ID.");
  check(typeof manifest.Version === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(manifest.Version),
    "Manifest Version must have four numeric components.");
  check(typeof packageJson.version === "string"
    && manifest.Version.startsWith(`${packageJson.version}.`),
  "package.json and manifest versions must agree.");
  check(typeof packageJson.scripts?.pack === "string"
    && packageJson.scripts.pack.includes(`--output dist-marketplace-v${packageJson.version} `),
  "The pack script must write to the current versioned marketplace directory.");
  check(/streamDeck\.settings\.useExperimentalMessageIdentifiers\s*=\s*true;\s*await streamDeck\.connect\(\);/m.test(pluginSource),
    "The plugin must filter internal settings-request responses before connecting.");

  const bundledLicense = requireResource("LICENSE", "Plugin license", [""]);
  const bundledThirdPartyNotices = requireResource(
    "THIRD_PARTY_NOTICES.md",
    "Third-party notices",
    [""]
  );
  check(readFileSync(bundledLicense, "utf8") === license,
    "The bundled LICENSE must exactly match the root LICENSE.");
  check(readFileSync(bundledThirdPartyNotices, "utf8") === thirdPartyNotices,
    "The bundled third-party notices must exactly match the root notices.");
  const normalizedLicense = license.replace(/\s+/g, " ");
  for (const requiredLicenseTerm of [
    "KAWAII Freeware License",
    "Copyright (c) 2026 KAWAII. All rights reserved.",
    "free of charge",
    "personal use",
    "internal use within your organization",
    "install, and use an unmodified copy",
    "commercially distribute",
    "repackage",
    "mirror",
    "sublicense",
    "applicable law does not permit KAWAII to limit or exclude",
    "KAWAII retains all right, title, and interest",
    "THIRD_PARTY_NOTICES.md",
    "WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND",
    "terminates automatically"
  ]) {
    check(normalizedLicense.toLowerCase().includes(requiredLicenseTerm.toLowerCase()),
      `LICENSE is missing the required term: ${requiredLicenseTerm}`);
  }

  requirePngPair(manifest.Icon, "Plugin icon", [256, 256], [512, 512]);
  requireResource(manifest.CategoryIcon, "Category icon");
  requireResource(manifest.CodePath, "CodePath", [""]);
  const microphoneMeter = requireResource("bin/mic-level-meter", "Microphone level meter", [""]);
  check((statSync(microphoneMeter).mode & 0o111) !== 0,
    "Microphone level meter must be executable.");
  const microphoneMeterLoadCommands = execFileSync("/usr/bin/otool", ["-l", microphoneMeter], {
    encoding: "utf8"
  });
  check(!microphoneMeterLoadCommands.includes("__info_plist"),
    "Microphone level meter binary must not contain an embedded app Info.plist.");
  check(!microphoneMeterBuild.includes("mic-level-meter-info.plist")
    && !microphoneMeterBuild.includes("-sectcreate"),
  "Microphone level meter must not embed an app Info.plist.");
  check(!microphoneMeterBuild.includes("--identifier"),
    "Microphone level meter must not declare an independent code-signing identifier.");
  check(microphoneMeterBuild.includes(
    'const output = join(root, "works.kawaii.codex-shortcuts-plugin.sdPlugin", "bin", "mic-level-meter");'
  ),
    "Microphone level meter must remain a direct non-app child executable.");

  check(Array.isArray(manifest.Actions) && manifest.Actions.length === 2,
    "The manifest must contain exactly one key action and one encoder action.");
  const actionsByUuid = new Map();
  for (const action of manifest.Actions) {
    check(typeof action.UUID === "string" && action.UUID.startsWith(`${PLUGIN_UUID}.`),
      "Every action UUID must be namespaced under the plugin UUID.");
    check(!actionsByUuid.has(action.UUID), `Duplicate action UUID: ${action.UUID}`);
    actionsByUuid.set(action.UUID, action);
    requireResource(action.Icon, `${action.UUID} icon`);
    requireResource(action.PropertyInspectorPath, `${action.UUID} property inspector`, [""]);
    check(Array.isArray(action.States) && action.States.length > 0, `${action.UUID} must define at least one state.`);
    for (const [index, state] of action.States.entries()) {
      requireResource(state.Image, `${action.UUID} state ${index} image`);
    }
  }

  const keyAction = actionsByUuid.get(KEY_UUID);
  const encoderAction = actionsByUuid.get(ENCODER_UUID);
  check(Boolean(keyAction), `Missing key action ${KEY_UUID}.`);
  check(Boolean(encoderAction), `Missing encoder action ${ENCODER_UUID}.`);
  check(Array.isArray(keyAction.Controllers) && keyAction.Controllers.length === 1
    && keyAction.Controllers[0] === "Keypad", "The key action must target Keypad only.");
  check(Array.isArray(encoderAction.Controllers) && encoderAction.Controllers.length === 1
    && encoderAction.Controllers[0] === "Encoder", "The encoder action must target Encoder only.");
  requireResource(encoderAction.Encoder?.Icon, "Encoder icon");
  check(encoderAction.Tooltip?.includes("press to start or send Codex dictation"),
    "The encoder tooltip must explain the shared dictation action.");
  check(encoderAction.Encoder?.TriggerDescription?.Push
    === "Start dictation / press again to transcribe and send",
  "The encoder push description must explain start, transcription, and send.");
  check(encoderAction.Encoder?.TriggerDescription?.Rotate?.includes("disabled during dictation"),
    "The encoder rotate description must explain the voice lock.");
  const layoutPath = requireResource(encoderAction.Encoder?.layout, "Encoder layout", [""]);
  validateLayout(readJson(layoutPath, "encoder layout"));
  validatePropertyInspector(keyAction.PropertyInspectorPath);

  check(Array.isArray(manifest.Profiles) && manifest.Profiles.length === 1,
    "The manifest must bundle exactly one Stream Deck + profile.");
  const profile = manifest.Profiles[0];
  check(profile.DeviceType === 7, "Bundled profile DeviceType must be 7 (Stream Deck +).");
  check(profile.AutoInstall === true, "Bundled profile must opt into automatic installation.");
  check(profile.DontAutoSwitchWhenInstalled === true,
    "Installing the profile must not unexpectedly replace the user's current profile.");
  const profileArchive = requireResource(`${profile.Name}.streamDeckProfile`, "Bundled profile", [""]);
  validateProfileArchive(profileArchive, manifest.Version);
}

function requirePngPair(resourcePath, label, baseSize, retinaSize) {
  const base = resolveInsidePlugin(resourcePath, label);
  const standardPath = `${base}.png`;
  const retinaPath = `${base}@2x.png`;
  check(existsSync(standardPath), `${label} must be a PNG file: ${resourcePath}.png`);
  check(existsSync(retinaPath), `${label} must include a @2x PNG file: ${resourcePath}@2x.png`);
  validatePngSize(standardPath, baseSize, label);
  validatePngSize(retinaPath, retinaSize, `${label} @2x`);
}

function validatePngSize(path, expected, label) {
  const data = readFileSync(path);
  const signature = "89504e470d0a1a0a";
  check(data.length >= 24 && data.subarray(0, 8).toString("hex") === signature,
    `${label} is not a valid PNG file.`);
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  check(width === expected[0] && height === expected[1],
    `${label} must be ${expected[0]}x${expected[1]} px, got ${width}x${height}.`);
}

function validateLayout(layout) {
  check(typeof layout.id === "string" && layout.id.length > 0, "Encoder layout needs an id.");
  check(Array.isArray(layout.items) && layout.items.length > 0, "Encoder layout needs items.");
  const keys = new Set();
  for (const item of layout.items) {
    check(typeof item.key === "string" && item.key.length > 0, "Every layout item needs a key.");
    check(!keys.has(item.key), `Duplicate encoder layout key: ${item.key}`);
    keys.add(item.key);
    check(Array.isArray(item.rect) && item.rect.length === 4
      && item.rect.every((value) => Number.isFinite(value)), `Layout item ${item.key} has an invalid rect.`);
    if (item.type === "bar") {
      check(typeof item.bar_fill_c === "string" && item.bar_fill_c.length > 0,
        `Layout bar ${item.key} needs a non-empty bar_fill_c.`);
      check(item.bar_fill_c === item.bar_bg_c,
        `Layout bar ${item.key} must use the same bar_fill_c and bar_bg_c.`);
    }
  }
  for (const required of ["backdrop", "accent", "icon", "value", "waveform"]) {
    check(keys.has(required), `Encoder layout is missing the ${required} item.`);
  }
  const icon = layout.items.find((item) => item.key === "icon");
  const waveform = layout.items.find((item) => item.key === "waveform");
  check(icon?.type === "pixmap", "Encoder layout icon must use a pixmap item.");
  check(waveform?.type === "pixmap", "Encoder layout waveform must use a pixmap item.");
  check(JSON.stringify(waveform?.rect) === JSON.stringify([0, 0, 200, 100]),
    "Encoder layout waveform must cover the full 200x100 dial display.");
}

function validatePropertyInspector(propertyInspectorPath) {
  const htmlPath = requireResource(propertyInspectorPath, "Property inspector HTML", [""]);
  const html = readFileSync(htmlPath, "utf8");
  const localScripts = [];
  const localStyles = [];
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const value = match[1];
    if (!value || /^(?:data:|#)/.test(value)) continue;
    check(!/^(?:https?:|\/\/)/.test(value),
      `Property inspector must not load an external dependency: ${value}`);
    const target = resolve(dirname(htmlPath), value);
    check(target.startsWith(`${PLUGIN_DIR}${sep}`), `Property inspector resource escapes the plugin: ${value}`);
    check(existsSync(target) && statSync(target).isFile(), `Property inspector resource is missing: ${value}`);
    if (value.endsWith(".js")) localScripts.push(target);
    if (value.endsWith(".css")) localStyles.push(target);
  }

  check(localScripts.length > 0, "Property inspector must load a local JavaScript file.");
  check(localStyles.length > 0, "Property inspector must load a local stylesheet.");
  check(/<html\b[^>]*\blang=["']en["']/i.test(html),
    "Property inspector must declare English as its primary language.");
  check(!/\son[a-z]+\s*=/i.test(html),
    "Property inspector must not use inline event handlers.");
  check(!/[✓⌘]/u.test(html) && !html.includes("notice-icon") && !html.includes("connection-dot"),
    "Property inspector notices must use text and borders instead of improvised icons.");

  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  check(ids.length === new Set(ids).size, "Property inspector element IDs must be unique.");
  const requiredIds = [
    "role", "role-guide", "role-summary", "role-operations", "save-state",
    "connection-state", "agent-options", "fixed-thread-options", "thread-id",
    "approval-guard", "shortcut-options", "shortcut-message", "permission-note",
    "accessibility-enabled", "poll-interval"
  ];
  for (const id of requiredIds) {
    check(ids.includes(id), `Property inspector is missing the #${id} UI contract.`);
  }

  const elementTag = (id) => html.match(new RegExp(`<[^>]+\\bid=["']${id}["'][^>]*>`, "i"))?.[0] ?? "";
  check(/\baria-live=["']polite["']/i.test(elementTag("save-state")),
    "Save feedback must be announced with aria-live.");
  check(/\baria-live=["']polite["']/i.test(elementTag("connection-state")),
    "Connection feedback must be announced with aria-live.");
  check(!/\b(?:disabled|hidden)\b/i.test(elementTag("accessibility-enabled")),
    "The accessibility runtime switch must remain visible and editable.");

  for (const requiredCopy of [
    "Task ID", "approval request", "Accessibility", "remain available when this is off",
    "Pressing a dial will not start dictation"
  ]) {
    check(html.includes(requiredCopy), `Property inspector is missing its ${requiredCopy} explanation.`);
  }

  const script = localScripts.map((path) => readFileSync(path, "utf8")).join("\n");
  check(/connectElgatoStreamDeckSocket/.test(script),
    "Property inspector must register connectElgatoStreamDeckSocket.");
  for (const message of ["setSettings", "setGlobalSettings", "getGlobalSettings"]) {
    check(script.includes(`"${message}"`), `Property inspector must support ${message}.`);
  }
  for (const behavior of [
    "renderRoleGuide", "renderVisibility", "scheduleSave", "validThreadId",
    "validShortcut", "isProtectedRole", "isFocusedEncoder"
  ]) {
    check(script.includes(behavior), `Property inspector is missing ${behavior}.`);
  }
  check(script.includes('value === "approve"') && script.includes('value === "decline"'),
    "Property inspector must identify both protected approval roles.");
  check(script.includes('role("voice-toggle"'),
    "Property inspector must offer the toggle voice key role.");
  for (const role of ["model", "reasoning", "speed", "approval"]) {
    check(script.includes(`role("${role}"`),
      `Property inspector must offer the ${role} encoder role.`);
  }
  for (const explanation of [
    "automatically applies 300 ms after rotation stops",
    "Start dictation / press again to transcribe and send",
    "Choose an Access mode (auto-applies to the next turn after 300 ms)",
    "Reload current settings", "Reset to",
    "next turn", "new-task default", "does not need to restart",
    "successful update keeps the selected value visible",
    "X/N means some or all task syncs failed",
    "including Full", "Only Custom leaves config.toml unchanged"
  ]) {
    check(script.includes(explanation),
      `Property inspector must explain the ${explanation} encoder gesture.`);
  }
  check(/elements\.accessibility\.addEventListener\(["']change["']/.test(script)
    && /globals\.accessibilityEnabled\s*=/.test(script),
  "Property inspector must persist accessibilityEnabled changes.");

  const css = localStyles.map((path) => readFileSync(path, "utf8")).join("\n");
  check(!css.includes(".notice-icon") && !css.includes(".connection-dot"),
    "Property inspector CSS must not draw notice or connection icons.");
  for (const selector of [
    ".save-status", ".role-guide", ".operation-list", ".notice.safety",
    'input[aria-invalid="true"]', "[hidden]"
  ]) {
    check(css.includes(selector), `Property inspector stylesheet is missing ${selector}.`);
  }
}

function validatePropertyInspectorOnly() {
  const manifest = readJson(MANIFEST_PATH, "plugin manifest");
  const keyAction = Array.isArray(manifest.Actions)
    ? manifest.Actions.find((action) => action.UUID === KEY_UUID)
    : undefined;
  check(Boolean(keyAction?.PropertyInspectorPath),
    `Missing property inspector path on ${KEY_UUID}.`);
  validatePropertyInspector(keyAction.PropertyInspectorPath);
}

function validateProfileArchive(archivePath, pluginVersion) {
  const zip = readZip(archivePath);
  const unsafeEntry = [...zip.keys()].find((name) => name.startsWith("/")
    || name.includes("\\")
    || name.split("/").includes(".."));
  check(!unsafeEntry, `Profile archive contains an unsafe path: ${unsafeEntry}`);

  const rootManifestNames = [...zip.keys()].filter((name) => /^[^/]+\.sdProfile\/manifest\.json$/i.test(name));
  check(rootManifestNames.length === 1, "Profile archive must contain exactly one .sdProfile root manifest.");
  const rootManifestName = rootManifestNames[0];
  const rootPrefix = rootManifestName.slice(0, -"manifest.json".length);
  const root = parseZipJson(zip, rootManifestName, "profile root manifest");

  check(root.Version === "3.0", "Bundled profile must use the V3 profile format.");
  check(root.Name === "Codex Shortcuts Plugin",
    "Bundled profile name must be Codex Shortcuts Plugin.");
  check(root.Device?.Model === DEVICE_MODEL, `Bundled profile must target device model ${DEVICE_MODEL}.`);
  check(root.Device?.UUID === "", "Bundled profile must not be bound to one physical device.");
  check(Array.isArray(root.Pages?.Pages) && root.Pages.Pages.length === 1,
    "Bundled profile must contain exactly one page.");

  const pageId = root.Pages.Pages[0];
  check(typeof pageId === "string" && /^[0-9a-f-]{36}$/i.test(pageId), "Bundled profile page ID is invalid.");
  check(String(root.Pages.Current).toLowerCase() === pageId.toLowerCase(), "Current page must match the bundled page.");
  check(!("Default" in root.Pages),
    "Bundled profile must omit Pages.Default to avoid Stream Deck duplicate-page remapping.");

  const expectedPageName = `${rootPrefix}Profiles/${pageId}/manifest.json`.toLowerCase();
  const pageManifestName = [...zip.keys()].find((name) => name.toLowerCase() === expectedPageName);
  check(Boolean(pageManifestName), `Profile archive is missing the page manifest for ${pageId}.`);
  const page = parseZipJson(zip, pageManifestName, "profile page manifest");
  const controllers = Array.isArray(page.Controllers) ? page.Controllers : [];
  check(controllers.length === 2, "Profile page must contain Keypad and Encoder controllers only.");
  const keypad = controllers.find((controller) => controller.Type === "Keypad")?.Actions;
  const encoder = controllers.find((controller) => controller.Type === "Encoder")?.Actions;
  validateAssignments(keypad, EXPECTED_KEYS, KEY_UUID, pluginVersion, "key");
  validateAssignments(encoder, EXPECTED_ENCODERS, ENCODER_UUID, pluginVersion, "encoder");
}

function validateAssignments(actions, expected, expectedUuid, pluginVersion, label) {
  check(actions && typeof actions === "object" && !Array.isArray(actions),
    `Profile ${label} controller has no actions.`);
  const coordinates = Object.keys(actions).sort();
  check(JSON.stringify(coordinates) === JSON.stringify([...expected.keys()].sort()),
    `Profile ${label} coverage is invalid: ${coordinates.join(", ")}`);
  const actionIds = new Set();
  for (const [coordinate, role] of expected) {
    const action = actions[coordinate];
    check(action?.UUID === expectedUuid, `${label} ${coordinate} has the wrong action UUID.`);
    check(action?.Plugin?.UUID === expectedUuid, `${label} ${coordinate} has the wrong plugin UUID.`);
    check(action?.Plugin?.Version === pluginVersion, `${label} ${coordinate} has a stale plugin version.`);
    check(action?.Settings?.role === role, `${label} ${coordinate} must be assigned to ${role}.`);
    if (label === "encoder") {
      check(action.Settings.layoutVersion === 2,
        `encoder ${coordinate} must declare layoutVersion 2.`);
    }
    check(typeof action?.ActionID === "string" && /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(action.ActionID),
      `${label} ${coordinate} has an invalid ActionID.`);
    check(!actionIds.has(action.ActionID), `Duplicate ${label} ActionID: ${action.ActionID}`);
    actionIds.add(action.ActionID);
    if (role.startsWith("agent-")) {
      check(action.Settings.autoAssign === true, `${label} ${coordinate} must auto-assign its recent agent task.`);
    }
  }
}

function parseZipJson(zip, name, label) {
  try {
    return JSON.parse(zip.get(name).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Minimal ZIP reader for validation. It supports the stored and deflated entry
 * types emitted by macOS /usr/bin/zip and needs no npm package or shell tool.
 */
function readZip(path) {
  const data = readFileSync(path);
  const eocd = findEndOfCentralDirectory(data);
  check(eocd >= 0, "Bundled profile is not a valid ZIP archive.");
  check(data.readUInt16LE(eocd + 4) === 0 && data.readUInt16LE(eocd + 6) === 0,
    "Multi-disk ZIP archives are not supported.");
  const entryCount = data.readUInt16LE(eocd + 10);
  const centralOffset = data.readUInt32LE(eocd + 16);
  const entries = new Map();
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    check(offset + 46 <= data.length && data.readUInt32LE(offset) === 0x02014b50,
      `Invalid ZIP central directory entry ${index}.`);
    const flags = data.readUInt16LE(offset + 8);
    const compression = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    check(nameEnd + extraLength + commentLength <= data.length, `ZIP entry ${index} is truncated.`);
    const name = data.subarray(nameStart, nameEnd).toString("utf8");
    check(!entries.has(name), `Profile archive contains a duplicate entry: ${name}`);
    check((flags & 0x1) === 0, `Profile archive entry is encrypted: ${name}`);
    check(localOffset + 30 <= data.length && data.readUInt32LE(localOffset) === 0x04034b50,
      `ZIP local header is invalid: ${name}`);
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
    const payloadEnd = payloadStart + compressedSize;
    check(payloadEnd <= data.length, `ZIP entry payload is truncated: ${name}`);
    const payload = data.subarray(payloadStart, payloadEnd);
    let output;
    if (compression === 0) output = Buffer.from(payload);
    else if (compression === 8) output = inflateRawSync(payload);
    else throw new Error(`Unsupported ZIP compression method ${compression}: ${name}`);
    check(output.length === uncompressedSize, `ZIP entry size mismatch: ${name}`);
    entries.set(name, output);
    offset = nameEnd + extraLength + commentLength;
  }

  check(entries.size === entryCount, "ZIP entry count mismatch.");
  return entries;
}

function findEndOfCentralDirectory(data) {
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

try {
  if (process.argv.includes("--ui-only")) {
    validatePropertyInspectorOnly();
    console.log(`Codex Shortcuts Plugin UI validation passed (${checkCount} checks).`);
  } else {
    validatePackageAndManifest();
    console.log(`Codex Shortcuts Plugin validation passed (${checkCount} checks).`);
  }
} catch (error) {
  console.error(`Codex Shortcuts Plugin validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
