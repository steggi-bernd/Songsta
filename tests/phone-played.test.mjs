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
  "stores/settings": `export const useSettings = { getState: () => ({ recordListening: globalThis.__recordListening !== false }) };`,
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

test("with Keep my plays off nothing becomes recent; back on, it counts again", () => {
  usePlayer.setState({ playWhenReady: false, source: null });
  const before = { ...usePlayed.getState().at };
  globalThis.__recordListening = false;
  try {
    play([b1, c1], 0, "playlist:R");
    assert.deepEqual(usePlayed.getState().at, before);
  } finally {
    globalThis.__recordListening = undefined;
  }
  usePlayer.setState({ playWhenReady: false });
  play([b1, c1], 1, "playlist:R");
  assert.ok(usePlayed.getState().at["playlist:R"] > 0);
  usePlayer.setState({ playWhenReady: false, source: null });
});

test("another device's music shown here is that device's to count", () => {
  usePlayer.setState({ playWhenReady: false });
  const before = { ...usePlayed.getState().at };
  usePlayer.setState({ queue: [b1], index: 0, source: "artist:other", playWhenReady: true, remote: { id: "pc" } });
  assert.deepEqual(usePlayed.getState().at, before);
  usePlayer.setState({ remote: null, playWhenReady: false, source: null });
});

test("past plays aren't turned into guessed played times: a library with songs played before adds nothing", async () => {
  // The songs' last plays as the server keeps them say nothing about what they were played from (the user's wish, 2026-11-22).
  const counts = { b1: { lastAt: 500 }, c1: { lastAt: 450 }, a2: { lastAt: 400 }, a1: { lastAt: 300 } };
  usePlaylists.setState({ playlists: [{ id: "P", name: "Mix tape", tracks: [a1, b1] }, { id: "Q", name: "Three", tracks: [b1, a2, c1] }] });
  usePlayed.setState({ at: {} });
  useLibrary.setState({ loaded: true, data: { tracks: [a1, a2, b1, c1], counts }, albums: [{ key: "A", tracks: [a1, a2] }, { key: "B", tracks: [b1, song("b2", "Other")] }, { key: "C", tracks: [c1, song("c2", "Third")] }] });
  await wait(5);
  assert.deepEqual(usePlayed.getState().at, {});
});

/* ------------------------------------------------------------- Home's tiles count from when Home started counting (2026-11-22) */

test("Home counts what's played from since it started counting: times from before don't show, Liked Songs counts, the latest first", async () => {
  // playedSince on its own, built with the same stand-ins.
  const own = await build({
    stdin: { contents: `export { playedSince } from "./played";`, resolveDir: stores, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [
      {
        name: "stubs",
        setup(b) {
          b.onLoad({ filter: /\.ts$/ }, (args) => {
            const p = args.path.split("\\").join("/");
            for (const [name, contents] of Object.entries(stubs)) if (p.endsWith(`/mobile/src/${name}.ts`)) return { contents, resolveDir: stores, loader: "ts" };
            return undefined;
          });
        },
      },
    ],
  });
  const { playedSince } = await import(`data:text/javascript;base64,${Buffer.from(own.outputFiles[0].text).toString("base64")}`);
  const since = usePlayed.getState().homeSince;
  assert.equal(typeof since, "number", "set once the times were read");
  // Times kept from before (the guessed ones of earlier versions among them) don't show.
  usePlayed.setState({ at: { "album:A": since - 60_000, "playlist:P": since - 1 } });
  assert.deepEqual(playedSince(usePlayed.getState().at, since), [], "so Home shows none of it");
  // Played from Liked Songs, then from an album: both count, the latest first.
  usePlayer.setState({ playWhenReady: false });
  play([a1, b1], 0, "liked");
  await wait(5);
  usePlayer.setState({ playWhenReady: false });
  play([a1, a2], 0, "album:A");
  assert.deepEqual(playedSince(usePlayed.getState().at, since), ["album:A", "liked"]);
  usePlayer.setState({ playWhenReady: false, source: null });
});
