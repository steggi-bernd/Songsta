import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { mergePlaylistDocs, toPlaylistDoc } from "../.test-build/playlistSync.mjs";
const require = createRequire(import.meta.url);
const plain = (v) => JSON.parse(JSON.stringify(v));
const track = (id) => ({ id, title: id, artist: "Test", duration: 60 });
const key = (group, id, parent) => JSON.stringify(group === "tracks" ? [group, parent, id] : [group, id]);
/** Two copies of the playlists, as the sync service makes them one. */
const merged = (a, b) => mergePlaylistDocs(toPlaylistDoc(a.state), toPlaylistDoc(b.state));
const codes = new Map();
async function harness(name, initial = null) {
  if (!codes.has(name)) codes.set(name, (await build({
    entryPoints: [fileURLToPath(new URL(`../src/stores/${name}.ts`, import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false, external: ["react"],
    plugins: [{ name: "isolated-storage", setup(build) {
      build.onLoad({ filter: /[\\/]lib[\\/]persist\.ts$/ }, () => ({ contents: "export const storage = globalThis.testStorage; export const coalescedStorage = globalThis.testStorage;" +
        // lazyJSONStorage, minus the coalescing: every write lands at once, as the assertions expect.
        // No async function here: inside the vm its promise is the sandbox's own, which fails
        // zustand's `instanceof Promise` (the host's) and would skip hydration.
        " export const lazyJSONStorage = () => ({ getItem: (n) => globalThis.testStorage.getItem(n).then((raw) => raw == null ? null : JSON.parse(raw))," +
        " setItem: (n, v) => globalThis.testStorage.setItem(n, JSON.stringify(v)), removeItem: (n) => globalThis.testStorage.removeItem(n) });", loader: "ts" }));
    } }],
  })).outputFiles[0].text);
  let disk = initial, gate = null;
  const writes = [];
  const storage = {
    async getItem() { const snapshot = disk; if (gate) await gate; return snapshot == null ? null : JSON.stringify(snapshot); },
    async setItem(_name, value) { disk = JSON.parse(value); writes.push(disk); },
    async removeItem() { disk = null; },
  };
  const module = { exports: {} };
  vm.runInNewContext(codes.get(name), { module, exports: module.exports, require, console, Promise, testStorage: storage });
  const store = module.exports[{ library: "useLibrary", recents: "useRecents", spotifyImport: "useSpotifyImport" }[name]];
  if (!store.persist.hasHydrated()) await new Promise((resolve) => {
    const off = store.persist.onFinishHydration(() => { off(); resolve(); });
  });
  return { store, writes, snapshot: () => plain(disk),
    restore(snapshot) {
      disk = snapshot;
      let release;
      gate = new Promise((r) => { release = r; });
      const done = store.persist.rehydrate();
      return async () => { gate = null; release(); await done; };
    },
  };
}

test("library public mutations persist adds/deletes atomically and later explicit re-adds survive", async () => {
  const h = await harness("library"), s = h.store.getState;
  s().toggleLike(track("liked"));
  s().toggleLike(track("liked"));
  assert.equal(h.writes.at(-1).state.liked.length, 0);
  assert.ok(h.writes.at(-1).state.deletionSync.deletes[key("liked", "liked")]);
  s().toggleLike(track("liked"));
  assert.equal(h.snapshot().state.liked.length, 1);
  const p = s().createPlaylist("P"), other = s().createPlaylist("Other");
  assert.equal(s().addToPlaylist("missing", track("x")), false);
  s().addToPlaylist(p.id, track("x"));
  s().addToPlaylist(other.id, track("x"));
  const beforeTrack = h.snapshot();
  const writesBefore = h.writes.length;
  s().removeFromPlaylist(p.id, "x");
  assert.equal(h.writes.length, writesBefore + 1);
  const tracksMerged = merged(h.snapshot(), beforeTrack).playlists;
  assert.equal(tracksMerged.find((x) => x.id === p.id).tracks.length, 0);
  assert.equal(tracksMerged.find((x) => x.id === other.id).tracks.length, 1);
  s().addToPlaylist(p.id, track("x"));
  assert.equal(merged(h.snapshot(), beforeTrack).playlists.find((x) => x.id === p.id).tracks.length, 1);
  const beforePlaylist = h.snapshot();
  s().deletePlaylist(p.id);
  assert.ok(!merged(h.snapshot(), beforePlaylist).playlists.some((x) => x.id === p.id));
  const f = s().createFolder("Folder");
  s().setPlaylistFolder(other.id, f.id);
  const beforeFolder = h.snapshot();
  s().deleteFolder(f.id);
  const afterFolder = merged(h.snapshot(), beforeFolder);
  assert.equal(afterFolder.folders.length, 0);
  assert.equal(afterFolder.playlists.find((x) => x.id === other.id).folderId, undefined);
  s().pushHistory(track("old"));
  s().clearHistory();
  assert.equal(h.snapshot().state.history.length, 0);
  s().pushHistory(track("new"));
  assert.deepEqual(h.snapshot().state.history.map((t) => t.id), ["new"]);
});

test("metadata edits are versioned independently from membership and duplicate adds are no-ops", async () => {
  const h = await harness("library"), s = h.store.getState;
  const p = s().createPlaylist("Before"), f = s().createFolder("Before");
  const before = h.snapshot();
  const added = before.state.deletionSync.adds[key("playlists", p.id)];
  s().renamePlaylist(p.id, "After"); s().togglePinPlaylist(p.id); s().setPlaylistFolder(p.id, f.id);
  s().renameFolder(f.id, "After");
  const after = h.snapshot();
  assert.equal(after.state.deletionSync.adds[key("playlists", p.id)], added);
  assert.ok(after.state.deletionSync.edits[key("playlists", p.id)] > added);
  const both = merged(before, after);
  assert.equal(both.playlists[0].name, "After");
  assert.equal(both.playlists[0].pinned, true);
  assert.equal(both.folders[0].name, "After");
  s().addToPlaylist(p.id, track("x"));
  const count = h.writes.length;
  assert.equal(s().addToPlaylist(p.id, track("x")), false);
  assert.equal(h.writes.length, count);
  const deleted = structuredClone(after);
  deleted.state.playlists = [];
  deleted.state.deletionSync.deletes[key("playlists", p.id)] = added + 1;
  assert.equal(merged(after, deleted).playlists.length, 0);
});

test("likes and ordered clear/history intents survive restore hydration with their metadata", async () => {
  const h = await harness("library"), s = h.store.getState;
  s().toggleLike(track("remove")); s().pushHistory(track("old"));
  const cloud = h.snapshot();
  cloud.state.liked.push(track("cloud-only"));
  const finish = h.restore(cloud);
  s().toggleLike(track("remove")); s().toggleLike(track("during"));
  s().pushHistory(track("before-clear")); s().clearHistory(); s().pushHistory(track("after-clear"));
  await finish();
  const restored = h.snapshot();
  assert.deepEqual(new Set(restored.state.liked.map((t) => t.id)), new Set(["cloud-only", "during"]));
  assert.deepEqual(restored.state.history.map((t) => t.id), ["after-clear"]);
  assert.ok(!restored.state.liked.some((t) => t.id === "remove"));
  assert.ok(restored.state.deletionSync.adds[key("history", "after-clear")] > restored.state.deletionSync.clears.history);
});

test("offline delete → drain → reset → reload durable backup does not resurrect a like", async () => {
  const original = await harness("library");
  original.store.getState().toggleLike(track("removed"));
  original.store.getState().toggleLike(track("removed"));
  // This harness commits storage writes synchronously; settle promise callbacks
  // before capturing the durable backup that survives a local-data reset.
  await Promise.resolve();
  const durableBackup = original.snapshot();
  assert.equal(durableBackup.state.liked.length, 0);
  assert.ok(durableBackup.state.deletionSync.deletes[key("liked", "removed")]);

  const reset = await harness("library", null);
  assert.equal(reset.store.getState().liked.length, 0);
  const reload = await harness("library", durableBackup);
  assert.equal(reload.writes.length, 0, "hydration must not invent a new add");
  assert.equal(reload.store.getState().liked.length, 0);
  assert.ok(plain(reload.store.getState()).deletionSync.deletes[key("liked", "removed")], "the deletion is still known");
});

test("ordinary hydration preserves versions without inventing fresh additions", async () => {
  const h = await harness("library"); h.store.getState().toggleLike(track("x"));
  const snapshot = h.snapshot(), restarted = await harness("library", snapshot);
  assert.deepEqual(plain(restarted.store.getState().deletionSync), snapshot.state.deletionSync);
  assert.equal(restarted.writes.length, 0);
});

test("an import that leads to one song twice likes it once", async () => {
  const h = await harness("library"), s = h.store.getState;
  s().toggleLike(track("mine"));
  assert.equal(s().importLikes([track("a"), track("b"), track("a")]), 2);
  assert.deepEqual(plain(s().liked.map((t) => t.id)), ["mine", "a", "b"]);
  assert.equal(s().importLikes([track("b"), track("a"), track("b")], ["a", "b"]), 0, "nothing new the second time");
  assert.deepEqual(plain(s().liked.map((t) => t.id)), ["mine", "b", "a"]);
});

test("songs checked after the first add land in their Spotify place, not above the songs liked before", async () => {
  const h = await harness("library"), s = h.store.getState;
  const ids = () => plain(s().liked.map((t) => t.id));
  s().toggleLike(track("mine"));
  // Spotify, newest first: a, b, c, d — b and d wait for a check on the first add.
  s().importLikes([track("a"), track("c")]);
  assert.deepEqual(ids(), ["mine", "a", "c"]);
  assert.equal(s().importLikes([track("a"), track("b"), track("c"), track("d")], ["a", "c"]), 2);
  assert.deepEqual(ids(), ["mine", "a", "b", "c", "d"]);
});

test("a liked song back in To check keeps its Spotify place, even when no earlier add is on record", async () => {
  const h = await harness("library"), s = h.store.getState;
  const ids = () => plain(s().liked.map((t) => t.id));
  // 1.0.4 imported a, b, c (b after a "Same song") but kept neither the decision nor a record
  // of the add: b is waiting for a check again, and the import laid it out in its place anyway.
  s().importLikes([track("a"), track("b"), track("c")]);
  s().toggleLike(track("mine"));
  assert.equal(s().importLikes([track("a"), track("b"), track("c")], []), 0);
  assert.deepEqual(ids(), ["mine", "a", "b", "c"]);
});

test("a song an import brought goes below it once the export no longer has it, add after add", async () => {
  const h = await harness("library"), s = h.store.getState;
  const ids = () => plain(s().liked.map((t) => t.id));
  s().importLikes([track("a"), track("b"), track("c")]);
  s().toggleLike(track("mine"));
  s().importLikes([track("a"), track("c")], ["a", "b", "c"]);
  assert.deepEqual(ids(), ["mine", "a", "c", "b"]);
  s().importLikes([track("a"), track("c")], ["a", "b", "c"]);
  assert.deepEqual(ids(), ["mine", "a", "c", "b"]);
});

test("server favorites become likes: new ones on top, a server's first sync below, one copy per song", async () => {
  const h = await harness("library"), s = h.store.getState;
  const ids = () => plain(s().liked.map((t) => t.id));
  s().toggleLike(track("mine")); s().toggleLike(track("jf:gone"));
  s().applyServerLikes([track("jf:new")], [track("ss:first"), track("mine")], ["jf:gone"]);
  assert.deepEqual(ids(), ["jf:new", "mine", "ss:first"]);
  const sync = h.snapshot().state.deletionSync;
  assert.ok(sync.adds[key("liked", "jf:new")] && sync.adds[key("liked", "ss:first")], "recorded as likes");
  assert.ok(sync.deletes[key("liked", "jf:gone")], "and the taken-back one as a removal");
  const writes = h.writes.length;
  s().applyServerLikes([], [track("mine")], []);
  assert.equal(h.writes.length, writes, "nothing new: no write at all");
});

test("the import remembers every song an add laid out, not just the last add's", async () => {
  const h = await harness("spotifyImport"), s = h.store.getState;
  s().noteLiked(["a", "b", "c"]);
  s().noteLiked(["a", "c", "d"]);
  assert.deepEqual(plain(s().likedIds), ["a", "b", "c", "d"]);
  assert.deepEqual(h.snapshot().state.likedIds, ["a", "b", "c", "d"], "and keeps it on disk");
});

test("a song an older version liked twice is liked once after loading, its sync metadata untouched", async () => {
  const h = await harness("library"), s = h.store.getState;
  s().toggleLike(track("x")); s().toggleLike(track("y"));
  const snapshot = h.snapshot();
  snapshot.state.liked = [...snapshot.state.liked, snapshot.state.liked[0]];
  const restarted = await harness("library", snapshot);
  assert.deepEqual(plain(restarted.store.getState().liked.map((t) => t.id)), ["y", "x"]);
  assert.deepEqual(plain(restarted.store.getState().deletionSync), snapshot.state.deletionSync);
});

test("search remove/clear is case-insensitive, versioned and later search wins", async () => {
  const h = await harness("recents"), s = h.store.getState;
  s().pushSearch("  Hello  ");
  s().removeSearch("hELLo");
  assert.deepEqual(h.snapshot().state.searches, []);
  s().pushSearch("HELLO");
  assert.deepEqual(h.snapshot().state.searches, ["HELLO"]);
  s().clearSearches();
  assert.deepEqual(h.snapshot().state.searches, []);
  for (let i = 0; i < 20; i++) s().pushSearch(`q${i}`);
  assert.equal(s().searches.length, 8);
  assert.equal(Object.keys(s().deletionSync.adds).length, 8);
});

test("search hydration replays removes and clear/add order, not accidental additions", async () => {
  const h = await harness("recents"), s = h.store.getState;
  s().pushSearch("remove"); const before = h.snapshot();
  let finish = h.restore(before);
  s().removeSearch("REMOVE"); await finish();
  assert.deepEqual(h.snapshot().state.searches, []);
  finish = h.restore(before);
  s().pushSearch("before"); s().clearSearches(); s().pushSearch("after"); await finish();
  assert.deepEqual(h.snapshot().state.searches, ["after"]);
});
