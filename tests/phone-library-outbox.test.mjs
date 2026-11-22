// The phone's library store with what it owes its server (mobile/src/stores/library.ts, outbox.ts; Codex's
// section 15): a busy server's wait (429) holds for both steps of a refresh and for the timer, also when
// the timer is told to wait again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const src = fileURLToPath(new URL("../mobile/src/", import.meta.url));
const stubs = {
  color: `export const blurhashColor = () => null;`,
  jellyfin: `export const isNoAnswer = (e) => e?.name === "NoAnswer";
    export const isUnsure = (e) => e?.unsure === true;
    export const statusOf = (e) => (typeof e?.status === "number" ? e.status : undefined);
    export const retryAfterOf = (e) => (typeof e?.retryAfterMs === "number" ? e.retryAfterMs : undefined);
    export const artistPhotoUrl = () => null;
    export const fetchLibrary = async () => structuredClone(globalThis.__library);
    const answer = (what) => { (globalThis.__asked ??= []).push({ what, at: Date.now() }); const next = (globalThis.__answers ??= []).shift(); return next instanceof Error ? Promise.reject(next) : Promise.resolve(next); };
    export const setFavorite = (s, t, liked) => answer(\`like \${t.id} \${liked}\`);
    export const markPlayed = (s, t, at) => answer(\`play \${t.id}\`);
    export const playedSince = async () => false;`,
  storage: `export const readJson = async (name) => globalThis.__files?.[name] ?? null;
    export const writeJson = (name, value) => { (globalThis.__files ??= {})[name] = structuredClone(value); };
    export const removeJson = (name) => { if (globalThis.__files) delete globalThis.__files[name]; };`,
  "stores/listens": `export const useListens = { getState: () => ({ note() {} }) };`,
  "stores/albumEdits": `export const albumEditsNow = () => ({ songs: {}, aliases: {}, mergedInto: {}, titles: {}, covers: {}, artists: {} });
    export const useAlbumEdits = { getState: () => ({ restore: async () => undefined, clear() {} }), subscribe() {} };`,
  "stores/connection": `export const useConnection = { getState: () => ({ reach: "online", check: async () => "online" }), subscribe() {} };`,
  "stores/librarySync": `export const useLibrarySync = { getState: () => ({ clear() {} }) };`,
  "stores/localMusic": `export const localSongs = () => []; export const setServerSongFiles = () => {}; export const useLocalMusic = { subscribe() {} };`,
  "stores/session": `export const useSession = { getState: () => ({ session: globalThis.__session }) };`,
  "stores/settings": `export const useSettings = { getState: () => ({ recordListening: true, serverPlays: true, filterNonMusic: false }), subscribe() {} };`,
  "stores/soundShare": `export const sharedEnergyOf = () => undefined; export const sharedSoundOf = () => undefined; export const useSoundShare = { getState: () => ({ clear() {} }), subscribe() {} };`,
};
const out = await build({
  stdin: { contents: `export { useLibrary } from "./stores/library"; export * as outbox from "./outbox";`, resolveDir: src, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /^react-native$/ }, () => ({ path: "react-native", namespace: "stub" }));
        b.onLoad({ filter: /^react-native$/, namespace: "stub" }, () => ({ contents: `export const Platform = { OS: "android", constants: {} };`, loader: "js" }));
        for (const [name, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`[\\\\/]mobile[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`);
          b.onLoad({ filter }, () => ({ contents, resolveDir: src, loader: "js" }));
        }
      },
    },
  ],
});
const { useLibrary, outbox } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const song = { id: "jf:1", title: "One", artist: "Band", album: "LP", duration: 100, thumb: "" };
const busy = (ms) => Object.assign(new Error("HTTP 429"), { status: 429, retryAfterMs: ms });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a busy server's wait holds for both steps of a refresh and for the timer, also when the timer is told to wait again", async () => {
  globalThis.__session = { server: "http://pi", home: "http://pi", serverId: "srv", token: "t", userId: "anna", deviceId: "phone" };
  globalThis.__library = { tracks: [song], hashes: {}, favorites: [], counts: {}, artistIds: {} };
  globalThis.__asked = [];
  globalThis.__answers = [busy(200), busy(200), undefined];
  // A song the library knows, with a like still owed for it.
  useLibrary.setState({ byId: new Map([[song.id, song]]) });
  outbox.oweLike(globalThis.__session, song.id, true);
  await useLibrary.getState().refresh();
  assert.equal(globalThis.__asked.length, 1, "the refresh asked once: told to wait, its second step waited too");
  await wait(320);
  assert.equal(globalThis.__asked.length, 2, "the timer asked again once the wait was over");
  await wait(320);
  assert.equal(globalThis.__asked.length, 3, "told to wait again, the timer asked again after that wait");
  const gaps = globalThis.__asked.slice(1).map((a, i) => a.at - globalThis.__asked[i].at);
  for (const gap of gaps) assert.ok(gap >= 180, `asked again only after the wait (${gaps.join(", ")} ms)`);
  assert.deepEqual({ ...outbox.owedLikes(globalThis.__session) }, {}, "taken at last");
});

/* ------------------------------------------------------------- liked while a busy server asked to wait (Codex, section 17) */

test("liked while a busy server asked to wait: the like isn't sent at once, it goes with what's owed after the wait", async () => {
  const two = { ...song, id: "jf:2", title: "Two" };
  globalThis.__library = { tracks: [song, two], hashes: {}, favorites: [], counts: {}, artistIds: {} };
  globalThis.__asked = [];
  globalThis.__answers = [busy(200), undefined, undefined];
  useLibrary.setState({ byId: new Map([[song.id, song], [two.id, two]]) });
  outbox.oweLike(globalThis.__session, song.id, true);
  await useLibrary.getState().refresh();
  assert.equal(globalThis.__asked.length, 1, "told to wait");
  useLibrary.getState().toggleFavorite(two);
  await wait(20);
  assert.equal(globalThis.__asked.length, 1, "the new like waits too");
  await wait(320);
  assert.deepEqual(globalThis.__asked.slice(1).map((a) => a.what).sort(), ["like jf:1 true", "like jf:2 true"], "both go once the wait is over");
});
