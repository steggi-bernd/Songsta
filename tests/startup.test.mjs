// Songsta at sign-in (electron/startup.ts): Windows' own entry for it, under Songsta's name, for this
// very program; switched off in Windows' list it shows as such, and switching it on allows it again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const electronDir = fileURLToPath(new URL("../electron/", import.meta.url));
const out = await build({
  stdin: { contents: `export * from "./startup";`, resolveDir: electronDir, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "electron-stub",
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `export const app = { isPackaged: false, getLoginItemSettings() { throw new Error("the real one isn't asked in tests"); }, setLoginItemSettings() { throw new Error("nor written"); } };`,
          loader: "js",
        }));
      },
    },
  ],
});
const { LOGIN_ITEM_NAME, setOpenAtLogin, startupState } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

/** Windows' list of startup apps, as far as this needs it. */
function fakeWindows() {
  let entry = null;
  const writes = [];
  return {
    writes,
    switchOffInList() {
      entry = { ...entry, enabled: false };
    },
    getLoginItemSettings: (options) => ({
      openAtLogin: !!entry && entry.path === options.path,
      executableWillLaunchAtLogin: !!entry && entry.path === options.path && entry.enabled !== false,
    }),
    setLoginItemSettings: (settings) => {
      writes.push(settings);
      entry = settings.openAtLogin ? { path: settings.path, enabled: settings.enabled ?? entry?.enabled } : null;
    },
  };
}

test("off Windows, or a development run: nothing is offered and nothing written", () => {
  const windows = fakeWindows();
  assert.deepEqual(startupState(windows, false), { supported: false, openAtLogin: false, turnedOffByWindows: false });
  assert.deepEqual(setOpenAtLogin(true, windows, false), { supported: false, openAtLogin: false, turnedOffByWindows: false });
  assert.equal(windows.writes.length, 0);
});

test("on: Windows' entry under Songsta's name, for this very program, allowed in the list", () => {
  const windows = fakeWindows();
  assert.deepEqual(startupState(windows, true), { supported: true, openAtLogin: false, turnedOffByWindows: false });
  const state = setOpenAtLogin(true, windows, true);
  assert.deepEqual(state, { supported: true, openAtLogin: true, turnedOffByWindows: false });
  assert.deepEqual(windows.writes, [{ path: process.execPath, args: [], name: LOGIN_ITEM_NAME, openAtLogin: true, enabled: true }]);
  assert.equal(LOGIN_ITEM_NAME, "Songsta", "the uninstaller removes the entry under this name");
});

test("switched off in Windows' list it says so; switching it on here allows it again", () => {
  const windows = fakeWindows();
  setOpenAtLogin(true, windows, true);
  windows.switchOffInList();
  assert.deepEqual(startupState(windows, true), { supported: true, openAtLogin: true, turnedOffByWindows: true });
  assert.deepEqual(setOpenAtLogin(true, windows, true), { supported: true, openAtLogin: true, turnedOffByWindows: false });
});

test("off: the entry goes, and the list isn't touched", () => {
  const windows = fakeWindows();
  setOpenAtLogin(true, windows, true);
  assert.deepEqual(setOpenAtLogin(false, windows, true), { supported: true, openAtLogin: false, turnedOffByWindows: false });
  assert.deepEqual(windows.writes.at(-1), { path: process.execPath, args: [], name: LOGIN_ITEM_NAME, openAtLogin: false });
});
