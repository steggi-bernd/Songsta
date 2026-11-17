// Songs skipped early (src/stores/skips.ts watchSkips): a song left within its first half minute after
// it played here counts; a song restored at the start and never played, or one paused for a while
// before something else was picked, doesn't. "Remember songs I skip" off keeps nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const stores = fileURLToPath(new URL("../src/stores/", import.meta.url));
const stubs = {
  "lib/persist": `export const storage = { getItem: () => null, setItem() {}, removeItem() {} };`,
  "stores/catalog": `export const songKey = (id) => id;`,
  "stores/player": `import { create } from "zustand"; export const usePlayer = create(() => ({ queue: [], index: 0, playing: false, position: 0 }));`,
  "stores/settings": `export const useSettings = { getState: () => ({ recordSkips: globalThis.__recordSkips !== false }) };`,
};
const out = await build({
  stdin: { contents: `export { useSkips, watchSkips } from "./skips"; export { usePlayer } from "./player";`, resolveDir: stores, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        for (const [name, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`);
          b.onLoad({ filter }, () => ({ contents, resolveDir: stores, loader: "ts" }));
        }
      },
    },
  ],
});
const { useSkips, watchSkips, usePlayer } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const song = (id, duration = 200) => ({ id, title: id, artist: "Band", duration });
const [a, b, c] = [song("a"), song("b"), song("c")];
watchSkips();
const skipped = () => Object.keys(useSkips.getState().skips).sort();
const fresh = () => {
  usePlayer.setState({ queue: [], index: 0, playing: false, position: 0 });
  useSkips.setState({ skips: {} });
};

test("a queue emptied while a song plays isn't a skip: it wasn't left for another", () => {
  fresh();
  usePlayer.setState({ queue: [a, b], index: 0, playing: true, position: 0 });
  usePlayer.setState({ position: 4 });
  usePlayer.setState({ queue: [], index: 0, playing: false, position: 0 });
  assert.deepEqual(skipped(), []);
});

test("a song restored at the start and never played isn't skipped by picking another", () => {
  fresh();
  usePlayer.setState({ queue: [a, b], index: 0, playing: false, position: 0 });
  usePlayer.setState({ queue: [c], index: 0, playing: true, position: 0 });
  assert.deepEqual(skipped(), []);
});

test("a song that played and was left within half a minute is skipped; one heard past it isn't", () => {
  fresh();
  usePlayer.setState({ queue: [a, b, c], index: 0, playing: true, position: 0 });
  usePlayer.setState({ position: 12 });
  usePlayer.setState({ index: 1, position: 0 });
  assert.deepEqual(skipped(), ["a"]);
  usePlayer.setState({ position: 95 });
  usePlayer.setState({ index: 2, position: 0 });
  assert.deepEqual(skipped(), ["a"], "b was heard well past half a minute");
});

test("paused for minutes at its start, then another picked: not a skip by the clock", () => {
  fresh();
  usePlayer.setState({ queue: [a, b], index: 0, playing: true, position: 0 });
  usePlayer.setState({ position: 40 });
  usePlayer.setState({ playing: false });
  // Minutes later, at 40 s in: listened to, not skipped.
  usePlayer.setState({ index: 1, playing: true, position: 0 });
  assert.deepEqual(skipped(), []);
});

test("Remember songs I skip off: nothing is kept", () => {
  fresh();
  globalThis.__recordSkips = false;
  try {
    usePlayer.setState({ queue: [a, b], index: 0, playing: true, position: 0 });
    usePlayer.setState({ position: 3 });
    usePlayer.setState({ index: 1, position: 0 });
    assert.deepEqual(skipped(), []);
  } finally {
    globalThis.__recordSkips = undefined;
  }
});
