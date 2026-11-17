// Updating from inside the app (electron/app-update.ts): electron-updater asks GitHub through a session
// of its own, past the gate the app's other requests pass, so GitHub's switch in Network & privacy is
// asked before it asks anything. Switched off, nothing goes to GitHub, nothing is fetched.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

const electronDir = fileURLToPath(new URL("../electron/", import.meta.url));

async function load(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-app-update-"));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify({ state: settings, version: 0 }));
  const { outputFiles } = await build({
    stdin: { contents: `export * from "./app-update"; export { setPrivacy, netActivity } from "./net-gate";`, resolveDir: electronDir, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "electron-updater"],
    write: false,
  });
  const calls = { check: 0, download: 0, fetch: 0 };
  const autoUpdater = {
    on() {},
    checkForUpdates: async () => {
      calls.check += 1;
      return { updateInfo: { version: "9.9.0" } };
    },
    downloadUpdate: async () => {
      calls.download += 1;
    },
    quitAndInstall() {},
  };
  const electron = { app: { isPackaged: true, getPath: () => root, getVersion: () => "1.7.0", on() {}, quit() {} } };
  const sandbox = {
    module: { exports: {} },
    console: { ...console, warn() {} },
    URL,
    Date,
    setTimeout,
    clearTimeout,
    Promise,
    AbortController,
    process: { platform: "win32", env: {} },
    require: (name) => (name === "electron" ? electron : name === "electron-updater" ? { autoUpdater } : require(name)),
    fetch: async () => {
      calls.fetch += 1;
      return { ok: true, json: async () => ({ tag_name: "v9.9.0" }) };
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(outputFiles[0].text, sandbox);
  return { mod: sandbox.module.exports, calls, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const [what, settings] of [
  ["GitHub switched off", { netOff: ["github"], netOwnOnly: false }],
  ["only my own servers", { netOff: [], netOwnOnly: true }],
]) {
  test(`${what}: the updater asks GitHub nothing and fetches nothing`, async () => {
    const { mod, calls, close } = await load(settings);
    try {
      assert.equal(await mod.latestKnown(), null);
      await mod.startUpdate();
      assert.deepEqual({ ...calls }, { check: 0, download: 0, fetch: 0 });
      assert.notEqual(mod.updateState().phase, "downloading");
      const log = mod.netActivity().log;
      assert.ok(log.length >= 1 && log.every((e) => e.service === "github" && e.blocked), "the connection log shows it held back");
    } finally {
      close();
    }
  });
}

test("GitHub on: the updater asks and fetches, and the log notes it; off again mid-way, nothing more", async () => {
  const { mod, calls, close } = await load({ netOff: ["genius"], netOwnOnly: false });
  try {
    assert.equal(await mod.latestKnown(), "9.9.0");
    await mod.startUpdate();
    assert.equal(calls.check, 2);
    assert.equal(calls.download, 1);
    assert.equal(mod.updateState().phase, "ready");
    assert.ok(mod.netActivity().log.some((e) => e.service === "github" && !e.blocked));
    // A ready update stays ready when GitHub is switched off afterwards; nothing else is asked.
    mod.setPrivacy({ ownOnly: false, off: ["github"], recordListening: true });
    assert.equal(await mod.latestKnown(), null);
    await mod.startUpdate();
    assert.equal(calls.check, 2);
    assert.equal(mod.updateState().phase, "ready");
  } finally {
    close();
  }
});
