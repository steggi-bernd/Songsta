// The phone's "Recently played" in Your Library (mobile/src/stores/played.ts): what was started as a
// whole counts, not where a song comes from. A song from a playlist makes the playlist recent, not its
// album or its artist; what's added after it doesn't count; the start comes once from past plays.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const stores = fileURLToPath(new URL("../mobile/src/stores/", import.meta.url));
const libraryOrder = fileURLToPath(new URL("../src/lib/libraryOrder.ts", import.meta.url)).replace(/\\/g, "/");
const stubs = {
  "stores/player": `import { create } from "zustand"; export const usePlayer = create(() => ({ queue: [], index: 0, playWhenReady: false, remote: null, source: null }));`,
  "stores/library": `import { create } from "zustand"; export const useLibrary = create(() => ({ loaded: false, data: { tracks: [], counts: {} }, albums: [] }));`,
  "stores/playlists": `import { create } from "zustand"; export const usePlaylists = create(() => ({ playlists: [], restore: () => Promise.resolve() })); export const playlistTracks = (p) => p.tracks;`,
  storage: `export const readJson = async () => null; export const writeJson = (name, value) => { (globalThis.__saved ??= []).push([name, value]); };`,
  shared: `export { seedPlayed } from "${libraryOrder}";`,
};
const out = await build({
  stdin: { contents: `export { usePlayed, watchPlayed } from "./played"; export { usePlayer } from "./player"; export { useLibrary } from "./library"; export { usePlaylists } from "./playlists";`, resolveDir: stores, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        for (const [name, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`[\\\\/]mobile[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`);
          b.onLoad({ filter }, () => ({ contents, resolveDir: stores, loader: "ts" }));
        }
      },
    },
  ],
});
const { usePlayed, watchPlayed, usePlayer, useLibrary, usePlaylists } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const song = (id, artist = "Band") => ({ id, title: id.toUpperCase(), artist, duration: 200 });
const a1 = song("a1");
const a2 = song("a2");
const b1 = song("b1", "Other");
const c1 = song("c1", "Third");
const x9 = song("x9", "Somebody");
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const play = (queue, index, source) => usePlayer.setState({ queue, index, source, playWhenReady: true, remote: null });

usePlaylists.setState({ playlists: [{ id: "P", name: "Mix tape", tracks: [a1, b1] }] });
watchPlayed();
await wait(20);

test("a song from a playlist makes the playlist recent, not its album or its artist", async () => {
  usePlayer.setState({ playWhenReady: false });
  play([a1, b1], 0, "playlist:P");
  const at = usePlayed.getState().at;
  assert.ok(at["playlist:P"] > 0, "the playlist");
  assert.equal(at["album:A"], undefined, "not the album");
  assert.equal(at["artist:band"], undefined, "not the artist");
});

test("the album's own page counts for the album; songs added after it don't, nor what comes by itself", async () => {
  usePlayer.setState({ playWhenReady: false });
  play([a1, a2], 0, "album:A");
  const first = usePlayed.getState().at["album:A"];
  assert.ok(first > 0);
  await wait(15);
  usePlayer.setState({ index: 1 });
  const second = usePlayed.getState().at["album:A"];
  assert.ok(second > first, "the next song of it counts again");
  await wait(15);
  usePlayer.setState({ queue: [a1, a2, x9], index: 2 });
  assert.equal(usePlayed.getState().at["album:A"], second, "a song added to the queue isn't the album");
});

test("songs from anywhere else, a search say, count for nothing", () => {
  usePlayer.setState({ playWhenReady: false, source: null });
  const before = { ...usePlayed.getState().at };
  play([x9, c1], 0, null);
  assert.deepEqual(usePlayed.getState().at, before);
});

test("another device's music shown here is that device's to count", () => {
  usePlayer.setState({ playWhenReady: false });
  const before = { ...usePlayed.getState().at };
  usePlayer.setState({ queue: [b1], index: 0, source: "artist:other", playWhenReady: true, remote: { id: "pc" } });
  assert.deepEqual(usePlayed.getState().at, before);
  usePlayer.setState({ remote: null, playWhenReady: false, source: null });
});

test("the start comes once from past plays: two of an album in a row for the album, three of a playlist for it, never an artist", async () => {
  // Newest first: three songs of playlist Q (not all one album), the last two of them album A's, in a row.
  const counts = { b1: { lastAt: 500 }, c1: { lastAt: 450 }, a2: { lastAt: 400 }, a1: { lastAt: 300 } };
  usePlaylists.setState({ playlists: [{ id: "P", name: "Mix tape", tracks: [a1, b1] }, { id: "Q", name: "Three", tracks: [b1, a2, c1] }] });
  usePlayed.setState({ at: {}, seeded: false });
  useLibrary.setState({ loaded: true, data: { tracks: [a1, a2, b1, c1], counts }, albums: [{ key: "A", tracks: [a1, a2] }, { key: "B", tracks: [b1, song("b2", "Other")] }, { key: "C", tracks: [c1, song("c2", "Third")] }] });
  const at = usePlayed.getState().at;
  assert.ok(usePlayed.getState().seeded);
  assert.ok(at["playlist:Q"] > 0, "three of Q in a row");
  assert.ok(at["album:A"] > 0, "two of A in a row");
  assert.equal(at["album:B"], undefined, "one song of an album among others says nothing about it (a single by itself would count, as on the computer)");
  assert.ok(!Object.keys(at).some((k) => k.startsWith("artist:")), "an artist only counts from its own page");
  // Seeded once: later changes of the library don't start it over.
  usePlayed.setState({ at: { "playlist:Q": 1 } });
  useLibrary.setState({ data: { tracks: [a1, a2, b1, c1], counts: { ...counts, x: { lastAt: 900 } } } });
  assert.deepEqual(usePlayed.getState().at, { "playlist:Q": 1 });
});
