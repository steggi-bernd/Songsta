import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transform, build } from "esbuild";
const require = createRequire(import.meta.url);

test("actual main reset IPC clears files and stops the real stats timer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-reset-handler-"));
  const handlers = new Map();
  const electron = {
    app: { getPath: () => dir, requestSingleInstanceLock: () => false, quit() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle(name, fn) { handlers.set(name, fn); }, on() {} },
  };
  const loaded = {};
  async function load(name, suffix = "") {
    const source = fs.readFileSync(fileURLToPath(new URL(`../electron/${name}.ts`, import.meta.url)), "utf8");
    const { code } = await transform(source + suffix, { loader: "ts", format: "cjs" });
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module, exports: module.exports, console, setTimeout, clearTimeout,
      process: { env: {}, on() {} },
      require(name) {
        if (name === "electron") return electron;
        if (name === "./app-update") return { configureAppUpdate() {}, installUpdate() {}, latestKnown: async () => null, startUpdate: async () => {}, updateState: () => ({}) };
        if (name === "./persist") return loaded.persist;
        if (name === "./stats") return loaded.stats;
        if (name === "./listens") return loaded.listens;
        if (name === "./data-transition") return loaded.transition;
        if (name === "./downloads") return { resetDownloads: async () => {}, addDownloadListener() {} };
        if (name === "./local-library") return { resetLocalLibrary: async () => {} };
        if (name === "./pip") return { registerPipIpc() {}, isTrustedSender: () => true, restrictNavigation() {}, rendererUrl: () => "http://127.0.0.1:5173/" };
        if (name.startsWith("./")) return {};
        return require(name);
      },
    });
    return module.exports;
  }
  try {
    loaded.persist = await load("persist");
    loaded.listens = await load("listens");
    loaded.stats = await load("stats");
    loaded.transition = await load("data-transition");
    const main = await load("main", "\nexport { registerIpc };\n");
    main.registerIpc();
    const invoke = (name, ...args) => handlers.get(name)({}, ...args);
    const page = await invoke("data:scope");
    await invoke("data:write", "library", { state: { liked: [{ id: "A" }] }, version: 1 }, page);
    assert.equal((await invoke("data:read", "library", page)).state.liked[0].id, "A");
    loaded.stats.initStats();
    loaded.stats.recordListening({ id: "old", title: "Old", artist: "Artist", duration: 60 }, 30_000);
    for (const name of ["listening-signals", "artist-meta-cache", "library"]) await loaded.persist.writeData(name, { old: true });
    const audio = path.join(dir, "downloaded.mp3");
    fs.writeFileSync(audio, "original audio");
    await handlers.get("app:resetData")();
    await new Promise((resolve) => setTimeout(resolve, 5_150));
    for (const name of ["listening-signals", "artist-meta-cache", "library"]) assert.equal(loaded.persist.readData(name), null);
    assert.equal(loaded.stats.summary("month").totalMs, 0);
    assert.equal(fs.existsSync(path.join(dir, "data", "stats")), false);
    assert.equal(fs.readFileSync(audio, "utf8"), "original audio");
    // A page from before the reset can't write its old state back.
    await assert.rejects(invoke("data:write", "library", { state: { liked: [{ id: "A" }] }, version: 1 }, page), /App data was reset/);
    assert.equal(loaded.persist.readData("library"), null);
  } finally {
    loaded.stats?.resetStats();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
