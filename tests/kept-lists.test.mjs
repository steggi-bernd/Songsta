// Lists downloaded as a whole stay whole (src/lib/keptLists.ts, src/lib/keptListsWatch.ts,
// mobile/src/stores/keptLists.ts): what's added later or failed last time comes by itself,
// what somebody took off by hand stays off.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dataUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const mobile = fileURLToPath(new URL("../mobile/src/stores/", import.meta.url));

/* ------------------------------------------------------------ the pure part */
const pure = await build({ entryPoints: [`${lib}keptLists.ts`], bundle: true, platform: "node", format: "esm", write: false });
const { albumListKey, completeLists, missingFromLists, playlistListKey } = await import(dataUrl(pure.outputFiles[0].text));

test("the songs still to fetch: each once, however many lists it's on", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };
  assert.deepEqual(missingFromLists([[a, b], [b, c], []], (s) => s !== c), [a, b]);
  assert.deepEqual(missingFromLists([], () => true), []);
});

test("a list counts as whole only with something on it and all of it there", () => {
  const whole = completeLists(
    [
      ["whole", ["a", "b"]],
      ["partly", ["a", "x"]],
      ["empty", []],
    ],
    (s) => s !== "x"
  );
  assert.deepEqual(whole, ["whole"]);
});

test("a playlist and an album can't be taken for each other", () => {
  assert.notEqual(playlistListKey("1"), albumListKey("1"));
});

/* ------------------------------------------------------------ the computer */
const desk = await build({
  stdin: { contents: `export { checkDownloadsAtStart, completeKeptLists, toggleKeptList, watchKeptLists } from "./keptListsWatch";`, resolveDir: lib, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        const stub = (contents) => ({ contents, resolveDir: lib, loader: "ts" });
        b.onLoad({ filter: /[\\/]stores[\\/]albumEdits\.ts$/ }, () => stub(`export const useAlbumEdits = { getState: () => ({ artists: {} }) };`));
        b.onLoad({ filter: /[\\/]stores[\\/]catalog\.ts$/ }, () =>
          stub(`export const useCatalog = { getState: () => ({ tracks: globalThis.__desk.albumSongs, loaded: globalThis.__desk.loaded, byId: new Map(globalThis.__desk.catalog.map((t) => [t.id, t])) }), subscribe: () => () => undefined };
            export const versionsOf = (t) => globalThis.__desk.copies[t.id] ?? [t];`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]library\.ts$/ }, () =>
          stub(`export const useLibrary = {
              getState: () => ({
                playlists: globalThis.__desk.playlists,
                downloads: globalThis.__desk.downloads,
                patchDownload: (id, patch) => { globalThis.__desk.downloads = { ...globalThis.__desk.downloads, [id]: { ...globalThis.__desk.downloads[id], ...patch } }; },
              }),
              persist: { hasHydrated: () => true },
              subscribe: () => () => undefined,
            };`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]settings\.ts$/ }, () =>
          stub(`export const useSettings = { getState: () => ({ keptLists: globalThis.__desk.kept, setKeptLists: (v) => { globalThis.__desk.kept = v; } }), subscribe: () => () => undefined };`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]ui\.ts$/ }, () =>
          stub(`export const useUI = {
              getState: () => ({ toast: (text) => globalThis.__desk.toasts.push(text) }),
              subscribe: (f) => { globalThis.__deskRefresh = () => f({ viewReloadNonce: 2 }, { viewReloadNonce: 1 }); return () => undefined; },
            };`)
        );
        b.onLoad({ filter: /[\\/]lib[\\/]catalogBuild\.ts$/ }, () => stub(`export const buildAlbums = (tracks) => [{ key: "lp", tracks }];`));
        b.onLoad({ filter: /[\\/]lib[\\/]downloads\.ts$/ }, () =>
          stub(`export const SERVER_SONG = /^(jf|ss):/;
            export const downloadForOffline = (tracks) => { globalThis.__desk.fetched.push(tracks.map((t) => t.id)); return tracks.length; };
            export const startDownload = async (track) => { globalThis.__desk.fetched.push([track.id]); };
            export const downloadsReconciled = async () => undefined;
            export const getDownload = (id) => globalThis.__desk.downloads[id] ?? (globalThis.__desk.status[id] ? { status: globalThis.__desk.status[id] } : undefined);`)
        );
      },
    },
  ],
});
const { checkDownloadsAtStart, completeKeptLists: completeDesk, toggleKeptList, watchKeptLists: watchDesk } = await import(dataUrl(desk.outputFiles[0].text));

beforeEach(() => {
  globalThis.__desk = { albumSongs: [], loaded: true, copies: {}, playlists: [], kept: [], fetched: [], status: {}, downloads: {}, catalog: [], toasts: [], gone: [] };
});

/** What a promise chain started by a timer has still to do. */
const settle = () => new Promise((done) => setImmediate(done));

const server = (id) => ({ id: `jf:${id}`, title: id });
const onDisk = (id) => ({ id: `local:${id}`, title: id, localPath: `/music/${id}.flac` });

test("computer: a song added to a kept playlist later comes by itself", () => {
  const d = globalThis.__desk;
  d.playlists = [{ id: "p", tracks: [server("a")] }];
  d.kept = ["playlist:p"];
  d.status = { "jf:a": "done" };
  completeDesk();
  assert.deepEqual(d.fetched, [], "all there");

  d.playlists = [{ id: "p", tracks: [server("a"), server("b")] }];
  completeDesk();
  assert.deepEqual(d.fetched, [["jf:b"]]);
});

test("computer: what's on its way isn't asked for twice, what failed is", () => {
  const d = globalThis.__desk;
  d.playlists = [{ id: "p", tracks: [server("queued"), server("going"), server("failed")] }];
  d.kept = ["playlist:p"];
  d.status = { "jf:queued": "queued", "jf:going": "downloading", "jf:failed": "failed" };
  completeDesk();
  assert.deepEqual(d.fetched, [["jf:failed"]]);
});

test("computer: a copy on this computer counts, also one of the same song from elsewhere", () => {
  const d = globalThis.__desk;
  const both = server("both");
  d.copies = { "jf:both": [both, onDisk("both")] };
  d.playlists = [{ id: "p", tracks: [onDisk("mine"), both] }];
  d.kept = ["playlist:p"];
  completeDesk();
  assert.deepEqual(d.fetched, []);
});

test("computer: nothing happens before the library has been read, or for lists that aren't kept", () => {
  const d = globalThis.__desk;
  d.playlists = [{ id: "p", tracks: [server("a")] }];
  completeDesk();
  assert.deepEqual(d.fetched, [], "not kept");
  d.kept = ["playlist:p"];
  d.loaded = false;
  completeDesk();
  assert.deepEqual(d.fetched, [], "not read yet");
});

test("computer: an album stays whole too, and a list that's gone is no problem", () => {
  const d = globalThis.__desk;
  d.albumSongs = [server("a"), server("b")];
  d.kept = ["album:lp", "playlist:gone"];
  d.status = { "jf:a": "done" };
  completeDesk();
  assert.deepEqual(d.fetched, [["jf:b"]]);
});

test("computer: pressed once it's kept and fetched, pressed again it's no longer kept and the files stay", () => {
  const d = globalThis.__desk;
  const tracks = [server("a"), onDisk("b")];
  toggleKeptList("playlist:p", tracks);
  assert.deepEqual(d.kept, ["playlist:p"]);
  assert.deepEqual(d.fetched, [["jf:a"]]);
  toggleKeptList("playlist:p", tracks);
  assert.deepEqual(d.kept, []);
  assert.deepEqual(d.fetched, [["jf:a"]], "nothing more");
});

test("computer: it looks at the start and on Refresh, not only every quarter of an hour", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval };
  const d = globalThis.__desk;
  d.playlists = [{ id: "p", tracks: [server("a")] }];
  d.kept = ["playlist:p"];
  const stop = watchDesk();
  t.after(() => {
    stop();
    delete globalThis.window;
  });
  t.mock.timers.tick(3000);
  await settle();
  assert.deepEqual(d.fetched, [["jf:a"]], "at the start");
  assert.deepEqual(d.toasts, ["A missing song is downloading again"], "with one note");

  d.status = { "jf:a": "done" };
  d.playlists = [{ id: "p", tracks: [server("a"), server("b")] }];
  globalThis.__deskRefresh();
  t.mock.timers.tick(3000);
  assert.deepEqual(d.fetched, [["jf:a"], ["jf:b"]], "on Refresh");

  d.status = { "jf:a": "done", "jf:b": "done" };
  d.playlists = [{ id: "p", tracks: [server("a"), server("b"), server("c")] }];
  t.mock.timers.tick(15 * 60_000);
  t.mock.timers.tick(3000);
  assert.deepEqual(d.fetched, [["jf:a"], ["jf:b"], ["jf:c"]], "every so often");
  assert.equal(d.toasts.length, 1, "the start check's note comes once");
});

/* The check at start: every offline copy, not only the lists kept whole. */
const row = (id, status, path = `/offline/${id}.flac`) => ({ track: server(id), path, status, progress: 0, downloaded: 0, total: 0 });

function deskWith({ downloads = [], catalog = [], gone = [] }) {
  const d = globalThis.__desk;
  d.downloads = Object.fromEntries(downloads.map((r) => [r.track.id, r]));
  d.catalog = catalog;
  globalThis.window = { bytune: { downloadsMissing: async (paths) => paths.filter((p) => gone.includes(p)) } };
  return d;
}

test("computer at start: a copy deleted from the disk comes back, one still there stays as it is", async (t) => {
  t.after(() => delete globalThis.window);
  const d = deskWith({ downloads: [row("a", "done"), row("b", "done")], catalog: [server("a"), server("b")], gone: ["/offline/a.flac"] });
  assert.equal(await checkDownloadsAtStart(), 1);
  assert.deepEqual(d.fetched, [["jf:a"]]);
  assert.equal(d.downloads["jf:b"].status, "done");
  assert.deepEqual(d.toasts, ["A missing song is downloading again"]);
});

test("computer at start: a download that broke off or failed goes again, unless the server doesn't have the song any more", async (t) => {
  t.after(() => delete globalThis.window);
  const d = deskWith({ downloads: [row("broke", "failed"), row("gone", "failed")], catalog: [server("broke")] });
  assert.equal(await checkDownloadsAtStart(), 1);
  assert.deepEqual(d.fetched, [["jf:broke"]]);
});

test("computer at start: taken off by hand stays off, also on a list kept whole", async (t) => {
  t.after(() => delete globalThis.window);
  const d = deskWith({ downloads: [row("off", "removed")], catalog: [server("off")] });
  d.playlists = [{ id: "p", tracks: [server("off")] }];
  d.kept = ["playlist:p"];
  assert.equal(await checkDownloadsAtStart(), 0);
  assert.deepEqual(d.fetched, []);
  assert.deepEqual(d.toasts, [], "nothing to do, nothing said");
});

test("computer at start: one note for all of it, the lists kept whole included, each song once", async (t) => {
  t.after(() => delete globalThis.window);
  const d = deskWith({ downloads: [row("a", "done"), row("b", "failed")], catalog: [server("a"), server("b")], gone: ["/offline/a.flac"] });
  d.playlists = [{ id: "p", tracks: [server("a"), server("b"), server("new")] }];
  d.kept = ["playlist:p"];
  assert.equal(await checkDownloadsAtStart(), 3);
  assert.deepEqual(d.fetched.flat().sort(), ["jf:a", "jf:b", "jf:new"]);
  assert.deepEqual(d.toasts, ["3 missing songs are downloading again"]);
});

/* ------------------------------------------------------------ the phone */
const phone = await build({
  stdin: { contents: `export { checkDownloads, useDownloads } from "./downloads"; export { completeKeptLists, listDownloads, takeListOff, watchKeptLists } from "./keptLists";`, resolveDir: mobile, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /^expo-file-system$/ }, () => ({ path: "fs", namespace: "stub" }));
        b.onResolve({ filter: /media3-player$/ }, () => ({ path: "media3", namespace: "stub" }));
        b.onResolve({ filter: /^react-native$/ }, () => ({ path: "react-native", namespace: "stub" }));
        b.onLoad({ filter: /^react-native$/, namespace: "stub" }, () => ({ contents: `export const AppState = { addEventListener(_, f) { globalThis.__appState = f; return { remove() {} }; } };`, loader: "js" }));
        b.onLoad({ filter: /^fs$/, namespace: "stub" }, () => ({ contents: `export class Directory {} export class File { delete() {} } export const Paths = {};`, loader: "js" }));
        b.onLoad({ filter: /^media3$/, namespace: "stub" }, () => ({
          contents: `export default { downloadTexts: async () => undefined, downloadExisting: async (files) => files.filter((f) => !(globalThis.__phone.gone ?? []).includes(f)), downloadCancel: async () => undefined, downloadDelete: async (f) => { globalThis.__phone.deleted.push(f); }, downloadQuery: async () => [], downloadStart: async () => 1, downloadFinish: async () => null };`,
          loader: "js",
        }));
        const stubs = {
          addresses: `export const withoutServer = (x) => x;`,
          jellyfin: `export const authHeader = () => ""; export const downloadPlan = () => ({ url: "", fileName: "", compact: false });`,
          lyrics: `export const keepLyrics = () => undefined;`,
          storage: `export const readJson = async () => globalThis.__phone.saved ?? null; export const writeJson = () => undefined;`,
          shared: `export * from "../../../src/lib/keptLists"; export { T } from "../../../src/lib/i18n";`,
          "stores/popups": `export const toast = (text) => { globalThis.__phone.toasts.push(text); };`,
          "stores/connection": `export const useConnection = { getState: () => ({ reach: "offline", metered: false }), subscribe() {} };`,
          "stores/session": `export const useSession = { getState: () => ({ session: null }) }; export const here = (x) => x;`,
          "stores/library": `const state = () => ({ loaded: true, byId: new Map(globalThis.__phone.songs.map((s) => [s.id, s])), albums: globalThis.__phone.albums, data: { favorites: globalThis.__phone.favorites } });
            export const useLibrary = { getState: state, subscribe(f) { globalThis.__phoneLibrary = f; } };
            export const likedSongIds = (favorites) => favorites;`,
          "stores/playlists": `export const usePlaylists = { getState: () => ({ playlists: globalThis.__phone.playlists }), subscribe() {} };
            export const playlistTracks = (p) => p.tracks;`,
        };
        for (const [name, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`[\\\\/]mobile[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`);
          b.onLoad({ filter }, () => ({ contents, resolveDir: mobile, loader: "ts" }));
        }
      },
    },
  ],
});
globalThis.__phone = { songs: [], albums: [], favorites: [], playlists: [], deleted: [], toasts: [] };
const { checkDownloads, useDownloads, completeKeptLists: completePhone, listDownloads, takeListOff, watchKeptLists: watchPhone } = await import(dataUrl(phone.outputFiles[0].text));

const song = (id, more = {}) => ({ id, title: id, ...more });
const loadingIds = () => Object.keys(useDownloads.getState().loading).sort();

function phoneWith({ playlists = [], albums = [], favorites = [], songs = [], lists = {}, kept = {}, loading = {}, notWanted = {} }) {
  globalThis.__phone = {
    songs: [...songs, ...playlists.flatMap((p) => p.tracks), ...albums.flatMap((a) => a.tracks), ...favorites.map((id) => song(id))],
    albums,
    favorites,
    playlists,
    deleted: [],
    toasts: [],
  };
  useDownloads.setState({ restored: true, lists, kept, loading, notWanted, covers: {}, listsNoted: true });
}

const gaveUp = { job: null, fileName: "", compact: false, tries: 3, wantsWifi: false, failed: true };

test("phone: a song added to a kept playlist later comes by itself", () => {
  phoneWith({
    playlists: [{ id: "p", tracks: [song("a"), song("b")] }],
    lists: { "playlist:p": true },
    kept: { a: { file: "a.flac", bytes: 1, compact: false } },
  });
  completePhone();
  assert.deepEqual(loadingIds(), ["b"]);
});

test("phone: taken off by hand, it stays off, until somebody asks for it again", () => {
  phoneWith({ playlists: [{ id: "p", tracks: [song("a"), song("b")] }], lists: { "playlist:p": true }, kept: { a: { file: "a.flac", bytes: 1, compact: false }, b: { file: "b.flac", bytes: 1, compact: false } } });
  const b = song("b");
  useDownloads.getState().remove([b]);
  assert.deepEqual(globalThis.__phone.deleted, ["b.flac"]);
  completePhone();
  assert.deepEqual(loadingIds(), [], "no list brings it back");
  useDownloads.getState().add([b]);
  assert.deepEqual(loadingIds(), ["b"]);
  assert.deepEqual(useDownloads.getState().notWanted, {});
});

test("phone: an album's downloads taken off leave the songs a kept playlist has, and nothing comes back", () => {
  const kept = (id) => ({ file: `${id}.flac`, bytes: 1, compact: false });
  phoneWith({
    albums: [{ key: "lp", tracks: [song("a"), song("b"), song("c")] }],
    playlists: [{ id: "p", tracks: [song("b"), song("x")] }],
    favorites: ["c"],
    lists: { "album:lp": true, "playlist:p": true, liked: true },
    kept: { a: kept("a"), b: kept("b"), c: kept("c"), x: kept("x") },
  });
  const album = globalThis.__phone.albums[0].tracks;
  const { going, staying } = listDownloads("album:lp", album);
  assert.deepEqual(going.map((t) => t.id), ["a"]);
  assert.deepEqual(staying.map((t) => t.id).sort(), ["b", "c"]);
  takeListOff("album:lp", album);
  assert.deepEqual(globalThis.__phone.deleted, ["a.flac"], "only the album's own song leaves the phone");
  assert.deepEqual(Object.keys(useDownloads.getState().kept).sort(), ["b", "c", "x"]);
  assert.equal(useDownloads.getState().lists["album:lp"], undefined, "the album isn't kept whole any more");
  assert.equal(completePhone(), 0, "nothing goes on its way again");
  assert.deepEqual(loadingIds(), []);
  assert.deepEqual(useDownloads.getState().notWanted, {}, "taken off with its list, not by hand");
});

test("phone: a playlist's downloads taken off leave what a kept album has, and stop what's still coming", () => {
  phoneWith({
    albums: [{ key: "lp", tracks: [song("a"), song("b")] }],
    playlists: [{ id: "p", tracks: [song("b"), song("y")] }],
    lists: { "album:lp": true, "playlist:p": true },
    kept: { a: { file: "a.flac", bytes: 1, compact: false } },
    loading: {
      b: { job: 7, fileName: "b", compact: false, tries: 0, wantsWifi: false, failed: false },
      y: { job: 8, fileName: "y", compact: false, tries: 0, wantsWifi: false, failed: false },
    },
  });
  takeListOff("playlist:p", globalThis.__phone.playlists[0].tracks);
  assert.deepEqual(loadingIds(), ["b"], "the album still wants b; y stops");
  assert.deepEqual(globalThis.__phone.deleted, []);
});

test("phone: what a list brings by itself doesn't count as somebody changing their mind", () => {
  phoneWith({ notWanted: { b: true } });
  useDownloads.getState().add([song("a"), song("b")], true);
  assert.deepEqual(useDownloads.getState().notWanted, { b: true });
});

test("phone: failed songs get another go, the ones on their way are left alone, folders count as there", () => {
  phoneWith({
    playlists: [{ id: "p", tracks: [song("failed"), song("going"), song("folder", { localPath: "/music/f.flac" })] }],
    lists: { "playlist:p": true },
    loading: {
      failed: { job: null, fileName: "", compact: false, tries: 3, wantsWifi: false, failed: true },
      going: { job: 5, fileName: "g", compact: false, tries: 0, wantsWifi: false, failed: false },
    },
  });
  completePhone();
  assert.deepEqual(loadingIds(), ["failed", "going"]);
  assert.equal(useDownloads.getState().loading.failed.failed, false);
  assert.equal(useDownloads.getState().loading.going.job, 5);
});

test("phone: albums and liked songs stay whole as well, and a list that's gone is no problem", () => {
  phoneWith({
    albums: [{ key: "lp", tracks: [song("x")] }],
    favorites: ["y"],
    lists: { "album:lp": true, liked: true, "playlist:gone": true },
  });
  completePhone();
  assert.deepEqual(loadingIds(), ["x", "y"]);
});

test("phone: a list no longer kept brings nothing", () => {
  phoneWith({ playlists: [{ id: "p", tracks: [song("a")] }], lists: { "playlist:p": true } });
  useDownloads.getState().dropList("playlist:p");
  completePhone();
  assert.deepEqual(loadingIds(), []);
});

test("phone: nothing before what it remembers has been read", () => {
  phoneWith({ playlists: [{ id: "p", tracks: [song("a")] }], lists: { "playlist:p": true } });
  useDownloads.setState({ restored: false });
  completePhone();
  assert.deepEqual(loadingIds(), []);
});

test("phone: it looks at the start, when the app comes back and after a pull-down, not only every quarter of an hour", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const state = { loaded: true, byId: new Map(), data: { favorites: [] }, refreshing: false };
  phoneWith({ playlists: [{ id: "p", tracks: [song("a")] }], lists: { "playlist:p": true } });
  watchPhone();
  t.mock.timers.tick(3000);
  assert.deepEqual(loadingIds(), ["a"], "at the start");

  const later = (id) => { const t = song(id); globalThis.__phone.songs = [t]; globalThis.__phone.playlists = [{ id: "p", tracks: [t] }]; useDownloads.setState({ loading: {}, kept: {} }); };
  later("b");
  globalThis.__appState("background");
  t.mock.timers.tick(3000);
  assert.deepEqual(loadingIds(), [], "going away is no reason");
  globalThis.__appState("active");
  t.mock.timers.tick(3000);
  assert.deepEqual(loadingIds(), ["b"], "coming back");

  later("c");
  globalThis.__phoneLibrary({ ...state, refreshing: true }, state);
  t.mock.timers.tick(3000);
  assert.deepEqual(loadingIds(), [], "while it's still reading");
  globalThis.__phoneLibrary(state, { ...state, refreshing: true });
  t.mock.timers.tick(3000);
  assert.deepEqual(loadingIds(), ["c"], "after a pull-down");

  later("d");
  t.mock.timers.tick(15 * 60_000);
  t.mock.timers.tick(3000);
  assert.deepEqual(loadingIds(), ["d"], "every so often");
  phoneWith({}); // nothing left to follow, or the store goes on looking for ever
});

/* The check when the app opens: every download, not only the lists kept whole. */
test("phone at opening: a song that gave up gets new tries, unless the server doesn't have it any more", () => {
  phoneWith({ songs: [song("broke")], loading: { broke: gaveUp, gone: gaveUp } });
  assert.equal(checkDownloads(), 1);
  const { loading } = useDownloads.getState();
  assert.equal(loading.broke.failed, false);
  assert.equal(loading.broke.tries, 0);
  assert.equal(loading.gone.failed, true, "nothing to ask the server for");
  phoneWith({});
});

test("phone at opening: a file cleared from outside comes back, unless it was taken off by hand or the server lost it", async () => {
  phoneWith({ songs: [song("a"), song("b"), song("d"), song("folder", { localPath: "/music/folder.flac" })] });
  const file = (name) => ({ file: `${name}.flac`, bytes: 1, compact: false });
  globalThis.__phone.saved = { kept: { a: file("a"), b: file("b"), c: file("c"), d: file("d"), folder: file("folder") }, notWanted: { b: true } };
  globalThis.__phone.gone = ["a.flac", "b.flac", "c.flac", "folder.flac"];
  await useDownloads.getState().restore();
  assert.deepEqual(Object.keys(useDownloads.getState().kept), ["d"], "what's cleared isn't there");
  assert.equal(checkDownloads(), 1);
  assert.deepEqual(loadingIds(), ["a"], "b was taken off by hand, c isn't on the server, the folder's copy plays from the folder");
  assert.equal(checkDownloads(), 0, "once");
  phoneWith({});
});

test("phone at opening: nothing before what it remembers and the library have been read", () => {
  phoneWith({ songs: [song("broke")], loading: { broke: gaveUp } });
  useDownloads.setState({ restored: false });
  assert.equal(checkDownloads(), null);
  assert.equal(useDownloads.getState().loading.broke.failed, true);
  phoneWith({});
});

test("phone at opening: one note for all of it; not again when back soon, again after a while away", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  phoneWith({
    songs: [song("broke")],
    playlists: [{ id: "p", tracks: [song("new")] }],
    lists: { "playlist:p": true },
    loading: { broke: gaveUp },
  });
  watchPhone();
  t.mock.timers.tick(3000);
  assert.deepEqual(globalThis.__phone.toasts, ["2 missing songs are downloading again"]);

  useDownloads.setState({ loading: { broke: gaveUp } });
  globalThis.__appState("background");
  t.mock.timers.tick(60_000);
  globalThis.__appState("active");
  t.mock.timers.tick(3000);
  assert.equal(globalThis.__phone.toasts.length, 1, "a minute away isn't opening the app");
  assert.equal(useDownloads.getState().loading.broke.failed, true);

  globalThis.__appState("background");
  t.mock.timers.tick(10 * 60_000);
  globalThis.__appState("active");
  t.mock.timers.tick(3000);
  assert.deepEqual(globalThis.__phone.toasts.slice(1), ["A missing song is downloading again"], "ten minutes away is");
  phoneWith({});
});
