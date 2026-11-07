import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const require = createRequire(import.meta.url);

/**
 * Phase 10 IPC fuzz: every registered channel receives the hostile-input
 * matrix (wrong types, huge values, prototype keys, deep nesting, path
 * tricks, reserved names). Contract: a handler may reject with a controlled
 * Error, but a hostile argument must never throw a non-Error, never hang,
 * and fire-and-forget (ipc.on) handlers must never throw synchronously.
 */
const root = fileURLToPath(new URL("../electron/", import.meta.url));

async function loadIpcHandlers() {
  const source = fs.readFileSync(path.join(root, "main.ts"), "utf8");
  const { code } = await transform(source + "\nexport { registerIpc };", { loader: "ts", format: "cjs" });
  const handles = new Map();
  const events = new Map();
  const downloads = { enqueued: [], failures: [] };
  let approvedDirCount = 0;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, URL, __dirname: root,
    process: { env: {}, on() {}, platform: "win32" },
    require(name) {
      if (name === "electron") return {
        app: {
          requestSingleInstanceLock: () => false, quit() {},
          getPath: () => path.join(root, "userdata"),
        },
        protocol: { registerSchemesAsPrivileged() {} },
        ipcMain: {
          handle: (n, fn) => handles.set(n, fn),
          on: (n, fn) => events.set(n, fn),
        },
        shell: { openPath: async () => "blocked", showItemInFolder() {} },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        Menu: { setApplicationMenu() {} },
        session: { defaultSession: { webRequest: { onBeforeSendHeaders() {}, onCompleted() {} } } },
        BrowserWindow: { getAllWindows: () => [] },
      };
      if (name === "./pip") return {
        registerPipIpc() {
          handles.set("pip:toggle", (e) => e.trusted);
          handles.set("pip:isOpen", (e) => e.trusted);
          events.set("pip:close", () => {});
          events.set("pip:minimize", () => {});
          events.set("pip:show-main", () => {});
          events.set("pip:state", () => {});
          events.set("pip:command", () => {});
        },
        isTrustedSender: (e) => e?.trusted === true,
        closePip() {}, savePipRect() {}, rendererUrl: () => "file://x", restrictNavigation() {},
      };
      if (name === "./downloads") return {
        addDownloadListener() {},
        enqueueDownload: async (track) => { downloads.enqueued.push(track); return "q1"; },
        cancelDownload: () => "ok",
        queueSnapshot: () => [],
        resetDownloads: async () => {},
      };
      if (name === "./app-update") return { configureAppUpdate() {}, installUpdate() {}, latestKnown: async () => null, startUpdate: async () => {}, updateState: () => ({}) };
      if (name === "./local-library") return {
        readLocalLibrary: () => ({ folders: [], tracks: [] }),
        scanLibrary: async () => ({}),
        setLibraryFolders: async () => ({}),
        addLibraryFolders: async (paths) => { return { added: [], lib: { folders: [] } }; },
        renameLibraryFolder: async () => ({}), removeLibraryFolder: async () => ({}),
        folderStatuses: () => [], localStreamPath: () => null,
        readLocalArtThumb: () => null, readArtFile: () => null, resetLocalLibrary: async () => {},
      };
      if (name === "./canvas") return { canvasFor: async () => null };
      if (name === "./stats") return {
        initStats() {}, flushSync() {}, resetStats() {},
        noteTrackStart() {}, recordListening() {}, summary: () => ({}),
        HISTORY_STORE: "listening-history",
      };
      if (name === "./stream-proxy") return {
        proxyUrlForLocalTrack: () => null, startStreamProxy: async () => {},
      };
      if (name === "./backup") return { backupExport: async () => ({}), backupImport: async () => ({}) };
      if (name === "./data-transition") return {
        serializeData: (fn) => Promise.resolve().then(fn),
        documentScope: () => "scope", readForDocument: () => null, writeForDocument: async () => {},
        invalidateResetDocuments() {}, drainData: async () => {},
      };
      if (name === "./persist") return {
        readData: () => null, writeData: async () => {}, writeDataSync() {},
        drainWrites: async () => {}, resetAppData: async () => {}, migrateLegacyData() {},
      };
      if (name.startsWith("./")) return {};
      return require(name);
    },
  });
  module.exports.registerIpc();
  return { handles, events, downloads };
}

// Hostile argument matrix (JSON.parse for realistic prototype-key payloads).
const HOSTILE = [
  undefined, null, 42, -1, 0, NaN, true, "",
  {}, [], [null], [undefined],
  JSON.parse('{"__proto__":{"polluted":1}}'),
  JSON.parse('{"constructor":{"prototype":{"polluted":1}}}'),
  { id: JSON.parse('{"__proto__":{}}'), title: "<img src=x onerror=alert(1)>", artist: "../../etc" },
  { id: "x", title: "CON", artist: "AUX" },
  { id: "x", title: "..", artist: "..", thumb: "javascript:alert(1)" },
  "A".repeat(1_000_000),
  Array(100_000).fill("x"),
  (() => { let d = {}; let c = d; for (let i = 0; i < 2000; i++) { c.a = {}; c = c.a; } return d; })(),
  "../../../windows/system32", "C:\\Windows\\System32\\cmd.exe", "\\\\server\\share\\x", "COM1", "NUL",
  "\u202Eexe.mp3", { toString: null }, new Date("invalid"),
];

test("every IPC handler survives the hostile-input matrix without non-Error throws", async () => {
  const { handles, events, downloads } = await loadIpcHandlers();
  assert.ok(handles.size >= 25, `expected the full IPC surface, got ${handles.size}`);
  let checked = 0;
  for (const [channel, handler] of handles) {
    for (const value of HOSTILE) {
      checked++;
      const event = { trusted: false };
      let result;
      try {
        result = await Promise.race([
          Promise.resolve().then(() => handler(event, value, value, value)),
          new Promise((_, reject) => setTimeout(() => reject(new RangeError("TIMEOUT")), 2000)),
        ]);
      } catch (err) {
        // Errors thrown across the vm boundary have a foreign prototype —
        // check shape, not instanceof.
        assert.ok(err && typeof err.message === "string" && typeof err.name === "string",
          `${channel} threw non-Error ${String(err)}`);
        assert.notEqual(err.message, "TIMEOUT", `${channel} hung on ${abbrev(value)}`);
        assert.ok(
          !/Cannot read propert|is not a function|undefined is not|null is not|Cannot convert/.test(err.message),
          `${channel} leaked a raw TypeError/RangeError for ${abbrev(value)}: ${err.message}`
        );
      }
      // download:start must never enqueue outside a controlled shape
      if (channel === "download:start" && downloads.enqueued.length > 0) {
        const track = downloads.enqueued.at(-1);
        assert.equal(typeof track.id, "string", "only string-id tracks may enqueue");
      }
    }
  }
  for (const [channel, handler] of events) {
    for (const value of HOSTILE) {
      checked++;
      // Fire-and-forget listeners must not throw synchronously for any input.
      assert.doesNotThrow(() => handler({ trusted: false }, value, value, value), `${channel} (event) threw for ${abbrev(value)}`);
    }
  }
  assert.equal(({}).polluted, undefined, "Object.prototype must survive the whole matrix");
  assert.equal(String(new Object().constructor), "function Object() { [native code] }");
  console.log(`[ipc-fuzz] ${checked} hostile calls across ${handles.size} handle + ${events.size} event channels`);
});

function abbrev(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return (s ?? String(value)).slice(0, 40);
}
