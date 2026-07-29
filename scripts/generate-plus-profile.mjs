#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_FILE);
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const PLUGIN_DIR = join(PROJECT_DIR, "works.kawaii.codex-shortcuts-plugin.sdPlugin");
const SOURCE_DIR = join(PROJECT_DIR, "profile-src");
const PROFILE_NAME = "Codex Shortcuts Plugin";
const PROFILE_ROOT_ID = "3E164788-8FC1-4D6E-A05B-9CF12433E33D";
const PAGE_ID = "AA602386-8869-4B99-AFF3-2BE431B9A90A";
const PROFILE_ROOT = `${PROFILE_ROOT_ID}.sdProfile`;
const SOURCE_CONTAINER = join(SOURCE_DIR, `${PROFILE_NAME}.streamDeckProfile.contents`);
const SOURCE_ROOT = join(SOURCE_CONTAINER, PROFILE_ROOT);
const SOURCE_PAGE = join(SOURCE_ROOT, "Profiles", PAGE_ID);
const OUTPUT_FILE = join(PLUGIN_DIR, "profiles", `${PROFILE_NAME}.streamDeckProfile`);
export const PLUGIN_VERSION = "0.4.13.0";
const KEY_UUID = "works.kawaii.codex-shortcuts-plugin.key";
const ENCODER_UUID = "works.kawaii.codex-shortcuts-plugin.encoder";
const KEY_ACTION_NAME = "Codex Task Shortcuts";
const ENCODER_ACTION_NAME = "Codex Settings Dial";

const KEY_ASSIGNMENTS = [
  ["0,0", "agent-1", "Agent 1"],
  ["1,0", "agent-2", "Agent 2"],
  ["2,0", "agent-3", "Agent 3"],
  ["3,0", "agent-4", "Agent 4"],
  ["0,1", "agent-5", "Agent 5"],
  ["1,1", "agent-6", "Agent 6"],
  ["2,1", "approve", "Approve"],
  ["3,1", "voice-toggle", "Voice"]
];

const ENCODER_ASSIGNMENTS = [
  ["0,0", "model", "Model"],
  ["1,0", "reasoning", "Reasoning"],
  ["2,0", "speed", "Speed"],
  ["3,0", "approval", "Access"]
];

const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");

function stableUuid(seed) {
  const hex = createHash("sha256").update(`codex-micro-deck:${seed}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("").toUpperCase();
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function makeAction({ coordinate, role, label, controller }) {
  const isEncoder = controller === "Encoder";
  const uuid = isEncoder ? ENCODER_UUID : KEY_UUID;
  const settings = { role, ...(isEncoder ? { layoutVersion: 2 } : {}) };
  if (role.startsWith("agent-")) settings.autoAssign = true;

  return {
    ActionID: stableUuid(`${controller}:${coordinate}:${role}`),
    ...(isEncoder ? { Encoder: { IconVisible: true } } : {}),
    // The plugin renders the complete key/dial surface. Host titles create a
    // second, tiny label over the artwork and make the device hard to scan.
    LinkedTitle: false,
    Name: isEncoder ? ENCODER_ACTION_NAME : KEY_ACTION_NAME,
    Plugin: {
      Name: isEncoder ? ENCODER_ACTION_NAME : KEY_ACTION_NAME,
      UUID: uuid,
      Version: PLUGIN_VERSION
    },
    Resources: null,
    Settings: settings,
    State: 0,
    States: [{ Title: "", ShowTitle: false }],
    UUID: uuid
  };
}

function actionsFrom(assignments, controller) {
  return Object.fromEntries(assignments.map(([coordinate, role, label]) => [
    coordinate,
    makeAction({ coordinate, role, label, controller })
  ]));
}

export function expectedRootManifest() {
  const pageRef = PAGE_ID.toLowerCase();
  return {
    Device: { Model: "20GBD9901", UUID: "" },
    Name: PROFILE_NAME,
    // Stream Deck creates its own default page during import. Reusing the
    // current page as `Default` makes the importer attempt to remap the same
    // UUID twice and leaves a dangling page reference.
    Pages: { Current: pageRef, Pages: [pageRef] },
    Version: "3.0"
  };
}

export function expectedPageManifest() {
  return {
    Controllers: [
      { Actions: actionsFrom(ENCODER_ASSIGNMENTS, "Encoder"), Type: "Encoder" },
      { Actions: actionsFrom(KEY_ASSIGNMENTS, "Keypad"), Type: "Keypad" }
    ],
    Icon: "",
    Name: ""
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function validateManifests(rootManifest, pageManifest) {
  if (rootManifest.Version !== "3.0") throw new Error("Profile must use the current V3 structure.");
  if (rootManifest.Device?.Model !== "20GBD9901") throw new Error("Profile must target Stream Deck +.");
  if (rootManifest.Device?.UUID !== "") throw new Error("Bundled profile must not bind to one physical device.");
  if (rootManifest.Name !== PROFILE_NAME) throw new Error("Profile name mismatch.");
  if ("Default" in (rootManifest.Pages ?? {})) {
    throw new Error("Bundled profile must let Stream Deck create its default page.");
  }

  const encoder = pageManifest.Controllers?.find((item) => item.Type === "Encoder")?.Actions ?? {};
  const keypad = pageManifest.Controllers?.find((item) => item.Type === "Keypad")?.Actions ?? {};
  const keyCoordinates = Object.keys(keypad).sort();
  const encoderCoordinates = Object.keys(encoder).sort();
  const expectedKeyCoordinates = KEY_ASSIGNMENTS.map(([coordinate]) => coordinate).sort();
  const expectedEncoderCoordinates = ENCODER_ASSIGNMENTS.map(([coordinate]) => coordinate).sort();

  if (JSON.stringify(keyCoordinates) !== JSON.stringify(expectedKeyCoordinates)) {
    throw new Error(`Key coverage mismatch: ${keyCoordinates.join(", ")}`);
  }
  if (JSON.stringify(encoderCoordinates) !== JSON.stringify(expectedEncoderCoordinates)) {
    throw new Error(`Encoder coverage mismatch: ${encoderCoordinates.join(", ")}`);
  }

  for (const [coordinate, role] of KEY_ASSIGNMENTS) {
    const action = keypad[coordinate];
    if (action?.UUID !== KEY_UUID || action?.Settings?.role !== role) {
      throw new Error(`Invalid key assignment at ${coordinate}.`);
    }
    validateActionPluginVersion(action, KEY_UUID, "key", coordinate);
  }
  for (const [coordinate, role] of ENCODER_ASSIGNMENTS) {
    const action = encoder[coordinate];
    if (action?.UUID !== ENCODER_UUID || action?.Settings?.role !== role) {
      throw new Error(`Invalid encoder assignment at ${coordinate}.`);
    }
    validateActionPluginVersion(action, ENCODER_UUID, "encoder", coordinate);
  }
}

function validateActionPluginVersion(action, expectedUuid, kind, coordinate) {
  if (action?.Plugin?.UUID !== expectedUuid) {
    throw new Error(`Invalid ${kind} plugin UUID at ${coordinate}.`);
  }
  if (action?.Plugin?.Version !== PLUGIN_VERSION) {
    throw new Error(
      `Invalid ${kind} plugin version at ${coordinate}: expected ${PLUGIN_VERSION}, got ${String(action?.Plugin?.Version)}.`
    );
  }
}

function validateSource() {
  const rootManifest = JSON.parse(readFileSync(join(SOURCE_ROOT, "manifest.json"), "utf8"));
  const pageManifest = JSON.parse(readFileSync(join(SOURCE_PAGE, "manifest.json"), "utf8"));
  validateManifests(rootManifest, pageManifest);
}

function validateArchive() {
  const entries = run("/usr/bin/unzip", ["-Z1", OUTPUT_FILE]).trim().split("\n").filter(Boolean);
  const expectedEntries = [
    `${PROFILE_ROOT}/`,
    `${PROFILE_ROOT}/manifest.json`,
    `${PROFILE_ROOT}/Profiles/`,
    `${PROFILE_ROOT}/Profiles/${PAGE_ID}/`,
    `${PROFILE_ROOT}/Profiles/${PAGE_ID}/manifest.json`
  ];
  for (const entry of expectedEntries) {
    if (!entries.includes(entry)) throw new Error(`Profile archive is missing ${entry}.`);
  }

  const rootManifest = JSON.parse(run("/usr/bin/unzip", ["-p", OUTPUT_FILE, `${PROFILE_ROOT}/manifest.json`]));
  const pageManifest = JSON.parse(run("/usr/bin/unzip", ["-p", OUTPUT_FILE, `${PROFILE_ROOT}/Profiles/${PAGE_ID}/manifest.json`]));
  validateManifests(rootManifest, pageManifest);
}

function generate() {
  if (existsSync(OUTPUT_FILE)) {
    if (!force) throw new Error(`${OUTPUT_FILE} already exists. Use --check to validate it or --force to regenerate it.`);
    rmSync(OUTPUT_FILE);
  }

  writeJson(join(SOURCE_ROOT, "manifest.json"), expectedRootManifest());
  writeJson(join(SOURCE_PAGE, "manifest.json"), expectedPageManifest());
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  run("/usr/bin/zip", ["-X", "-q", "-r", OUTPUT_FILE, PROFILE_ROOT], { cwd: SOURCE_CONTAINER });
}

function main() {
  if (!checkOnly) generate();
  validateSource();
  validateArchive();

  console.log(JSON.stringify({
    profile: OUTPUT_FILE,
    format: "3.0",
    deviceModel: "20GBD9901",
    keys: KEY_ASSIGNMENTS.length,
    encoders: ENCODER_ASSIGNMENTS.length,
    assignments: {
      keys: Object.fromEntries(KEY_ASSIGNMENTS.map(([coordinate, role]) => [coordinate, role])),
      encoders: Object.fromEntries(ENCODER_ASSIGNMENTS.map(([coordinate, role]) => [coordinate, role]))
    }
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) main();
