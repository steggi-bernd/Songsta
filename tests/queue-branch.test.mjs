// Songs into the queue at a position (player store insertInQueue), and Branch off
// (src/lib/trackActions.ts): the song next — or where it was dropped — then the rest of the
// list it came from; what was coming goes on afterwards, without the songs the branch brings.
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const stub = (contents) => ({ contents, resolveDir: lib, loader: "ts" });
const out = await build({
  stdin: {
    contents: `export { usePlayer } from "../stores/player"; export { branchOff, branchOffAfterDrop, trackMenuItems } from "./trackActions";`,
    resolveDir: lib,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onLoad({ filter: /[\\/]lib[\\/]persist\.ts$/ }, () =>
          stub(`export const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }; export const lazyJSONStorage = () => ({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined });`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]catalog\.ts$/ }, () => stub(`export const songKey = (id) => id; export const versionsOf = (t) => [t]; export const useCatalog = { getState: () => ({ tracks: [], loaded: false }), subscribe: () => () => undefined };`));
        b.onLoad({ filter: /[\\/]stores[\\/]ui\.ts$/ }, () =>
          stub(`export const useUI = { getState: () => ({ toast: (m) => globalThis.__toasts.push(m), openDialog() {}, navigate() {} }) };`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]library\.ts$/ }, () =>
          stub(`export const useLibrary = { getState: () => ({ isLiked: () => false, playlists: [], toggleLike() {}, addToPlaylist() {} }) };`)
        );
        b.onLoad({ filter: /[\\/]lib[\\/]downloads\.ts$/ }, () =>
          stub(`export const SERVER_SONG = /^(jf|ss):/; export const downloadForOffline = () => 0; export const startDownload = async () => {}; export const getDownload = () => undefined;`)
        );
        // The "Play on" submenu: no devices around in this test.
        b.onLoad({ filter: /[\\/]lib[\\/]cast\.ts$/ }, () => stub(`export const useCast = { getState: () => ({ devices: [] }) };`));
        b.onLoad({ filter: /[\\/]lib[\\/]zones\.ts$/ }, () => stub(`export const startZone = async () => "";`));
      },
    },
  ],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const { usePlayer } = m;

const t = (id) => ({ id, title: id.toUpperCase(), artist: "Band", duration: 100, thumb: "" });
const ids = () => usePlayer.getState().queue.map((x) => x.id);
const LIST = { name: "Mixtape", tracks: [t("x1"), t("x2"), t("x3"), t("b")], index: 1 };

beforeEach(() => {
  globalThis.__toasts = [];
  usePlayer.getState().clearUpcoming();
  usePlayer.setState({ queue: [t("a"), t("b"), t("c")], index: 0, playing: true, position: 0, lineEnd: 0, branches: [] });
});

test("a song goes in where it is put — never before the playing one", () => {
  usePlayer.getState().insertInQueue([t("n")], 2);
  assert.deepEqual(ids(), ["a", "b", "n", "c"]);
  usePlayer.getState().insertInQueue([t("m")], 0);
  assert.deepEqual(ids(), ["a", "m", "b", "n", "c"]);
  usePlayer.getState().insertInQueue([t("z")], 99);
  assert.deepEqual(ids(), ["a", "m", "b", "n", "c", "z"]);
  // An empty queue simply becomes the song, waiting to play.
  usePlayer.setState({ queue: [], index: 0, playing: false });
  usePlayer.getState().insertInQueue([t("solo")], 5);
  assert.deepEqual(ids(), ["solo"]);
  assert.equal(usePlayer.getState().playing, false);
});

test("Branch off: the song next, then the rest of its list, then what was coming — once each", () => {
  m.branchOff(LIST);
  // b comes with the branch, so it isn't played a second time afterwards.
  assert.deepEqual(ids(), ["a", "x2", "x3", "b", "c"]);
  assert.equal(usePlayer.getState().index, 0);
  assert.match(globalThis.__toasts.at(-1), /Branching off into “Mixtape” — 3 songs/);
});

test("Branch off with nothing queued plays the branch", () => {
  usePlayer.setState({ queue: [], index: 0, playing: false });
  m.branchOff(LIST);
  assert.deepEqual(ids(), ["x2", "x3", "b"]);
  assert.equal(usePlayer.getState().playing, true);
});

test("after a drop, Branch off continues the list behind the dropped song, wherever it is now", () => {
  usePlayer.getState().insertInQueue([t("x2")], 2); // dropped between b and c
  assert.deepEqual(ids(), ["a", "b", "x2", "c"]);
  m.branchOffAfterDrop(LIST);
  // b comes with the branch now: it plays there, once, not also before x2.
  assert.deepEqual(ids(), ["a", "x2", "x3", "b", "c"]);
  assert.match(globalThis.__toasts.at(-1), /Then the rest of “Mixtape” — 2 songs/);
  // The queue moved on meanwhile: the rest still lands right behind the dropped song.
  usePlayer.setState({ queue: [t("a"), t("x2"), t("c")], index: 1 });
  m.branchOffAfterDrop(LIST);
  assert.deepEqual(ids(), ["a", "x2", "c"], "the dropped song is playing already — nothing to attach to");
  usePlayer.setState({ queue: [t("a"), t("c"), t("x2")], index: 1 });
  m.branchOffAfterDrop(LIST);
  assert.deepEqual(ids(), ["a", "c", "x2", "x3", "b"]);
  // The dropped song already played: nothing to attach to.
  usePlayer.setState({ index: 3 });
  const before = ids();
  m.branchOffAfterDrop(LIST);
  assert.deepEqual(ids(), before);
});

test("the menu has one way to queue, Branch off right under it — only when the list goes on", () => {
  const labels = (items) => items.map((i) => i.label);
  const withList = labels(m.trackMenuItems(t("x2"), LIST));
  assert.equal(withList.includes("Play next"), false);
  assert.equal(withList[withList.indexOf("Add to queue") + 1], "Branch off into “Mixtape”");
  assert.equal(labels(m.trackMenuItems(t("x2"))).some((l) => l?.startsWith("Branch off")), false);
  assert.equal(labels(m.trackMenuItems(t("b"), { ...LIST, index: 3 })).some((l) => l?.startsWith("Branch off")), false);
});

test("on the chosen song the menu takes the branch back", () => {
  const labels = (items) => items.map((i) => i.label);
  m.branchOff(LIST);
  const onChosen = m.trackMenuItems(t("x2"), LIST);
  const undo = onChosen.find((i) => i.label === "Undo branch");
  assert.ok(undo, "the chosen song offers it");
  assert.equal(labels(m.trackMenuItems(t("x3"), { ...LIST, index: 2 })).includes("Undo branch"), false, "another song of the list branches from there instead");
  undo.action();
  assert.deepEqual(ids(), ["a", "b", "c"]);
  assert.deepEqual(usePlayer.getState().branches, []);
  assert.equal(globalThis.__toasts.at(-1), "Branch taken back");
});
