// The library panel's order (src/lib/libraryOrder.ts): pinned rows lead in the order they were
// dragged into, the rest by when they last played; which album, playlist or Liked Songs a queue
// plays; and the played times started from the listening history.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/libraryOrder.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { orderRows, movePinned, collectionOf } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const row = (id) => ({ id });
const ids = (rows) => rows.map((r) => r.id);

test("pinned rows lead as placed, the not yet placed after them; the rest by when they last played", () => {
  const rows = ["artist", "mix", "road", "folder", "albumA", "albumB", "liked"].map(row);
  const pinned = new Set(["liked", "road", "albumB"]);
  const played = { albumA: 300, folder: 200, mix: 100 };
  const ordered = orderRows(rows, { isPinned: (r) => pinned.has(r.id), pinOrder: ["albumB", "liked"], playedAt: (r) => played[r.id] ?? 0 });
  assert.deepEqual(ids(ordered), ["albumB", "liked", "road", "albumA", "folder", "mix", "artist"]);
  // Without the played times the rest keeps its own order.
  assert.deepEqual(ids(orderRows(rows, { isPinned: (r) => pinned.has(r.id), pinOrder: [] })), ["road", "albumB", "liked", "artist", "mix", "folder", "albumA"]);
});

test("a pinned row dragged onto another lands above it, or below", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(movePinned(order, "d", "a", false), ["d", "a", "b", "c"]);
  assert.deepEqual(movePinned(order, "a", "c", true), ["b", "c", "a", "d"]);
  assert.deepEqual(movePinned(order, "b", "c", true), ["a", "c", "b", "d"], "two neighbours swap places");
  assert.deepEqual(movePinned(order, "b", "b", true), order);
  assert.deepEqual(movePinned(order, "x", "a", false), order, "not pinned");
});

/* The shelves of a small library: album X has four songs, album S one (a single). */
const song = (id, album) => ({ id, title: id, artist: "A", duration: 200, thumb: "", albumId: album ? `lib:album:${album}` : undefined });
const library = {
  x1: song("x1", "x"),
  x2: song("x2", "x"),
  x3: song("x3", "x"),
  x4: song("x4", "x"),
  s1: song("s1", "s"),
  y1: song("y1", "y"),
  z1: song("z1", "z"),
};
const albumSizes = { "lib:album:x": 4, "lib:album:s": 1, "lib:album:y": 6, "lib:album:z": 9 };
const shelves = (collections) => ({
  keyOf: (t) => t.id,
  albumOf: (t) => t.albumId ?? null,
  albumSize: (a) => albumSizes[a] ?? 0,
  collections: collections.map(([id, list]) => ({ id, keys: new Set(list) })),
});
const L = (...names) => names.map((n) => library[n]);

test("a queue plays the album it covers at least half of; one song of it plays none", () => {
  const s = shelves([]);
  assert.equal(collectionOf(L("x1", "x2", "x3", "x4"), s), "lib:album:x");
  assert.equal(collectionOf(L("x3", "x1"), s), "lib:album:x", "half of it, shuffled");
  assert.equal(collectionOf(L("x2"), s), null, "one song from a search");
  assert.equal(collectionOf(L("s1"), s), "lib:album:s", "a single by itself");
  assert.equal(collectionOf([], s), null);
});

test("a queue plays the playlist or Liked Songs it covers best; a mix of elsewhere plays none", () => {
  const s = shelves([
    ["road", ["x1", "y1", "z1"]],
    ["everything", ["x1", "x2", "x3", "x4", "s1", "y1"]],
    ["__liked__", ["x1", "x2", "x3", "s1"]],
  ]);
  assert.equal(collectionOf(L("y1", "x1", "z1"), s), "road");
  assert.equal(collectionOf(L("x1", "x2", "s1", "x3"), s), "__liked__", "all of Liked Songs, though a bigger playlist holds them too");
  assert.equal(collectionOf(L("x1", "z1"), shelves([["big", ["x1", "x2", "x3", "x4", "s1", "z1"]]])), null, "a third of a playlist");
  assert.equal(collectionOf(L("y1", "s1"), s), null);
});

// Played times are no longer guessed from the history (the user's wish, 2026-11-22): it knows songs, not what
// they were played from. Only real plays count (lib/recentlyPlayed.ts).

/* ------------------------------------------------------------- artists, for Home's tiles (2026-11-22) */

test("where the shelves know artists, an artist's songs from two albums play the artist; an album or a playlist still comes first", () => {
  const withArtists = (collections) => ({ ...shelves(collections), artistOf: (t) => `lib:artist:${t.artist}` });
  assert.equal(collectionOf(L("x1", "y1"), withArtists([])), "lib:artist:A", "two albums of theirs");
  assert.equal(collectionOf(L("x1", "x2"), withArtists([])), "lib:album:x", "half of one album is the album");
  assert.equal(collectionOf(L("x1", "y1"), withArtists([["mine", ["x1", "y1"]]])), "mine", "a playlist of theirs is the playlist");
  assert.equal(collectionOf(L("x2"), withArtists([])), null, "one song says nothing");
  assert.equal(collectionOf(L("x1", "y1"), shelves([])), null, "without artists, as before");
});
