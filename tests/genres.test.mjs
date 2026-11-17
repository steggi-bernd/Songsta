// Genres as people mean them (src/lib/genres.ts, buildGenres in src/lib/catalogBuild.ts): names with
// a slash stay whole, spellings of one genre are one, every genre has a family, and a song without
// a genre takes its album's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildGenres, genresOf } from "../.test-build/catalogIndex.mjs";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({ stdin: { contents: `export * from "./genres";`, resolveDir: lib, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { splitGenres, genreKey, genreName, familyOf, GENRE_FAMILIES } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

test("a tag splits into its genres, but a name with a slash in it stays whole", () => {
  assert.deepEqual(splitGenres("Rock; Indie"), ["Rock", "Indie"]);
  assert.deepEqual(splitGenres("Rock/Indie, Pop"), ["Rock", "Indie", "Pop"]);
  assert.deepEqual(splitGenres("Singer/Songwriter"), ["Singer/Songwriter"], "not Singer and Songwriter");
  assert.deepEqual(splitGenres("R&B/Soul; Hip-Hop/Rap"), ["R&B/Soul", "Hip-Hop/Rap"]);
  assert.deepEqual(splitGenres(""), []);
  assert.deepEqual(splitGenres(undefined), []);
});

test("spellings that mean the same are one genre", () => {
  assert.equal(genreKey("Hip Hop"), genreKey("Hip-Hop"));
  assert.equal(genreKey("HipHop"), genreKey("hip-hop"));
  assert.equal(genreKey("Drum n Bass"), genreKey("Drum & Bass"));
  assert.equal(genreKey("Drum and Bass"), genreKey("drum&bass"));
  assert.equal(genreName("hip hop"), "Hip-Hop");
  assert.equal(genreName("RnB"), "R&B");
  assert.equal(genreName("lofi"), "Lo-Fi");
  assert.equal(genreName("  Dream   Pop "), "Dream Pop", "an unknown genre keeps its own spelling, tidied");
  assert.deepEqual(splitGenres("Hip Hop; Hip-Hop; HipHop"), ["Hip-Hop"], "one genre once");
});

test("every genre belongs to one family", () => {
  assert.equal(familyOf("Synthwave"), "Electronic");
  assert.equal(familyOf("Synth-Pop"), "Electronic", "synth before pop");
  assert.equal(familyOf("Dream Pop"), "Pop");
  assert.equal(familyOf("Indie Folk"), "Folk & Country");
  assert.equal(familyOf("Singer/Songwriter"), "Folk & Country");
  assert.equal(familyOf("Post-Rock"), "Rock");
  assert.equal(familyOf("Hip-Hop/Rap"), "Hip-Hop");
  assert.equal(familyOf("Neo-Soul"), "R&B & Soul");
  assert.equal(familyOf("Baroque"), "Classical");
  assert.equal(familyOf("Film Score"), "Soundtrack");
  assert.equal(familyOf("Original Video Game Soundtrack"), "Soundtrack");
  assert.equal(familyOf("Melodic Death Metal"), "Metal");
  assert.equal(familyOf("Polka Fusion Experiments"), "Other");
  assert.ok(GENRE_FAMILIES.includes("Other"));
});

const song = (album, n, genre, over = {}) => ({ id: `jf:${album}:${n}`, title: `${album} ${n}`, artist: "Band", album, trackNo: n, duration: 200, thumb: "", source: "jellyfin", ...(genre !== undefined ? { genre } : {}), ...over });

test("the library's genres: spellings folded under the one most songs carry, a song without one takes its album's", () => {
  const tracks = [
    song("A", 1, "Hip-Hop"),
    song("A", 2, "Hip-Hop"),
    song("B", 1, "Hip Hop"),
    song("C", 1, "Singer/Songwriter"),
    song("C", 2, undefined),
    song("D", 1, "Rock/Indie"),
  ];
  const genres = buildGenres(tracks);
  const hip = genres.find((g) => g.name === "Hip-Hop");
  assert.equal(hip.tracks.length, 3);
  assert.equal(hip.key, "hip-hop", "linked under its usual spelling: a kept genre stays found");
  assert.equal(hip.albumCount, 2);
  const songwriter = genres.find((g) => g.name === "Singer/Songwriter");
  assert.equal(songwriter.tracks.length, 2, "the untagged song takes its album's genre");
  assert.ok(!genres.some((g) => g.name === "Singer" || g.name === "Songwriter"));
  assert.deepEqual(genres.filter((g) => g.name === "Rock" || g.name === "Indie").map((g) => g.name).sort(), ["Indie", "Rock"]);
  assert.deepEqual(genresOf(song("E", 1, "RnB; Lofi")), ["R&B", "Lo-Fi"]);
});
