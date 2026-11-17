// Replay slide by slide (src/lib/slidePaging.ts): a mouse wheel's notch is a step of its own; a touchpad's
// stream makes one move per swipe, its glide after the fingers lift goes by, a pause or a fresh push
// starts the next swipe; landing on the history doesn't run on into it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({ stdin: { contents: `export { createSwipeGate, isNotched } from "./slidePaging";`, resolveDir: lib, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { createSwipeGate, isNotched } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

/** A swipe as a touchpad sends it: building up, then gliding out, an event every 16 ms. */
const swipe = (sign = 1, peak = 40, glide = 40) => {
  const up = [4, 10, 22, peak];
  const tail = Array.from({ length: glide }, (_, i) => Math.max(1, Math.round(peak * Math.pow(0.9, i + 1))));
  return [...up, ...tail].map((d) => d * sign);
};
const run = (gate, deltas, start, every = 16) => deltas.map((d, i) => gate.feed(d, start + i * every));

test("a notched wheel's turn and a touchpad's stream are told apart", () => {
  assert.equal(isNotched({ deltaX: 0, deltaY: 100, wheelDeltaY: -120 }), true);
  assert.equal(isNotched({ deltaX: 0, deltaY: 200, wheelDeltaY: -240 }), true, "two notches at once");
  assert.equal(isNotched({ deltaX: 0, deltaY: 3, wheelDeltaY: -4 }), false, "a touchpad's small step");
  assert.equal(isNotched({ deltaX: 0, deltaY: 3, wheelDeltaY: 0 }), false);
  assert.equal(isNotched({ deltaX: 0, deltaY: 3, deltaMode: 1 }), true, "lines, as Firefox counts a notch");
});

test("one swipe, however long it glides, is one move", () => {
  const gate = createSwipeGate();
  const steps = run(gate, swipe(1, 40, 60), 1000);
  assert.equal(steps.filter((s) => s === "move").length, 1);
  assert.equal(steps.at(-1), "tail");
});

test("two swipes with a pause between are two moves, either way", () => {
  const gate = createSwipeGate();
  const first = run(gate, swipe(1), 1000);
  const second = run(gate, swipe(1), 1000 + first.length * 16 + 250);
  const back = run(gate, swipe(-1), 1000 + (first.length + second.length) * 16 + 500);
  assert.equal([...first, ...second, ...back].filter((s) => s === "move").length, 3);
});

test("a fresh push while the last swipe still glides is the next move", () => {
  const gate = createSwipeGate();
  const glide = swipe(1, 40, 18);
  const steps = run(gate, [...glide, 30, 45, 50, 40, 30], 1000);
  assert.equal(steps.filter((s) => s === "move").length, 2);
});

test("a small nudge isn't a move", () => {
  const gate = createSwipeGate();
  assert.deepEqual(run(gate, [3, 5, 4, 2, 1], 1000), ["wait", "wait", "wait", "wait", "wait"]);
});

test("landing on the history by a swipe: its glide is swallowed there, the next swipe scrolls", () => {
  const gate = createSwipeGate();
  const deltas = swipe(1, 40, 40);
  // The move happens on the slides; the rest of the swipe arrives where the page scrolls freely.
  run(gate, deltas.slice(0, 5), 1000);
  const tail = deltas.slice(5).map((d, i) => gate.gliding(d, 1000 + (5 + i) * 16));
  assert.ok(tail.every(Boolean), "the glide goes by");
  assert.equal(gate.gliding(20, 1000 + deltas.length * 16 + 300), false, "after a pause it scrolls the history");
  assert.equal(gate.gliding(18, 1000 + deltas.length * 16 + 316), false, "and goes on scrolling");
});

test("a move made otherwise (a notch, the stop at the history's top): the rest of the stream is its tail", () => {
  const gate = createSwipeGate();
  gate.used(1000);
  assert.deepEqual(run(gate, [20, 18, 15], 1010), ["tail", "tail", "tail"]);
  assert.equal(gate.feed(25, 1500), "wait", "a pause, then a new swipe builds up");
  assert.equal(gate.feed(25, 1516), "move");
});
