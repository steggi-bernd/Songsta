// Playlists made smarter (src/lib/smartPlaylists.ts, src/lib/skipRules.ts): rules on how a song
// sounds (tempo, energy, key on the Camelot wheel) and its genre family, a flowing order, and skips
// that count early and fade.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({
  stdin: { contents: `export * from "./smartPlaylists"; export * from "./skipRules";`, resolveDir: lib, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { evaluateSmartPlaylist, FIELDS, skipWeight, isEarlySkip, readsPlays, randomKey, SMART_PRESETS } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const facts = (bpm, key, minor, energy) => ({ bpm, key, minor, energy, loudness: -14, introSilence: 0, outroSilence: 0, headDb: -20, tailDb: -20 });
const song = (id, genre, artist = "Band") => ({ id, title: id, artist, album: "LP", duration: 200, thumb: "", source: "local", genre });
const sounds = {
  run: facts(128, 0, false, 0.8), // C major, 8B
  calm: facts(72, 9, true, 0.2), // A minor, 8A
  mid: facts(118, 4, true, 0.55), // E minor, 9A
  far: facts(128, 6, false, 0.85), // F♯ major, 2B
};
const tracks = [song("run", "Synthwave"), song("calm", "Indie Folk"), song("mid", "Dream Pop"), song("far", "Techno"), song("unmeasured", "Pop")];
const sound = (t) => sounds[t.id];
const smart = (rules, extra = {}) => ({ id: "s", name: "s", rules, match: "all", sort: "title", limit: null, ...extra });
const ids = (list) => list.map((t) => t.id).sort();

test("tempo, energy, key and family as rules", () => {
  const run = (rules) => ids(evaluateSmartPlaylist(smart(rules), tracks, {}, new Set(), sound));
  assert.deepEqual(run([{ field: "bpm", op: "between", value: "120", value2: "140" }]), ["far", "run"]);
  assert.deepEqual(run([{ field: "bpm", op: "is", value: "117" }]), ["mid"], "a tempo is within two beats");
  assert.deepEqual(run([{ field: "energy", op: "lt", value: "30" }]), ["calm"]);
  assert.deepEqual(run([{ field: "camelot", op: "is", value: "8A" }]), ["calm"]);
  assert.deepEqual(run([{ field: "camelot", op: "near", value: "8A" }]), ["calm", "mid", "run"], "A minor's neighbours: E minor (9A) and C major (8B)");
  assert.deepEqual(run([{ field: "family", op: "is", value: "Electronic" }]), ["far", "run"]);
  assert.deepEqual(run([{ field: "family", op: "isNot", value: "Electronic" }]), ["calm", "mid", "unmeasured"]);
  assert.ok(FIELDS.camelot.choices.some((c) => c.value === "8A" && c.label.includes("A minor")));
  assert.equal(FIELDS.camelot.choices.length, 24);
});

test("a flowing order: measured songs flow, unmeasured ones behind", () => {
  const order = evaluateSmartPlaylist(smart([], { sort: "flow" }), tracks, {}, new Set(), sound).map((t) => t.id);
  assert.equal(order.length, 5);
  assert.equal(order[order.length - 1], "unmeasured");
  assert.ok(sounds[order[0]].energy <= 0.55, `a mix starts at the calmer end, not at its peak (began with ${order[0]})`);
  const limited = evaluateSmartPlaylist(smart([], { sort: "flow", limit: 2 }), tracks, {}, new Set(), sound);
  assert.equal(limited.length, 2);
});

test("a random order holds while the app runs: a play counted doesn't shuffle the list", () => {
  const many = Array.from({ length: 40 }, (_, i) => song(`s${i}`, "Pop", `Artist ${i % 7}`));
  const sp = smart([], { id: "sp-random", sort: "random" });
  const first = evaluateSmartPlaylist(sp, many, {}, new Set()).map((t) => t.id);
  const again = evaluateSmartPlaylist(sp, many, { s3: { plays: 1, lastAt: 1 } }, new Set()).map((t) => t.id);
  assert.deepEqual(again, first, "looked at again: the same order");
  assert.notDeepEqual(first, many.map((t) => t.id), "and it is shuffled");
  // One song gone (played, in "Never played"): the rest keep their order.
  const fewer = evaluateSmartPlaylist(sp, many.filter((t) => t.id !== first[5]), {}, new Set()).map((t) => t.id);
  assert.deepEqual(fewer, first.filter((id) => id !== first[5]));
  // Another smart playlist shuffles otherwise, and so does another start.
  const other = evaluateSmartPlaylist({ ...sp, id: "sp-other" }, many, {}, new Set()).map((t) => t.id);
  assert.notDeepEqual(other, first);
  assert.notEqual(randomKey("s1", "sp-random", 1), randomKey("s1", "sp-random", 2));
  // A limited flow takes the same pick each look.
  const flow = smart([], { id: "sp-flow", sort: "flow", limit: 10 });
  const pick = (list) => evaluateSmartPlaylist(flow, list, {}, new Set(), () => facts(120, 0, false, 0.5)).map((t) => t.id).sort();
  assert.deepEqual(pick(many), pick(many));
});

test("which smart playlists read play counts (and so change when a play counts)", () => {
  const byName = Object.fromEntries(SMART_PRESETS.map((p) => [p.name, readsPlays({ id: "x", name: p.name, rules: p.rules, match: "all", sort: p.sort, limit: p.limit })]));
  assert.deepEqual(byName, { "Hi-Res": false, "Recently added": false, "Never played": true, "Most played": true, "Not played in a while": true, Workout: false, "Wind down": false });
});

test("a skip is leaving within the first half minute, before the song's half; it fades by half in 90 days", () => {
  assert.equal(isEarlySkip(10_000, 200), true);
  assert.equal(isEarlySkip(45_000, 200), false, "past half a minute it was listened to");
  assert.equal(isEarlySkip(20_000, 30), false, "a 30 s song left after 20 s was mostly heard");
  const now = Date.UTC(2026, 10, 15);
  assert.equal(skipWeight({ n: 2, at: now }, now), 2);
  assert.ok(Math.abs(skipWeight({ n: 2, at: now - 90 * 86_400_000 }, now) - 1) < 1e-9);
  assert.equal(skipWeight(undefined, now), 0);
});
