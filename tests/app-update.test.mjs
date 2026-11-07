// Updating from inside the desktop app: when it fetches, when the installer starts, and that a release without update
// files or a build that can't replace itself falls back to the plain hint.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../electron/app-update.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "electron-updater"],
  write: false,
});
const code = out.outputFiles[0].text;

function load({ packaged = true, platform = "win32", version = "1.4.0", latest = "1.5.0", github = "1.5.0" } = {}) {
  const quitHandlers = [];
  const calls = { quit: 0, install: [], checks: 0, downloads: 0, asked: 0 };
  const listeners = new Map();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    requestHeaders: null,
    latest,
    checkFails: false,
    downloadFails: false,
    on: (event, fn) => listeners.set(event, fn),
    checkForUpdates: async () => {
      calls.checks++;
      if (updater.checkFails) throw new Error("no latest.yml");
      return { updateInfo: { version: updater.latest } };
    },
    downloadUpdate: async () => {
      calls.downloads++;
      if (updater.downloadFails) throw new Error("connection lost");
      listeners.get("download-progress")?.({ percent: 41.7 });
      listeners.get("download-progress")?.({ percent: 41.9 });
      return ["installer.exe"];
    },
    quitAndInstall: (silent, runAfter) => calls.install.push({ silent, runAfter }),
  };
  const app = {
    isPackaged: packaged,
    getVersion: () => version,
    on: (event, fn) => event === "quit" && quitHandlers.push(fn),
    quit: () => calls.quit++,
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    console: { warn() {}, log() {}, error() {} },
    process: { platform, env: {} },
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => {
      calls.asked++;
      return { ok: true, json: async () => ({ tag_name: `v${github}` }) };
    },
    require: (name) => {
      if (name === "electron") return { app };
      if (name === "electron-updater") return { autoUpdater: updater };
      throw new Error(`unexpected require: ${name}`);
    },
  });
  const states = [];
  const api = module.exports;
  api.configureAppUpdate((s) => states.push({ ...s }));
  const closeApp = (exitCode = 0) => quitHandlers.forEach((fn) => fn({}, exitCode));
  return { api, updater, calls, states, closeApp, phases: () => states.map((s) => s.phase) };
}

test("a build that can't replace itself says so and asks GitHub for the number alone", async () => {
  for (const options of [{ packaged: false }, { platform: "darwin" }, { platform: "linux" }]) {
    const { api, calls, closeApp } = load(options);
    assert.equal(api.updateState().canInstall, false);
    assert.equal(await api.latestKnown(), "1.5.0");
    assert.equal(calls.asked, 1);
    assert.equal(calls.checks, 0, "the updater isn't touched");
    await api.startUpdate();
    api.installUpdate();
    closeApp();
    assert.equal(api.updateState().phase, "none");
    assert.equal(calls.downloads, 0);
    assert.deepEqual(calls.install, []);
    assert.equal(calls.quit, 0);
  }
});

test("Windows: the updater knows the newest version, and nothing is fetched by asking", async () => {
  const { api, calls, updater } = load();
  assert.equal(api.updateState().canInstall, true);
  assert.equal(await api.latestKnown(), "1.5.0");
  assert.equal(calls.asked, 0, "no second question");
  assert.equal(calls.downloads, 0);
  assert.equal(updater.autoDownload, false, "it only fetches when told");
  assert.equal(updater.autoInstallOnAppQuit, false, "the installer starts here, after everything is saved");
  assert.deepEqual({ ...updater.requestHeaders }, { "x-user-staging-id": "none" }, "no id of this install goes along");
});

test("a release without its update files still has a number", async () => {
  const { api, calls, updater } = load({ github: "1.6.0" });
  updater.checkFails = true;
  assert.equal(await api.latestKnown(), "1.6.0");
  assert.equal(calls.asked, 1);
});

test("fetching: progress, then ready, and it waits", async () => {
  const { api, calls, states, phases } = load();
  await api.startUpdate();
  assert.deepEqual([...new Set(phases())], ["downloading", "ready"]);
  assert.ok(states.some((s) => s.percent === 41), "the percent is heard");
  assert.equal(states.filter((s) => s.percent === 41).length, 1, "once per percent");
  assert.equal(api.updateState().version, "1.5.0");
  assert.equal(api.updateState().percent, 100);
  assert.deepEqual(calls.install, [], "nothing installs while the app runs");
  assert.equal(calls.quit, 0, "and nothing closes it");
});

test("already the newest: nothing to fetch", async () => {
  const { api, calls } = load({ latest: "1.4.0" });
  await api.startUpdate();
  assert.equal(calls.downloads, 0);
  assert.equal(api.updateState().phase, "none");
  assert.equal(api.updateState().version, "");
});

test("a download that fails says so and can be tried again", async () => {
  const { api, updater, calls } = load();
  updater.downloadFails = true;
  await api.startUpdate();
  assert.equal(api.updateState().phase, "failed");
  assert.equal(api.updateState().version, "1.5.0", "it knows what it was after");
  updater.downloadFails = false;
  await api.startUpdate();
  assert.equal(api.updateState().phase, "ready");
  assert.equal(calls.downloads, 2);
});

test("no check, no download: it fails instead of hanging", async () => {
  const { api, updater, calls } = load();
  updater.checkFails = true;
  await api.startUpdate();
  assert.equal(api.updateState().phase, "failed");
  assert.equal(calls.downloads, 0);
});

test("two presses, one download", async () => {
  const { api, calls } = load();
  await Promise.all([api.startUpdate(), api.startUpdate()]);
  assert.equal(calls.downloads, 1);
});

test("closing the app puts it in, quietly, without opening again", async () => {
  const { api, calls, closeApp } = load();
  await api.startUpdate();
  closeApp();
  assert.deepEqual(calls.install, [{ silent: true, runAfter: false }]);
});

test("Restart now: the normal way out, and the new version opens", async () => {
  const { api, calls, closeApp } = load();
  api.installUpdate();
  assert.equal(calls.quit, 0, "nothing to restart for yet");
  await api.startUpdate();
  api.installUpdate();
  assert.equal(calls.quit, 1, "the app closes as it always does, so everything is saved");
  assert.deepEqual(calls.install, [], "and only then");
  closeApp();
  assert.deepEqual(calls.install, [{ silent: true, runAfter: true }]);
});

test("nothing ready, or a crash: closing installs nothing", async () => {
  const { api, calls, closeApp, updater } = load();
  closeApp();
  assert.deepEqual(calls.install, []);
  updater.downloadFails = true;
  await api.startUpdate();
  closeApp();
  assert.deepEqual(calls.install, []);
  updater.downloadFails = false;
  await api.startUpdate();
  closeApp(1);
  assert.deepEqual(calls.install, [], "not with the app going down");
});
