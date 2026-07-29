import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "mic-level-meter.swift");
const output = join(root, "works.kawaii.codex-shortcuts-plugin.sdPlugin", "bin", "mic-level-meter");
const inputs = [source, fileURLToPath(import.meta.url)];
const fullXcodeDeveloperDirectory = "/Applications/Xcode.app/Contents/Developer";
const buildEnvironment = existsSync(fullXcodeDeveloperDirectory)
  ? { ...process.env, DEVELOPER_DIR: fullXcodeDeveloperDirectory }
  : process.env;

if (process.platform !== "darwin") {
  throw new Error("The microphone meter can only be built on macOS.");
}

function hasNoEmbeddedInfoPlist(path) {
  try {
    const loadCommands = execFileSync("/usr/bin/otool", ["-l", path], { encoding: "utf8" });
    return !loadCommands.includes("__info_plist");
  } catch {
    return false;
  }
}

const newestInput = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
if (existsSync(output)
  && statSync(output).mtimeMs >= newestInput
  && hasNoEmbeddedInfoPlist(output)) {
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });
const temporaryDirectory = mkdtempSync(join(tmpdir(), "codex-shortcuts-plugin-mic-"));
const moduleCache = join(temporaryDirectory, "module-cache");
mkdirSync(moduleCache, { recursive: true });
const compilerEnvironment = {
  ...buildEnvironment,
  CLANG_MODULE_CACHE_PATH: moduleCache,
  SWIFT_MODULE_CACHE_PATH: moduleCache
};

try {
  const sdk = execFileSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
    encoding: "utf8",
    env: compilerEnvironment
  }).trim();
  const binaries = [];

  for (const architecture of ["arm64", "x86_64"]) {
    const binary = join(temporaryDirectory, `mic-level-meter-${architecture}`);
    execFileSync("/usr/bin/xcrun", [
      "swiftc",
      source,
      "-O",
      "-target",
      `${architecture}-apple-macos13.0`,
      "-sdk",
      sdk,
      "-framework",
      "AVFoundation",
      "-o",
      binary
    ], { stdio: "inherit", env: compilerEnvironment });
    binaries.push(binary);
  }

  const universalBinary = join(temporaryDirectory, "mic-level-meter");
  execFileSync("/usr/bin/xcrun", ["lipo", "-create", ...binaries, "-output", universalBinary], {
    stdio: "inherit",
    env: compilerEnvironment
  });
  chmodSync(universalBinary, 0o755);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    universalBinary
  ], { stdio: "inherit" });
  renameSync(universalBinary, output);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
