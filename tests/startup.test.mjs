// Songsta at sign-in (electron/startup.ts): Windows' own entry for it, under Songsta's name, for this
// very program; switched off in Windows' list it shows as such, and switching it on allows it again.
// The stand-in answers as Electron 44 really does, faults included (both kept the switch from moving).
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

/** Where the installer puts Songsta for the user: with a space in it. */
const INSTALLED = "C:\\Users\\Alex\\AppData\\Local\\Programs\\ByTune Local\\Songsta\\Songsta.exe";
const PLAIN = "C:\\Songsta\\Songsta.exe";
const MODEL_ID = "electron.app.Songsta";

/**
 * Windows' list of startup apps (the user's Run key and its StartupApproved switch), answered the way
 * Electron answers (shell/browser/browser_win.cc, checked with a probe of real Electron 44):
 *  - an entry is written under `name`, else under the app's model id;
 *  - `openAtLogin` is read only under the model id;
 *  - `launchItems` are the entries whose program is the one asked about, under any name, but the path
 *    asked about is read as a command line: unquoted, it ends at its first space.
 */
function fakeWindows() {
  const run = new Map();
  const writes = [];
  const programOf = (path) => (path.startsWith('"') ? path.slice(1, path.indexOf('"', 1)) : path.split(" ")[0]);
  return {
    writes,
    run,
    switchOffInList(name = LOGIN_ITEM_NAME) {
      run.set(name, { ...run.get(name), enabled: false });
    },
    getLoginItemSettings: (options) => {
      const program = programOf(options.path).toLowerCase();
      const launchItems = [...run]
        .filter(([, e]) => e.path.toLowerCase() === program)
        .map(([name, e]) => ({ name, path: e.path, args: e.args, scope: "user", enabled: e.enabled !== false }));
      const byModelId = run.get(MODEL_ID);
      return {
        openAtLogin: !!byModelId && byModelId.path === options.path && JSON.stringify(byModelId.args) === JSON.stringify(options.args ?? []),
        executableWillLaunchAtLogin: launchItems.some((item) => item.enabled),
        launchItems,
      };
    },
    setLoginItemSettings: (settings) => {
      writes.push(settings);
      const name = settings.name || MODEL_ID;
      if (settings.openAtLogin) run.set(name, { path: settings.path, args: settings.args ?? [], enabled: settings.enabled !== false });
      else run.delete(name);
    },
  };
}

test("the stand-in has Electron's faults: an entry under a name isn't openAtLogin, a spaced path isn't found unquoted", () => {
  const windows = fakeWindows();
  windows.setLoginItemSettings({ path: INSTALLED, args: [], name: LOGIN_ITEM_NAME, openAtLogin: true, enabled: true });
  assert.equal(windows.getLoginItemSettings({ path: INSTALLED, args: [] }).openAtLogin, false);
  assert.deepEqual(windows.getLoginItemSettings({ path: INSTALLED, args: [] }).launchItems, []);
  assert.equal(windows.getLoginItemSettings({ path: `"${INSTALLED}"`, args: [] }).launchItems.length, 1);
});

test("off Windows, or a development run: nothing is offered and nothing written", () => {
  const windows = fakeWindows();
  assert.deepEqual(startupState(windows, false, INSTALLED), { supported: false, openAtLogin: false, turnedOffByWindows: false });
  assert.deepEqual(setOpenAtLogin(true, windows, false, INSTALLED), { supported: false, openAtLogin: false, turnedOffByWindows: false });
  assert.equal(windows.writes.length, 0);
});

for (const exe of [INSTALLED, PLAIN]) {
  const where = exe === INSTALLED ? "installed under a path with a space" : "under a plain path";
  test(`on (${where}): the entry under Songsta's name, for this very program, and the switch stays on`, () => {
    const windows = fakeWindows();
    assert.deepEqual(startupState(windows, true, exe), { supported: true, openAtLogin: false, turnedOffByWindows: false });
    const state = setOpenAtLogin(true, windows, true, exe);
    assert.deepEqual(windows.writes, [{ path: exe, args: [], name: LOGIN_ITEM_NAME, openAtLogin: true, enabled: true }], "written with the bare path: Electron quotes it");
    assert.deepEqual(state, { supported: true, openAtLogin: true, turnedOffByWindows: false }, "the switch stays on (it sprang back off in 1.6 and 1.7)");
    assert.deepEqual(startupState(windows, true, exe), { supported: true, openAtLogin: true, turnedOffByWindows: false }, "and reads as on when Settings opens again");
  });

  test(`switched off in Windows' list it says so; switching it on here allows it again (${where})`, () => {
    const windows = fakeWindows();
    setOpenAtLogin(true, windows, true, exe);
    windows.switchOffInList();
    assert.deepEqual(startupState(windows, true, exe), { supported: true, openAtLogin: true, turnedOffByWindows: true });
    assert.deepEqual(setOpenAtLogin(true, windows, true, exe), { supported: true, openAtLogin: true, turnedOffByWindows: false });
  });

  test(`off (${where}): the entry goes, and an older one of this program under another name with it`, () => {
    const windows = fakeWindows();
    setOpenAtLogin(true, windows, true, exe);
    windows.run.set(MODEL_ID, { path: exe, args: [], enabled: true });
    windows.run.set("Spotify", { path: "C:\\Users\\x\\AppData\\Roaming\\Spotify\\Spotify.exe", args: ["--autostart"], enabled: true });
    assert.deepEqual(setOpenAtLogin(false, windows, true, exe), { supported: true, openAtLogin: false, turnedOffByWindows: false });
    assert.deepEqual([...windows.run.keys()], ["Spotify"], "another program's entry stays");
  });
}

test("another program's entry isn't Songsta's", () => {
  const windows = fakeWindows();
  windows.run.set("Spotify", { path: "C:\\Users\\x\\AppData\\Roaming\\Spotify\\Spotify.exe", args: ["--autostart"], enabled: true });
  assert.deepEqual(startupState(windows, true, INSTALLED), { supported: true, openAtLogin: false, turnedOffByWindows: false });
  assert.equal(LOGIN_ITEM_NAME, "Songsta", "the uninstaller removes the entry under this name");
});
