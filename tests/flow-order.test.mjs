// Mixes that flow (src/lib/flowOrder.ts): next songs close on the Camelot wheel and in tempo, the
// energy rising to a peak and easing off, an artist not twice in a row; unmeasured songs behind.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({ stdin: { contents: `export * from "./flowOrder"; export { camelotOf, keyStep } from "./soundMatch";`, resolveDir: lib, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { flowOrder, apartByArtist, camelotOf, keyStep } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const facts = (bpm, key, minor, energy) => ({ bpm, key, minor, energy, loudness: -14, introSilence: 0, outroSilence: 0, headDb: -20, tailDb: -20 });
const song = (id, artist, f) => ({ item: id, artist, facts: f });

test("each next song is close on the wheel and in tempo", () => {
  // A minor at 100; the others scattered round the wheel and in tempo.
  const songs = [
    song("am-100", "A", facts(100, 9, true, 0.5)),
    song("bb-140", "B", facts(140, 10, false, 0.5)),
    song("em-102", "C", facts(102, 4, true, 0.5)),
    song("c-101", "D", facts(101, 0, false, 0.5)),
    song("f#-70", "E", facts(70, 6, false, 0.5)),
  ];
  const order = flowOrder(songs, { first: "am-100" });
  assert.equal(order[0], "am-100");
  assert.ok(["em-102", "c-101"].includes(order[1]), `a neighbour next, got ${order[1]}`);
  // Every step through the neighbours before the far ones.
  assert.deepEqual(order.slice(3).sort(), ["bb-140", "f#-70"]);
});

test("a mix's energy climbs to a peak about two thirds in and eases off", () => {
  const songs = Array.from({ length: 12 }, (_, i) => song(`s${i}`, `artist ${i}`, facts(120, 0, false, i / 11)));
  const order = flowOrder([...songs].reverse(), { arc: true });
  const energy = order.map((id) => songs.find((s) => s.item === id).facts.energy);
  const peakAt = energy.indexOf(Math.max(...energy));
  assert.ok(peakAt >= 6 && peakAt <= 10, `the peak about two thirds in, at ${peakAt}`);
  assert.ok(energy[0] < 0.5, "it starts calm");
  assert.ok(energy[energy.length - 1] < energy[peakAt], "and eases off at the end");
});

test("an artist doesn't come twice in a row while another can come between", () => {
  const songs = [
    song("a1", "Same", facts(100, 0, false, 0.5)),
    song("a2", "Same", facts(100, 0, false, 0.5)),
    song("a3", "Same", facts(100, 0, false, 0.5)),
    song("b1", "Other", facts(100, 0, false, 0.5)),
    song("c1", "Third", facts(100, 0, false, 0.5)),
  ];
  const order = flowOrder(songs, { first: "a1" });
  const artists = order.map((id) => songs.find((s) => s.item === id).artist);
  for (let i = 1; i < 4; i++) assert.notEqual(artists[i], artists[i - 1], `apart at ${i}: ${artists.join(", ")}`);
});

test("unmeasured songs come behind, apart by artist; a first song asked for comes first all the same", () => {
  const songs = [song("m1", "A", facts(100, 0, false, 0.5)), song("u1", "X", undefined), song("u2", "X", undefined), song("u3", "Y", undefined)];
  assert.deepEqual(flowOrder(songs), ["m1", "u1", "u3", "u2"]);
  assert.deepEqual(flowOrder(songs, { first: "u3" })[0], "u3");
  assert.deepEqual(apartByArtist([song("1", "A"), song("2", "A"), song("3", "B")]).map((s) => s.item), ["1", "3", "2"]);
  assert.deepEqual(flowOrder([]), []);
  assert.ok(keyStep(camelotOf(9, true), camelotOf(0, false)) === 1);
});
