import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  classifyMicrophoneMeterFailure,
  consumeMicrophoneLevelOutput,
  MICROPHONE_LEVEL_RETRY_MS,
  MicrophoneLevelMonitor,
  smoothMicrophoneLevel
} from "../src/system/microphone-level.ts";

test("microphone meter output accepts only bounded scalar levels across chunks", () => {
  const first = consumeMicrophoneLevelOutput("", "0.25\ninvalid\n1.");
  assert.deepEqual(first.levels, [0.25]);
  assert.equal(first.remainder, "1.");

  const second = consumeMicrophoneLevelOutput(first.remainder, "4\n-0.2\nInfinity\n");
  assert.deepEqual(second.levels, [1, 0]);
  assert.equal(second.remainder, "");
});

test("microphone level smoothing attacks quickly and releases gradually", () => {
  assert.equal(smoothMicrophoneLevel(0, 1), 0.72);
  assert.equal(smoothMicrophoneLevel(1, 0), 0.7);
  assert.equal(smoothMicrophoneLevel(Number.NaN, 2), 0.72);
});

test("microphone meter failures expose classifications without forwarding stderr", () => {
  assert.equal(
    classifyMicrophoneMeterFailure(2, "permission-denied\n/private/audio/path"),
    "microphone-permission-denied"
  );
  assert.equal(
    classifyMicrophoneMeterFailure(3, "no-input-device"),
    "microphone-input-unavailable"
  );
  assert.equal(
    classifyMicrophoneMeterFailure(4, "engine-start-failed"),
    "audio-engine-start-failed"
  );
  assert.equal(classifyMicrophoneMeterFailure(9, "unknown private detail"), "meter-exited: code=9");
});

test("permission denial warns once, suppresses retries for that voice session, and retries next session", () => {
  let now = 1_000;
  let spawnCount = 0;
  let permissionWarnings = 0;
  const logs: string[] = [];
  const children: FakeMeterChild[] = [];
  const monitor = new MicrophoneLevelMonitor({
    executable: "/test/mic-level-meter",
    now: () => now,
    logger: (message) => logs.push(message),
    onPermissionDenied: () => { permissionWarnings += 1; },
    spawnMeter() {
      spawnCount += 1;
      const child = fakeMeterChild();
      children.push(child);
      return child.process;
    }
  });

  monitor.start();
  denyMicrophonePermission(children[0]!);

  assert.equal(spawnCount, 1);
  assert.deepEqual(logs, ["[mic-meter] microphone-permission-denied"]);
  assert.equal(permissionWarnings, 1);

  now += MICROPHONE_LEVEL_RETRY_MS * 3;
  monitor.start();
  monitor.start();
  assert.equal(spawnCount, 1);
  assert.deepEqual(logs, ["[mic-meter] microphone-permission-denied"]);
  assert.equal(permissionWarnings, 1);

  monitor.stop();
  monitor.start();
  assert.equal(spawnCount, 2);
  denyMicrophonePermission(children[1]!);
  assert.deepEqual(logs, [
    "[mic-meter] microphone-permission-denied",
    "[mic-meter] microphone-permission-denied"
  ]);
  assert.equal(permissionWarnings, 2);
});

test("transient microphone meter failures still retry after the cooldown", () => {
  let now = 2_000;
  let spawnCount = 0;
  const children: FakeMeterChild[] = [];
  const monitor = new MicrophoneLevelMonitor({
    executable: "/test/mic-level-meter",
    now: () => now,
    spawnMeter() {
      spawnCount += 1;
      const child = fakeMeterChild();
      children.push(child);
      return child.process;
    }
  });

  monitor.start();
  children[0]!.stderr.write("engine-start-failed\n");
  children[0]!.process.emit("close", 4, null);
  monitor.start();
  assert.equal(spawnCount, 1);

  now += MICROPHONE_LEVEL_RETRY_MS;
  monitor.start();
  assert.equal(spawnCount, 2);
  monitor.stop();
});

type FakeMeterChild = {
  process: ChildProcess;
  stderr: PassThrough;
};

function fakeMeterChild(): FakeMeterChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = Object.assign(emitter, {
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill() { return true; }
  }) as unknown as ChildProcess;
  return { process, stderr };
}

function denyMicrophonePermission(child: FakeMeterChild): void {
  child.stderr.write("permission-denied\n/private/audio/path\n");
  child.process.emit("close", 2, null);
}
