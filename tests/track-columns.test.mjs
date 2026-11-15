// The song lists' columns and orders (src/lib/trackColumns.ts): the order the columns stand in
// and how they move, what a click on a column's name does, and the order it puts the songs in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/trackColumns.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  write: false,
});
const { orderOf, moved, readColumns, nextListSort, readListSort, sortTracks, addedForOrder, matchesSearch, formatRank, releasedValue } = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

const song = (title, rest = {}) => ({ id: `t:${title}`, title, artist: "", album: "", duration: 0, thumb: "", ...rest });

test("the columns stand as they come, the time last, until one is moved", () => {
  const plain = { shown: ["album", "added", "time"], widths: {} };
  assert.deepEqual(orderOf(plain), ["album", "added", "released", "genre", "format", "plays", "time"]);
  const pulled = moved(plain, "added", "album");
  assert.deepEqual(orderOf(pulled), ["added", "album", "released", "genre", "format", "plays", "time"]);
  // To the end: in front of nothing, and the time stays behind it.
  const toEnd = moved(plain, "album", null);
  assert.equal(orderOf(toEnd).at(-2), "album");
  assert.equal(orderOf(toEnd).at(-1), "time");
  // The time itself can't be moved.
  assert.equal(moved(plain, "time", "album"), plain);
});

test("a saved order that misses a column puts it where it belongs in a row", () => {
  // Saved before the genre column existed, say: genre goes after released, as in a row.
  const choice = readColumns({ shown: ["album"], widths: {}, order: ["plays", "album", "added", "released", "format", "time"] });
  const order = orderOf(choice);
  assert.equal(order[order.indexOf("released") + 1], "genre");
  // Junk in a saved order is dropped.
  assert.deepEqual(readColumns({ shown: ["album"], widths: {}, order: ["x", "album"] }).order?.includes("x"), false);
});

test("a click on a name: that order, the other way round, then the list's own again", () => {
  const first = nextListSort(null, "added");
  assert.deepEqual(first, { key: "added", desc: true });
  const second = nextListSort(first, "added");
  assert.deepEqual(second, { key: "added", desc: false });
  assert.equal(nextListSort(second, "added"), null);
  // Another column starts fresh, names from A on.
  assert.deepEqual(nextListSort(first, "title"), { key: "title", desc: false });
  assert.equal(readListSort({ key: "nope", desc: true }), null);
  assert.deepEqual(readListSort({ key: "time", desc: false }), { key: "time", desc: false });
});

test("songs order by a column's words and numbers, those without one at the end", () => {
  const a = song("Äpfel", { artist: "Zoe" });
  const b = song("boats", { artist: "Ann" });
  const c = song("Castle", { artist: "" });
  const byTitle = sortTracks([c, a, b], { key: "title", desc: false }, () => 0, () => 0);
  assert.deepEqual(byTitle.map((t) => t.title), ["Äpfel", "boats", "Castle"]);
  const byArtist = sortTracks([a, b, c], { key: "artist", desc: false }, () => 0, () => 0);
  // c has no artist: it goes last, whichever way round.
  assert.deepEqual(byArtist.map((t) => t.title), ["boats", "Äpfel", "Castle"]);
  const byArtistDesc = sortTracks([a, b, c], { key: "artist", desc: true }, () => 0, () => 0);
  assert.deepEqual(byArtistDesc.map((t) => t.title), ["Äpfel", "boats", "Castle"]);
  const byTime = sortTracks([song("x", { duration: 300 }), song("y", { duration: 100 })], { key: "time", desc: false }, () => 0, () => 0);
  assert.deepEqual(byTime.map((t) => t.title), ["y", "x"]);
});

test("one album's songs keep their disc and track order under an album or artist order", () => {
  const one = song("One", { album: "A", artist: "Ann", discNo: 1, trackNo: 2 });
  const two = song("Two", { album: "A", artist: "Ann", discNo: 1, trackNo: 1 });
  const three = song("Three", { album: "B", artist: "Ann", trackNo: 1 });
  const sorted = sortTracks([one, three, two], { key: "artist", desc: false }, () => 0, () => 0);
  assert.deepEqual(sorted.map((t) => t.title), ["Two", "One", "Three"]);
});

test("the added order gives undated songs the place their list put them in", () => {
  // Liked Songs, newest first: the undated song between two dated ones counts as between them.
  const dates = [3000, 0, 1000];
  const filled = addedForOrder(dates, true);
  assert.equal(filled[0], 3000);
  assert.ok(filled[1] > 1000 && filled[1] < 3000);
  // A playlist, oldest first: an undated song joined around when the one before it did.
  const play = addedForOrder([1000, 0, 5000], false);
  assert.ok(play[1] > 1000 && play[1] < 5000);
});

test("quality and release days order as numbers", () => {
  assert.ok(formatRank({ codec: "FLAC", bitsPerSample: 24, sampleRate: 96000 }) > formatRank({ codec: "FLAC", bitsPerSample: 16, sampleRate: 44100 }));
  assert.ok(formatRank({ codec: "FLAC", bitsPerSample: 16, sampleRate: 44100 }) > formatRank({ codec: "MP3", bitrate: 320000 }));
  assert.ok(releasedValue({ date: "2021-05-04" }) > releasedValue({ originalYear: 2019 }));
  assert.equal(releasedValue({}), 0);
});

test("the search takes every word, wherever it stands, without accents", () => {
  const t = song("Café Lights", { artist: "Zoë Marlow", album: "Night Ferry" });
  assert.ok(matchesSearch(t, "cafe zoe"));
  assert.ok(matchesSearch(t, "ferry light"));
  assert.ok(!matchesSearch(t, "ferry nobody"));
  assert.ok(matchesSearch(t, "  "));
});
