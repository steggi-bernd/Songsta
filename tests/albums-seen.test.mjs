// When an album came into the library, as this computer saw it (stores/albumsSeen.ts): new albums
// get the moment they turned up, the first look's albums and big batches keep their own dates, and
// album pages sort by the later of the two (lib/catalogBuild.ts withSeenDates).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { albumOfTrack, buildAlbums, withSeenDates } from "../.test-build/catalogIndex.mjs";

const stores = fileURLToPath(new URL("../src/stores/", import.meta.url));
const out = await build({ stdin: { contents: `export * from "./albumsSeen";`, resolveDir: stores, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { seenAfter, MANY_AT_ONCE } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const NOW = Date.UTC(2026, 10, 15, 12);
const DAY = 86_400_000;

test("the first look is the baseline: those albums keep their own dates", () => {
  const first = seenAfter({ seen: {}, started: false }, ["band|one", "band|two"], NOW);
  assert.deepEqual(first, { seen: { "band|one": 0, "band|two": 0 }, started: true });
  assert.equal(seenAfter(first, ["band|one", "band|two"], NOW + DAY), null, "nothing new, nothing written");
  assert.equal(seenAfter({ seen: {}, started: false }, [], NOW), null, "an empty library doesn't start the count");
});

test("an album that turns up later gets that moment, and keeps it", () => {
  const base = { seen: { "band|one": 0 }, started: true };
  const next = seenAfter(base, ["band|one", "band|three"], NOW);
  assert.deepEqual(next.seen, { "band|one": 0, "band|three": NOW });
  assert.equal(seenAfter(next, ["band|three"], NOW + DAY), null, "an album gone for a while (a server away) isn't new when it's back");
});

test("many at once are a source joining: they keep their own dates", () => {
  const base = { seen: { "band|one": 0 }, started: true };
  const many = Array.from({ length: MANY_AT_ONCE + 1 }, (_, i) => `server|album ${i}`);
  const next = seenAfter(base, many, NOW);
  assert.ok(Object.values(next.seen).every((at) => at === 0));
  const few = seenAfter(next, ["band|new"], NOW);
  assert.equal(few.seen["band|new"], NOW);
});

test("odd keys can't touch the object itself", () => {
  const next = seenAfter({ seen: {}, started: true }, ["__proto__", "", "band|ok"], NOW);
  assert.deepEqual(Object.keys(next.seen), ["band|ok"]);
});

const song = (album, n, over = {}) => ({ id: `jf:${album}:${n}`, title: `${album} ${n}`, artist: "Band", album, trackNo: n, duration: 200, thumb: "x.jpg", source: "jellyfin", ...over });

test("an album page sorts by the later date: its songs' own, or when it turned up", () => {
  const old = Date.UTC(2019, 0, 1);
  const tracks = [song("Old Copy", 1, { addedAt: old }), song("Old Copy", 2, { addedAt: old }), song("Fresh", 1, { addedAt: NOW - 3 * DAY })];
  const albums = buildAlbums(tracks);
  const byKey = Object.fromEntries(albums.map((a) => [a.title, a]));
  const seen = { [albumOfTrack(tracks[0])]: NOW, [albumOfTrack(tracks[2])]: 0 };
  const dated = withSeenDates(albums, (t) => seen[albumOfTrack(t)] ?? 0);
  const datedByKey = Object.fromEntries(dated.map((a) => [a.title, a]));
  assert.equal(datedByKey["Old Copy"].addedAt, NOW, "copied files with a date from 2019, added today: today");
  assert.equal(datedByKey["Fresh"], byKey["Fresh"], "its own date stands, the same object");
  assert.equal(withSeenDates(albums, () => 0), albums, "nothing later: the same list");
});
