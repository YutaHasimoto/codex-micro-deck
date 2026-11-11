import assert from "node:assert/strict";
import test from "node:test";

import { OrderedRotations } from "../src/core/ordered-rotations.ts";

test("rapid detents keep arrival order while an earlier write is stalled", async () => {
  const rotations = new OrderedRotations();
  const seen: number[] = [];
  const committed: number[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const input = (detent: number) => rotations.enqueue("model", async (isLast) => {
    if (detent === 1) await firstGate;
    seen.push(detent);
    if (isLast()) committed.push(detent);
  });

  const first = input(1);
  const second = input(2);
  const third = input(3);
  assert.equal(rotations.hasPending("model"), true);
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(committed, [3]);
  assert.equal(rotations.hasPending("model"), false);
});

test("a failed detent does not block later rotations", async () => {
  const rotations = new OrderedRotations();
  const seen: string[] = [];
  const failed = rotations.enqueue("reasoning", async () => { throw new Error("temporary failure"); });
  const later = rotations.enqueue("reasoning", async () => { seen.push("later"); });
  await assert.rejects(failed, /temporary failure/);
  await later;
  assert.deepEqual(seen, ["later"]);
});
