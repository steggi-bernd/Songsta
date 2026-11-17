// The library's own mixes (src/lib/mixes.ts): On Repeat stays a ranking (your most played first) when
// the others flow by sound; a genre's mix holds the songs its genre page shows (the albums' genres, not
// only the files' tags); decades group as they should.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({ stdin: { contents: `export * from "./mixes";`, resolveDir: lib, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { allMixes, mixById, genreMixes, decadeMixes } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const song = (i, extra = {}) => ({ id: `s${i}`, title: `Song ${i}`, artist: `Artist ${i % 5}`, album: `Album ${i % 4}`, duration: 200, thumb: "", genre: "Pop", year: 1990 + (i % 3) * 10, ...extra });
const tracks = Array.from({ length: 30 }, (_, i) => song(i));
const counts = Object.fromEntries(tracks.slice(0, 12).map((t, i) => [t.id, { plays: 20 - i, lastAt: 1 }]));
const facts = (i) => ({ bpm: 90 + ((i * 37) % 60), key: i % 12, minor: i % 2 === 0, energy: ((i * 53) % 100) / 100, loudness: -12, introSilence: 0, outroSilence: 0, headDb: -12, tailDb: -12 });
const sound = (t) => facts(Number(t.id.slice(1)));

test("On Repeat stays your most played first, even when the other mixes flow by sound", () => {
  const mixes = allMixes(tracks, counts, { sound });
  const onRepeat = mixes.find((m) => m.id === "onrepeat");
  assert.deepEqual(onRepeat.tracks.map((t) => t.id), tracks.slice(0, 12).map((t) => t.id), "ranked by plays");
  assert.deepEqual(mixById("onrepeat", tracks, counts, { sound }).tracks.map((t) => t.id), tracks.slice(0, 12).map((t) => t.id));
  // Rediscover does flow: the same songs, another order than drawn.
  const rediscover = mixes.find((m) => m.id === "rediscover");
  assert.equal(rediscover.tracks.length, 18);
});

test("a genre's mix holds its genre page's songs: the albums' genres where they're known", () => {
  const albumGenre = (t) => (t.album === "Album 1" ? ["Shoegaze"] : ["Pop"]);
  const byTags = genreMixes(tracks, 8).map((m) => m.id);
  assert.deepEqual(byTags, ["genre:pop"]);
  const byAlbums = genreMixes(tracks, 8, albumGenre);
  assert.deepEqual(byAlbums.map((m) => m.id).sort(), ["genre:pop", "genre:shoegaze"]);
  assert.ok(byAlbums.find((m) => m.id === "genre:shoegaze").tracks.every((t) => t.album === "Album 1"));
  assert.ok(mixById("genre:shoegaze", tracks, counts, { genres: albumGenre }), "the mix page finds it too");
  assert.equal(mixById("genre:shoegaze", tracks, counts), null, "and without the albums' genres there's no such mix");
});

test("decades group their songs", () => {
  const decades = decadeMixes(tracks);
  assert.deepEqual(decades.map((m) => m.id), ["decade:2010s", "decade:2000s", "decade:1990s"]);
  assert.equal(decades.reduce((n, m) => n + m.tracks.length, 0), 30);
});
