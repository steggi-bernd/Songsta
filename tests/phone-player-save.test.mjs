// What the phone keeps of its queue across a start (mobile/src/stores/player.ts): the queue in a file of its
// own, written when it changes; where it stands in player.json, every few seconds while it plays. That
// file used to carry the whole queue each time. A queue kept the old way is still read.
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const stores = fileURLToPath(new URL("../mobile/src/stores/", import.meta.url));
const stubs = {
  "stores/connection": `export const useConnection = { getState: () => ({ reach: "online", metered: false, check: async () => "online" }), subscribe() {} };`,
  "stores/devices": `const known = { others: [] }; export const useDevices = { getState: () => known, setState(next) { Object.assign(known, next); } }; export const isAround = () => true;`,
  "stores/localMusic": `export const fileOfSong = () => null;`,
  "stores/downloads": `export const useDownloads = { getState: () => ({ kept: {}, covers: {} }), subscribe() {} }; export const downloadsLine = () => "";`,
  "stores/library": `export const useLibrary = { getState: () => ({ muted: new Set(), byId: globalThis.__byId ?? new Map(), loaded: true, data: { tracks: [], counts: {} }, notePlayed() {} }), subscribe() {} };`,
  "stores/playlists": `export const findSong = (wire) => ({ thumb: "", ...wire });`,
  "stores/session": `export const useSession = { getState: () => ({ session: null }) }; export const here = (x) => x;`,
  "stores/settings": `export const useSettings = { getState: () => ({ autoplay: false, dontRepeat: false, speed: 1, skipEndsRepeatOne: true }) };`,
  "stores/popups": `export const toast = () => undefined;`,
  homeLink: `export const songFromComputer = () => null; export const handOutToComputer = async () => undefined; export const toHandOut = () => false; export const handedOutAddress = () => undefined;`,
  storage: `export const readJson = async (name) => globalThis.__files?.[name] ?? null;
    export const writeJson = (name, value) => { (globalThis.__writes ??= []).push([name, value]); };
    export const removeJson = () => undefined;`,
  jellyfin: `export const streamUrl = () => "http://test/song";`,
  addresses: `export const withoutServer = (x) => x;`,
  quality: `export const ORIGINAL = { kind: "original" }; export const chooseStream = () => ORIGINAL; export const levelGain = () => 0; export const sameChoice = () => true; export const stepDown = () => null;`,
};
const out = await build({
  stdin: { contents: `export { usePlayer, playbackNote, watchPlayer } from "./player";`, resolveDir: stores, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /^react-native$/ }, () => ({ path: "react-native", namespace: "stub" }));
        b.onResolve({ filter: /media3-player$/ }, () => ({ path: "media3", namespace: "stub" }));
        b.onLoad({ filter: /^react-native$/, namespace: "stub" }, () => ({ contents: `export const Platform = { constants: { Model: "Test" } };`, loader: "js" }));
        b.onLoad({ filter: /^media3$/, namespace: "stub" }, () => ({
          contents: `globalThis.__native = [];
            const say = (name) => async (...args) => { globalThis.__native.push([name, ...args]); };
            export default new Proxy({}, { get: (_, name) => name === "addListener" ? (event, fn) => { globalThis.__listeners ??= {}; globalThis.__listeners[event] = fn; } : name === "getMediaVolume" ? async () => 50 : say(name) });`,
          loader: "js",
        }));
        for (const [name, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`[\\\\/]mobile[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`);
          b.onLoad({ filter }, () => ({ contents, resolveDir: stores, loader: "ts" }));
        }
      },
    },
  ],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const { usePlayer, watchPlayer } = m;
watchPlayer();

const t = (id) => ({ id, title: id.toUpperCase(), artist: "Band", duration: 100 });
const many = (n) => Array.from({ length: n }, (_, i) => t(`s${i}`));
const player = () => usePlayer.getState();
const writesOf = (name) => (globalThis.__writes ?? []).filter(([file]) => file === name).map(([, value]) => value);

function nativeSays(index) {
  globalThis.__listeners.onState({ index, isPlaying: true, playWhenReady: true, isBuffering: false, isEnded: false, positionMs: 0, durationMs: 100000, repeat: "off", audio: "", count: player().queue.length });
}

beforeEach(() => {
  player().stop();
  globalThis.__writes = [];
  globalThis.__files = undefined;
  globalThis.__byId = undefined;
});

test("on to the next song: where it stands is written, the queue isn't written again; an edit writes the queue", () => {
  player().playTracks(many(1200), 0, "Long list", false);
  nativeSays(0);
  const queueWrites = writesOf("player-queue.json").length;
  assert.ok(queueWrites >= 1, "the queue written once it's there");
  const last = writesOf("player-queue.json").at(-1);
  assert.equal(last.ids.length, 1200);
  assert.equal(last.entries.length, 1200, "with its entries");
  nativeSays(1);
  nativeSays(2);
  assert.equal(writesOf("player-queue.json").length, queueWrites, "songs moving on don't write the queue");
  const where = writesOf("player.json").at(-1);
  assert.equal(where.index, 2);
  assert.equal("ids" in where, false, "where it stands, without the queue");
  player().removeAt(5);
  assert.equal(writesOf("player-queue.json").length, queueWrites + 1, "an edit writes it");
  assert.equal(writesOf("player-queue.json").at(-1).ids.length, 1199);
});

test("at a start: the queue from its own file, with its entries, and where it stood", async () => {
  const songs = many(5);
  globalThis.__byId = new Map(songs.map((s) => [s.id, s]));
  globalThis.__files = {
    "player.json": { index: 2, positionMs: 30_000, repeat: "all", at: 1000, queueId: "q-kept" },
    "player-queue.json": { queueId: "q-kept", context: "Kept", ids: songs.map((s) => s.id), line: 0, branches: [], home: null, entries: ["e0", "e1", "e2", "e3", "e4"], session: "s-kept" },
  };
  await player().restore();
  assert.deepEqual(player().queue.map((s) => s.id), ["s0", "s1", "s2", "s3", "s4"]);
  assert.equal(player().index, 2);
  assert.equal(player().positionMs, 30_000);
  assert.equal(player().repeat, "all");
  const doc = m.playbackNote({ id: "phone", name: "Phone" }).queue();
  assert.deepEqual(doc.entries, ["e0", "e1", "e2", "e3", "e4"], "the entries as they were");
  assert.equal(doc.session, "s-kept");
});

test("at a start, a queue kept the old way (in player.json) is read too", async () => {
  const songs = many(3);
  globalThis.__byId = new Map(songs.map((s) => [s.id, s]));
  globalThis.__files = { "player.json": { context: "Old", ids: songs.map((s) => s.id), index: 1, positionMs: 5_000, repeat: "off", at: 900, queueId: "q-old" } };
  await player().restore();
  assert.deepEqual(player().queue.map((s) => s.id), ["s0", "s1", "s2"]);
  assert.equal(player().index, 1);
  assert.equal(player().context, "Old");
});
