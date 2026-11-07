import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
async function load(name, dir, mocks = {}, globals = {}) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(`../electron/${name}.ts`, import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["electron", "./persist", "./jellyfin", "./subsonic"],
    plugins: [{ name: "metadata-mock", setup(build) {
      build.onResolve({ filter: /^music-metadata$/ }, () => ({ path: "metadata", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const parseFile = (...args) => globalThis.__parseFile(...args);" }));
    } }],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, setTimeout, clearTimeout, console, Buffer, AbortController,
    require(name) {
      if (name === "electron") return { app: { getPath: () => dir } };
      return mocks[name] ?? require(name);
    },
    ...globals,
  });
  return module.exports;
}

test("sync write wins over preparing and queued async snapshots; later async writes still work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-sync-"));
  const started = deferred();
  const gate = deferred();
  let first = true;
  const persist = await load("persist", dir, { fs: { ...fs, promises: { ...fs.promises,
    async writeFile(...args) {
      if (first) { first = false; started.resolve(); await gate.promise; }
      return fs.promises.writeFile(...args);
    },
    rename() { throw new Error("async commits must not be used"); },
    copyFile() { throw new Error("async commits must not be used"); },
  } } });
  try {
    const old = persist.writeData("library", { revision: 1 });
    await started.promise;
    const queued = persist.writeData("lib/rary", { revision: 2 });
    persist.writeDataSync("library", { revision: 3 });
    gate.resolve();
    await Promise.all([old, queued]);
    assert.equal(persist.readData("library").revision, 3);
    await persist.writeData("library", { revision: 4 });
    assert.equal(persist.readData("library").revision, 4);
    assert.equal(fs.readdirSync(path.join(dir, "data")).some((f) => f.endsWith(".tmp")), false);
  } finally {
    gate.resolve();
    await persist.drainWrites();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a sync write during rename retry invalidates the async fallback commit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-retry-"));
  const retry = deferred();
  let allowRename = false;
  const timers = [];
  const persist = await load("persist", dir, { fs: { ...fs,
    renameSync(...args) {
      if (!allowRename) throw Object.assign(new Error("locked"), { code: "EPERM" });
      return fs.renameSync(...args);
    },
  } }, { setTimeout(fn) { timers.push(fn); retry.resolve(); } });
  try {
    const older = persist.writeData("sync-meta", { revision: 1 });
    await retry.promise;
    persist.writeDataSync("sync-meta", { revision: 2 }); // uses copy fallback
    allowRename = true;
    timers.shift()();
    await older;
    assert.equal(persist.readData("sync-meta").revision, 2);
  } finally {
    for (const fn of timers) fn();
    await persist.drainWrites();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed writes do not poison the per-file queue", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-failure-"));
  let fail = true;
  const persist = await load("persist", dir, { fs: { ...fs, promises: { ...fs.promises,
    async writeFile(...args) {
      if (fail) { fail = false; throw new Error("disk unavailable"); }
      return fs.promises.writeFile(...args);
    },
  } } });
  try {
    const first = assert.rejects(persist.writeData("library", { revision: 1 }), /disk unavailable/);
    const second = persist.writeData("library", { revision: 2 });
    await Promise.all([first, second]);
    assert.equal(persist.readData("library").revision, 2);
  } finally {
    await persist.drainWrites();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset drains old writes, blocks new writes and removes ownership archives but not audio or unrelated stores", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-drain-"));
  const started = deferred();
  const gate = deferred();
  let hold = false;
  const persist = await load("persist", dir, { fs: { ...fs, promises: { ...fs.promises,
    async writeFile(...args) {
      if (hold) { hold = false; started.resolve(); await gate.promise; }
      return fs.promises.writeFile(...args);
    },
  } } });
  try {
    const archive = `owner-${"a".repeat(64)}-library`;
    await persist.writeData(archive, { secret: true });
    await persist.writeData("data-owner", { owner: "old" });
    await persist.writeData("unrelated", { keep: true });
    fs.mkdirSync(path.join(dir, "local-art"));
    fs.writeFileSync(path.join(dir, "local-art", "cover.jpg"), "cover");
    // Pre-merge cloud snapshots hold account-owned payloads — a reset must
    // not leave them recoverable on disk.
    const backups = path.join(dir, "data", "backups");
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, "library-2026-01-01.json"), JSON.stringify({ state: { liked: [{ id: "x" }] } }));
    fs.writeFileSync(path.join(dir, "audio.mp3"), "audio");
    hold = true;
    const old = persist.writeData("library", { revision: 1 });
    await started.promise;
    const queued = persist.writeData(archive, { secret: "queued" });
    let finished = false;
    const reset = persist.resetAppData().then(() => { finished = true; });
    const concurrentReset = persist.resetAppData();
    await assert.rejects(persist.writeData("library", { stale: true }), /reset in progress/);
    assert.throws(() => persist.writeDataSync("library", { stale: true }), /reset in progress/);
    await new Promise((r) => setImmediate(r));
    assert.equal(finished, false, "reset must await the actual in-flight temp write");
    gate.resolve();
    await Promise.all([old, queued, reset, concurrentReset]);
    for (const name of ["library", "data-owner", archive]) assert.equal(persist.readData(name), null);
    assert.equal(persist.readData("unrelated").keep, true);
    assert.equal(fs.readFileSync(path.join(dir, "audio.mp3"), "utf8"), "audio");
    assert.equal(fs.existsSync(path.join(dir, "local-art")), false);
    assert.equal(fs.existsSync(backups), false, "reset must remove pre-merge cloud snapshots");
    assert.equal(fs.readdirSync(path.join(dir, "data")).some((f) => f.endsWith(".tmp")), false);
    await persist.writeData("approved-dirs", ["default"]);
    assert.equal(persist.readData("approved-dirs")[0], "default");
  } finally {
    gate.resolve();
    await persist.drainWrites();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset surfaces deletion failures rather than reporting a complete reset", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-locked-"));
  let locked = true;
  const persist = await load("persist", dir, { fs: { ...fs, promises: { ...fs.promises,
    async unlink(file) {
      if (locked && file.endsWith("library.json")) throw Object.assign(new Error("locked"), { code: "EPERM" });
      return fs.promises.unlink(file);
    },
  } } });
  try {
    persist.writeDataSync("library", { old: true });
    await assert.rejects(persist.resetAppData(), /locked/);
    locked = false;
    await persist.resetAppData();
    assert.equal(persist.readData("library"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset invalidates a paused metadata scan before artwork, save or progress", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-scan-"));
  const started = deferred();
  const gate = deferred();
  const persist = await load("persist", dir);
  const progress = [];
  const library = await load("local-library", dir, { "./persist": persist }, {
    __parseFile: async () => { started.resolve(); await gate.promise; return {
      common: { picture: [{ data: new Uint8Array([1]), format: "image/jpeg" }] }, format: { duration: 120 },
    }; },
  });
  try {
    const music = path.join(dir, "music");
    fs.mkdirSync(music);
    fs.writeFileSync(path.join(music, "song.mp3"), "user audio");
    await library.addLibraryFolders([music]);
    const scan = library.scanLibrary(false, (...args) => progress.push(args));
    const cancelled = assert.rejects(scan, /cancelled by reset/);
    await started.promise;
    await library.resetLocalLibrary();
    await persist.resetAppData();
    gate.resolve();
    await cancelled;
    assert.equal(persist.readData("local-library"), null);
    assert.equal(fs.existsSync(path.join(dir, "local-art")), false);
    assert.equal(progress.length, 0);
    assert.equal(fs.readFileSync(path.join(music, "song.mp3"), "utf8"), "user audio");
    await library.addLibraryFolders([music]);
    const fresh = await library.scanLibrary(false);
    assert.equal(fresh.tracks.length, 1, "new scans still work after reset");
  } finally {
    gate.resolve();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset cancels an in-flight download, cleans only its partial file, and drops queued work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-download-"));
  const progress = deferred();
  const events = [];
  const fetched = [];
  const completed = path.join(dir, "completed.m4a");
  fs.writeFileSync(completed, "user's completed audio");
  const downloads = await load("downloads", dir, {
    "./jellyfin": { originalFile: (id) => ({ url: "https://example.invalid/" + id, headers: {}, ext: ".flac" }) },
    "./subsonic": { originalFile: () => { throw new Error("no Navidrome in this test"); } },
  }, {
    fetch: async (url) => {
      fetched.push(url);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); } }));
    },
  });
  downloads.addDownloadListener((event) => {
    events.push(event);
    if (event.type === "progress") progress.resolve();
  });
  const track = (id) => ({ id, artist: "Artist", title: id, album: "Album" });
  const files = (at) => fs.readdirSync(at, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(at, e.name)) : [e.name]));
  try {
    downloads.enqueueDownload(track("jf:running"), dir);
    downloads.enqueueDownload(track("jf:second"), dir);
    downloads.enqueueDownload(track("jf:queued"), dir);
    await progress.promise;
    // Exercise the actual reset API while the response body is still open.
    await downloads.resetDownloads();
    await new Promise((r) => setImmediate(r));
    assert.equal(downloads.queueSnapshot().length, 0);
    assert.equal(fs.readFileSync(completed, "utf8"), "user's completed audio");
    assert.deepEqual(files(dir), ["completed.m4a"], "no partial file stays behind");
    assert.ok(!fetched.some((url) => url.includes("queued")), "queued work must not fetch");
    assert.equal(events.filter((e) => e.type === "done").length, 0);
    assert.equal(events.filter((e) => e.type === "cancelled").length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only songs on a server can be downloaded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-download-"));
  const downloads = await load("downloads", dir, {
    "./jellyfin": { originalFile: () => { throw new Error("no server in this test"); } },
    "./subsonic": { originalFile: () => { throw new Error("no server in this test"); } },
  });
  try {
    assert.throws(() => downloads.enqueueDownload({ id: "dQw4w9WgXcQ", title: "Old", artist: "A" }, dir), /Only songs on a server/);
    assert.throws(() => downloads.enqueueDownload({ id: "local:abc", title: "Local", artist: "A" }, dir), /Only songs on a server/);
    assert.equal(downloads.queueSnapshot().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
