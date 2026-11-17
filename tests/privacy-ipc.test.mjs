// "Keep my plays" in the main process (electron/main.ts): switched off, a play counts nowhere, and the
// shared listening history neither hands out this computer's plays nor takes the others' in, whatever
// the page asks. Switched on, all three work.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync, transform } from "esbuild";
const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL("../electron/", import.meta.url));
const sharedModules = new Map();
function sharedModule(name) {
  if (!sharedModules.has(name)) {
    const { outputFiles } = buildSync({ entryPoints: [path.join(root, `${name}.ts`)], bundle: true, platform: "node", format: "cjs", write: false });
    const module = { exports: {} };
    vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, console, URL });
    sharedModules.set(name, module.exports);
  }
  return sharedModules.get(name);
}

async function loadMain() {
  const source = fs.readFileSync(path.join(root, "main.ts"), "utf8");
  const { code } = await transform(source + "\nexport { registerIpc };", { loader: "ts", format: "cjs" });
  const handles = new Map();
  const events = new Map();
  const policy = { ownOnly: false, off: [], recordListening: true };
  const calls = { counted: [], started: [], taken: [], remote: [] };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, URL, __dirname: root,
    process: { env: {}, on() {}, platform: "win32" },
    require(name) {
      if (name === "electron") return {
        app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => path.join(root, "userdata") },
        protocol: { registerSchemesAsPrivileged() {} },
        ipcMain: { handle: (n, fn) => handles.set(n, fn), on: (n, fn) => events.set(n, fn) },
        shell: { openPath: async () => "blocked", showItemInFolder() {} },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        Menu: { setApplicationMenu() {} },
        session: { defaultSession: { webRequest: { onBeforeSendHeaders() {}, onCompleted() {} } } },
        BrowserWindow: { getAllWindows: () => [] },
      };
      if (name === "./pip") return { registerPipIpc() {}, isTrustedSender: (e) => e?.trusted === true, closePip() {}, savePipRect() {}, rendererUrl: () => "file://x", restrictNavigation() {} };
      if (name === "./downloads") return { addDownloadListener() {}, enqueueDownload: async () => "q1", cancelDownload: () => "ok", queueSnapshot: () => [], resetDownloads: async () => {} };
      if (name === "./app-update") return { configureAppUpdate() {}, installUpdate() {}, latestKnown: async () => null, startUpdate: async () => {}, updateState: () => ({}) };
      if (name === "./stats") return {
        initStats() {}, flushSync() {}, resetStats() {}, summary: () => ({}), HISTORY_STORE: "listening-history",
        noteTrackStart: (id) => calls.started.push(id),
        recordListening: (track, ms) => calls.counted.push([track.id, ms]),
        recordRemotePlays: (fresh) => calls.remote.push(...fresh),
      };
      if (name === "./listens") return {
        ownListensFrom: async () => ({ total: 1, listens: [{ at: Date.now() - 60_000, id: "jf:mine", title: "Mine", artist: "Me", album: "", duration: 200 }] }),
        noteRemoteListens: async (listens) => {
          calls.taken.push(...listens);
          return listens;
        },
      };
      if (name === "./persist") return { readData: () => null, writeData: async () => {}, writeDataSync() {}, drainWrites: async () => {}, resetAppData: async () => {}, migrateLegacyData() {} };
      if (name === "./album-genres") return { albumGenresKnown: () => ({}), askAlbumGenres: () => 0, stopAlbumGenres() {}, onAlbumGenres() {} };
      if (name === "./net-gate") return {
        installNetGate() {}, gatePages() {}, trustEntered() {}, ownServersChanged() {},
        netActivity: () => ({ log: [], services: {}, own: { count: 0, last: 0 }, since: 0 }),
        privacy: () => policy,
        setPrivacy: () => policy,
      };
      if (name === "./data-location") return { askMove: () => "Choose a whole folder", cancelMove() {}, clearCachesAtStart() {}, dataPlace: () => ({}), forgetLeftover: () => false, networkCaches: () => [] };
      if (name === "./data-place") return { sizeOf: async () => 0 };
      if (name.startsWith("../src/")) return sharedModule(name);
      if (name.startsWith("./")) return {};
      return require(name);
    },
  });
  module.exports.registerIpc();
  return { handles, events, policy, calls };
}

const trusted = { trusted: true };
const track = { id: "jf:song", title: "Song", artist: "Band", album: "LP", duration: 200 };
const theirs = [{ n: 1, device: "phone-1", at: Date.now() - 120_000, id: "jf:theirs", title: "Theirs", artist: "Band", ms: 200_000 }];

test("Keep my plays on: plays count, the history goes out and comes in", async () => {
  const { handles, events, calls } = await loadMain();
  events.get("playback:event")(trusted, { type: "start", track });
  events.get("playback:event")(trusted, { type: "progress", track, deltaMs: 5000 });
  assert.deepEqual(calls.started, ["jf:song"]);
  assert.equal(calls.counted.length, 1);
  const out = await handles.get("listens:pending")(trusted, 0, 500);
  assert.equal(out.listens.length, 1);
  assert.equal((await handles.get("listens:take")(trusted, theirs, { "phone-1": { name: "Pixel", kind: "phone" } })).added, 1);
  assert.equal(calls.taken.length, 1);
  assert.equal(calls.remote.length, 1);
});

test("Keep my plays off: nothing counts, nothing of the history goes out or comes in", async () => {
  const { handles, events, policy, calls } = await loadMain();
  policy.recordListening = false;
  events.get("playback:event")(trusted, { type: "start", track });
  events.get("playback:event")(trusted, { type: "progress", track, deltaMs: 5000 });
  events.get("playback:event")(trusted, { type: "stop", track, deltaMs: 90_000 });
  assert.deepEqual(calls.counted, []);
  assert.deepEqual(calls.started, []);
  const out = await handles.get("listens:pending")(trusted, 0, 500);
  assert.deepEqual([out.total, out.listens.length], [1, 0], "how many there are, none handed out");
  assert.equal((await handles.get("listens:take")(trusted, theirs, {})).added, 0);
  assert.deepEqual(calls.taken, []);
  assert.deepEqual(calls.remote, []);
  // Back on: counted again from the next play.
  policy.recordListening = true;
  events.get("playback:event")(trusted, { type: "progress", track, deltaMs: 5000 });
  assert.equal(calls.counted.length, 1);
});
