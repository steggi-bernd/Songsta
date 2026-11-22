// The phone's side of the shared listening history (mobile/src/stores/listens.ts): its own plays go out
// in the order they counted, by place and not by moment, so one play stamped by a clock that ran ahead
// holds nothing back; the place moves along when the oldest are let go.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const stores = fileURLToPath(new URL("../mobile/src/stores/", import.meta.url));
const listenSync = fileURLToPath(new URL("../src/lib/listenSync.ts", import.meta.url)).replace(/\\/g, "/");
const stubs = {
  storage: `export const readJson = async (name) => globalThis.__files?.[name] ?? null; export const writeJson = () => {};`,
  shared: `export { listenKey } from "${listenSync}";`,
  "stores/settings": `export const useSettings = { getState: () => ({ recordListening: globalThis.__recordListening !== false }) };`,
};
const out = await build({
  stdin: { contents: `export { useListens } from "./listens";`, resolveDir: stores, loader: "ts" },
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
const { useListens } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const T0 = Date.UTC(2026, 10, 15, 12);
const song = (id) => ({ id, title: id.toUpperCase(), artist: "Band", album: "LP", duration: 200 });
const fresh = () => useListens.setState({ listens: [], shared: [], sentCount: 0, sentFloor: 0, readUpTo: 0, server: "pi", loaded: true });
const ids = (list) => list.map((l) => l.id);

test("the plays go out in the order they counted, whatever the clock said", () => {
  fresh();
  const s = useListens.getState();
  s.note(song("first"), T0);
  s.note(song("ahead"), T0 + 86_400_000);
  const batch = useListens.getState().pending(10);
  assert.deepEqual(ids(batch), ["first", "ahead"]);
  useListens.getState().markSent(batch[batch.length - 1]);
  // The clock put right: the next play is stamped before the one that ran ahead.
  useListens.getState().note(song("after the fix"), T0 + 60_000);
  assert.deepEqual(ids(useListens.getState().pending(10)), ["after the fix"], "not held back");
  assert.deepEqual(ids(useListens.getState().pending(1)), ["after the fix"]);
});

test("letting the oldest go moves the place along, also while a batch is on its way", () => {
  fresh();
  const kept = Array.from({ length: 39_999 }, (_, i) => ({ id: `old${i}`, at: T0 - (40_000 - i) * 60_000, ms: 200_000, title: "Old", artist: "Band" }));
  useListens.setState({ listens: kept, sentCount: 39_998 });
  const batch = useListens.getState().pending(10);
  assert.deepEqual(ids(batch), ["old39998"]);
  useListens.getState().note(song("new1"), T0);
  useListens.getState().note(song("new2"), T0 + 1);
  assert.equal(useListens.getState().listens.length, 40_000, "forty thousand kept");
  assert.equal(useListens.getState().sentCount, 39_997, "the place moved with the one let go");
  useListens.getState().markSent(batch[0]);
  assert.equal(useListens.getState().sentCount, 39_998, "the batch found where it is now");
  assert.deepEqual(ids(useListens.getState().pending(10)), ["new1", "new2"]);
});

test("a sync service that started over, or another one, gets every play again", () => {
  fresh();
  useListens.getState().note(song("a"), T0);
  useListens.getState().markSent(useListens.getState().pending(5)[0]);
  assert.equal(useListens.getState().pending(5).length, 0);
  useListens.getState().take([], {}, 0, true);
  assert.deepEqual(ids(useListens.getState().pending(5)), ["a"]);
  useListens.getState().markSent(useListens.getState().pending(5)[0]);
  useListens.getState().useServer("another");
  assert.deepEqual(ids(useListens.getState().pending(5)), ["a"]);
});

test("taken off the sync service on asking: those plays never go there again, new ones do", () => {
  fresh();
  useListens.getState().note(song("a"), T0);
  useListens.getState().note(song("b"), T0 + 1);
  useListens.getState().keepOwnHere();
  assert.equal(useListens.getState().pending(5).length, 0, "nothing of before goes out");
  useListens.getState().note(song("c"), T0 + 2);
  assert.deepEqual(ids(useListens.getState().pending(5)), ["c"], "a new play does");
  useListens.getState().markSent(useListens.getState().pending(5)[0]);
  // The shorter history makes every device read it again: this phone sends its own again, apart from those.
  useListens.getState().take([], {}, 0, true);
  assert.deepEqual(ids(useListens.getState().pending(5)), ["c"]);
  // Another service is a fresh start: everything goes there.
  useListens.getState().useServer("another");
  assert.deepEqual(ids(useListens.getState().pending(5)), ["a", "b", "c"]);
});

test("Delete my plays: everything kept on the phone goes; what was read of the shared history isn't read again", () => {
  fresh();
  useListens.getState().note(song("a"), T0);
  useListens.setState({ shared: [{ id: "x", at: T0, ms: 1, title: "X", artist: "B", device: "pc" }], readUpTo: 9, sentCount: 1 });
  useListens.getState().clearAll();
  const s = useListens.getState();
  assert.deepEqual([s.listens.length, s.shared.length, s.sentCount, s.sentFloor, s.readUpTo], [0, 0, 0, 0, 9]);
});

test("plays not kept while that's switched off (Settings → Network & privacy)", () => {
  fresh();
  globalThis.__recordListening = false;
  try {
    useListens.getState().note(song("unkept"), T0);
    assert.equal(useListens.getState().listens.length, 0);
  } finally {
    globalThis.__recordListening = undefined;
  }
  useListens.getState().note(song("kept"), T0);
  assert.equal(useListens.getState().listens.length, 1);
});

test("read back at the start: the place kept, or from the start where the plays were lost", async () => {
  const listens = [{ id: "a", at: T0, ms: 1, title: "A", artist: "B" }, { id: "b", at: T0 + 1, ms: 1, title: "B", artist: "B" }];
  globalThis.__files = { "listens.json": listens, "listens-shared.json": { server: "pi", sentCount: 1, readUpTo: 7, listens: [] } };
  useListens.setState({ listens: [], loaded: false });
  await useListens.getState().load();
  assert.equal(useListens.getState().sentCount, 1);
  assert.equal(useListens.getState().readUpTo, 7);
  assert.deepEqual(ids(useListens.getState().pending(5)), ["b"]);

  globalThis.__files = { "listens.json": null, "listens-shared.json": { server: "pi", sentCount: 500, readUpTo: 7, listens: [] } };
  useListens.setState({ listens: [], loaded: false });
  await useListens.getState().load();
  assert.equal(useListens.getState().sentCount, 0, "more sent than there are: what's here goes again");
  globalThis.__files = undefined;
});

/* ------------------------------------------------------------- the history's generation (part 2 of the protocol rework) */

test("another version of the shared history: read from its start, this phone's plays go again, what came in stays", () => {
  fresh();
  const s = useListens.getState();
  s.note(song("mine"), T0);
  s.markSent({ at: T0, id: "mine" });
  s.take([{ n: 1, device: "pc", at: T0 - 60_000, id: "pc1", title: "PC1", artist: "Band", ms: 200_000 }], { pc: { name: "PC" } }, 2);
  s.readThrough("g1");
  assert.deepEqual(useListens.getState().versionRead(), { read: "g1", afresh: null });
  s.readAfresh("g2");
  assert.equal(useListens.getState().readUpTo, 0, "read from its start");
  assert.equal(useListens.getState().sentCount, 0, "its own plays go again");
  assert.deepEqual(useListens.getState().versionRead(), { read: "g1", afresh: "g2" });
  s.take([{ n: 1, device: "pc2", at: T0 - 30_000, id: "pc2", title: "PC2", artist: "Band", ms: 200_000 }], { pc2: { name: "New PC" } }, 1);
  s.readThrough("g2");
  assert.deepEqual(useListens.getState().versionRead(), { read: "g2", afresh: null });
  assert.deepEqual(ids(useListens.getState().shared), ["pc1", "pc2"], "what came in stays");
  useListens.getState().useServer("another");
  assert.deepEqual(useListens.getState().versionRead(), { read: null, afresh: null }, "another service: no version read yet");
});
