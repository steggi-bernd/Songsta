// The Camelot wheel to touch (src/components/CamelotWheel.tsx, lib/soundMatch.ts keyOfCamelot) and keys
// set by hand (src/stores/keyEdits.ts withKeyEdits): every place on the wheel stands for one key and back;
// the wheel turns the shorter way round; a key set by hand counts and remembers what was measured.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const stubs = {
  "lib/persist": `export const storage = { getItem: () => null, setItem() {}, removeItem() {} };`,
  "stores/settings": `export const useSettings = (pick) => pick({ reduceAnimation: false });`,
};
const out = await build({
  stdin: { contents: `export * from "./lib/soundMatch"; export { withKeyEdits, useKeyEdits } from "./stores/keyEdits"; export { turnTo } from "./components/CamelotWheel";`, resolveDir: src, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "stubs",
      setup(b) {
        for (const [name, contents] of Object.entries(stubs)) {
          b.onLoad({ filter: new RegExp(`[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`) }, () => ({ contents, resolveDir: src, loader: "ts" }));
        }
      },
    },
  ],
});
const lib = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const { camelotOf, keyOfCamelot, camelotLabel, sameCamelot, withKeyEdits, useKeyEdits, turnTo } = lib;

test("every place on the wheel is one key, and every key one place", () => {
  const seen = new Set();
  for (let key = 0; key < 12; key++) {
    for (const minor of [false, true]) {
      const c = camelotOf(key, minor);
      assert.deepEqual(keyOfCamelot(c), { key, minor }, `${camelotLabel(c)} back to its key`);
      seen.add(camelotLabel(c));
    }
  }
  assert.equal(seen.size, 24);
  assert.deepEqual(keyOfCamelot({ n: 8, ring: "B" }), { key: 0, minor: false }, "8B is C major");
  assert.deepEqual(keyOfCamelot({ n: 8, ring: "A" }), { key: 9, minor: true }, "8A is A minor");
  assert.deepEqual(keyOfCamelot({ n: 9, ring: "A" }), { key: 4, minor: true }, "9A is E minor");
  assert.ok(sameCamelot({ n: 3, ring: "A" }, { n: 3, ring: "A" }) && !sameCamelot({ n: 3, ring: "A" }, { n: 3, ring: "B" }) && !sameCamelot(null, null));
});

test("the wheel turns the shorter way round", () => {
  assert.equal(turnTo(0, -30), -30);
  assert.equal(turnTo(0, -330), 30, "from 1 to 12: one step back, not eleven forward");
  assert.equal(turnTo(-300, -30), -390, "keeps turning on, never jumps back a whole round");
  assert.equal(turnTo(720, 0), 720);
});

test("a key set by hand counts everywhere and remembers what was measured; given back, the measurement counts again", () => {
  const facts = { a: { bpm: 120, key: 9, minor: true, energy: 0.5, loudness: -10 }, b: { bpm: 90, key: 0, minor: false, energy: 0.3, loudness: -12 } };
  assert.equal(withKeyEdits(facts, {}), facts, "nothing set: the same object");
  const edited = withKeyEdits(facts, { a: { key: 4, minor: true, at: 1 }, missing: { key: 1, minor: false, at: 1 } });
  assert.deepEqual([edited.a.key, edited.a.minor], [4, true]);
  assert.deepEqual(edited.a.measuredKey, { key: 9, minor: true });
  assert.equal(edited.b, facts.b);
  assert.equal(edited.missing, undefined, "a key set for a copy that isn't measured adds nothing");
  // The store: set for the song's copies, then given back.
  useKeyEdits.getState().setKey(["local:x", "jf:x"], { key: 7, minor: false });
  assert.deepEqual(Object.keys(useKeyEdits.getState().keys).sort(), ["jf:x", "local:x"]);
  useKeyEdits.getState().setKey(["local:x", "jf:x"], null);
  assert.deepEqual(useKeyEdits.getState().keys, {});
  useKeyEdits.getState().setKey(["local:y"], { key: 13, minor: false });
  assert.deepEqual(useKeyEdits.getState().keys, {}, "no such key");
});

test("songs to hear a key by: just that key, the most played first, each artist once before any comes twice", () => {
  const { songsInKey } = lib;
  const at = (c) => keyOfCamelot(c);
  const nineA = at({ n: 9, ring: "A" });
  const tracks = [
    { id: "a1", artist: "Vela Moss", sound: nineA, plays: 9 },
    { id: "a2", artist: "Vela Moss", sound: nineA, plays: 8 },
    { id: "b1", artist: "Juno Ferrar", sound: nineA, plays: 3 },
    { id: "c1", artist: "Mira Kestrel", sound: at({ n: 9, ring: "B" }), plays: 50 },
    { id: "d1", artist: "Halden Field", sound: at({ n: 10, ring: "A" }), plays: 40 },
    { id: "e1", artist: "Lumen Harbor", sound: undefined, plays: 99 },
    { id: "f1", artist: "Ines Calder", sound: nineA, plays: 1 },
  ];
  const ids = (list) => list.map((t) => t.id);
  const sound = (t) => t.sound;
  const plays = (t) => t.plays;
  assert.deepEqual(ids(songsInKey(tracks, sound, { n: 9, ring: "A" }, plays)), ["a1", "b1", "f1"], "another artist before Vela Moss's second; neighbours and unmeasured songs stay out");
  assert.deepEqual(ids(songsInKey(tracks, sound, { n: 9, ring: "A" }, plays, 4)), ["a1", "b1", "f1", "a2"], "then the second, when there's room");
  assert.deepEqual(ids(songsInKey(tracks, sound, { n: 9, ring: "A" }, plays, 3, (t) => t.id === "a1")), ["a2", "b1", "f1"], "the song itself left out");
  assert.deepEqual(ids(songsInKey(tracks, sound, { n: 4, ring: "B" }, plays)), [], "nothing in that key");
});

test("a slice of the wheel: no outline needed, a gap all round, corners rounded and never larger than the slice", async () => {
  const { build: bundle } = await import("esbuild");
  const out = await bundle({ stdin: { contents: `export { ringSlice } from "./lib/ringSlice";`, resolveDir: src, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
  const { ringSlice } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
  const d = ringSlice(180, 180, 65, 120, -Math.PI / 2 - Math.PI / 12, -Math.PI / 2 + Math.PI / 12, 7, 4.5);
  assert.match(d, /^M [\d.-]+ [\d.-]+ A /, "starts on the outer arc");
  assert.equal((d.match(/ A /g) || []).length, 2, "an outer and an inner arc");
  assert.equal((d.match(/ Q /g) || []).length, 4, "four rounded corners");
  assert.match(d, /Z$/);
  // Every point stays inside the ring, the gap's half kept from its edges.
  const nums = d.replace(/[MAQLZ]/g, " ").trim().split(/\s+/).map(Number);
  const points = [];
  const tokens = d.split(" ");
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "M" || tokens[i] === "L") points.push([+tokens[i + 1], +tokens[i + 2]]);
    if (tokens[i] === "Q") points.push([+tokens[i + 3], +tokens[i + 4]]);
    if (tokens[i] === "A") points.push([+tokens[i + 6], +tokens[i + 7]]);
  }
  assert.ok(nums.every(Number.isFinite));
  for (const [x, y] of points) {
    const r = Math.hypot(x - 180, y - 180);
    assert.ok(r >= 65 + 2.25 - 0.01 && r <= 120 - 2.25 + 0.01, `point at radius ${r.toFixed(2)}`);
  }
  // A sliver too thin for its corners still makes a closed shape.
  assert.match(ringSlice(0, 0, 10, 12, 0, 0.05, 8, 1), /Z$/);
});
