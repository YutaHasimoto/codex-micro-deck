import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { TRAILING_APPLY_DELAY_MS, TrailingApplyScheduler } from "../src/core/trailing-apply.ts";

test("the default trailing apply delay is the shared 80ms setting", () => {
  assert.equal(TRAILING_APPLY_DELAY_MS, 80);
});

test("trailing apply runs only the last rotation", async () => {
  const scheduler = new TrailingApplyScheduler<"approval">(5);
  const calls: string[] = [];
  scheduler.schedule("dial-1", "approval", async () => { calls.push("old"); return true; });
  scheduler.schedule("dial-1", "approval", async () => { calls.push("new"); return true; });
  await delay(25);
  assert.deepEqual(calls, ["new"]);
});

test("tap, hold, or disappear can cancel a trailing apply before it starts", async () => {
  const scheduler = new TrailingApplyScheduler<"approval">(10);
  let calls = 0;
  for (const key of ["tap", "hold", "disappear"]) {
    scheduler.schedule(key, "approval", async () => { calls += 1; return true; });
    scheduler.cancel(key);
  }
  await delay(25);
  assert.equal(calls, 0);
});

test("physical press waits for an in-flight auto apply and can avoid a duplicate write", async () => {
  const scheduler = new TrailingApplyScheduler<"reasoning">(0);
  let release: ((value: boolean) => void) | undefined;
  scheduler.schedule("dial-3", "reasoning", () => new Promise<boolean>((resolve) => { release = resolve; }));
  await delay(5);
  const settledPromise = scheduler.cancelAndWait("dial-3");
  release?.(true);
  assert.deepEqual(await settledPromise, { tag: "reasoning", succeeded: true });
});

test("a physical press immediately after rotation cancels the pending auto apply", async () => {
  const scheduler = new TrailingApplyScheduler<"model">(10);
  let autoApplies = 0;
  let physicalApplies = 0;
  scheduler.schedule("dial-1", "model", async () => { autoApplies += 1; return true; });

  assert.equal(await scheduler.cancelAndWait("dial-1"), undefined);
  physicalApplies += 1;
  await delay(25);

  assert.equal(physicalApplies, 1);
  assert.equal(autoApplies, 0);
});

test("starting dictation cancels every dial timer and waits for an in-flight apply", async () => {
  const scheduler = new TrailingApplyScheduler<"model" | "reasoning" | "speed">(5);
  const calls: string[] = [];
  let finishRunning: ((value: boolean) => void) | undefined;
  scheduler.schedule("model", "model", () => new Promise<boolean>((resolve) => {
    calls.push("model-started");
    finishRunning = resolve;
  }));
  await delay(10);
  scheduler.schedule("reasoning", "reasoning", async () => {
    calls.push("reasoning-ran");
    return true;
  });
  scheduler.schedule("speed", "speed", async () => {
    calls.push("speed-ran");
    return true;
  });

  const cancelled = scheduler.cancelAllAndWait().then(() => calls.push("cancelled"));
  await Promise.resolve();
  assert.deepEqual(calls, ["model-started"]);
  finishRunning?.(true);
  await cancelled;
  await delay(10);
  assert.deepEqual(calls, ["model-started", "cancelled"]);
});
