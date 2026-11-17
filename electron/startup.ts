/**
 * Songsta at sign-in, on Windows. A switch in Settings writes Windows' own entry for it, the
 * one Spotify uses too ("Run" in the user's part of the registry), and Windows then opens the
 * app with its window when the user signs in. Windows' own list of startup apps (Task Manager,
 * Settings → Apps → Startup) can turn the entry off: Settings says so, and switching it on
 * there turns it back on. Whether the entry is there is read from that list (see ownEntries for the
 * two Electron faults that kept the switch from moving in 1.6 and 1.7).
 *
 * Only a packaged Windows build offers it, since a development run would put Electron itself
 * there. The uninstaller removes the entry under the same name (build/installer.nsh), an update
 * leaves it.
 */
import { app } from "electron";

/** The name the entry stands under in Windows' list; the uninstaller removes this one. */
export const LOGIN_ITEM_NAME = "Songsta";

export interface StartupState {
  /** this build can start with Windows */
  supported: boolean;
  /** the entry is there */
  openAtLogin: boolean;
  /** there, but switched off in Windows' list of startup apps */
  turnedOffByWindows: boolean;
}

/** The part of Electron's `app` this needs, so tests can stand in for Windows. */
export type LoginItems = Pick<typeof app, "getLoginItemSettings" | "setLoginItemSettings">;

function canStartWithWindows(): boolean {
  return process.platform === "win32" && app.isPackaged;
}

/** What Windows starts: this very program, with nothing on its command line. */
const entry = (exe: string): { path: string; args: string[] } => ({ path: exe, args: [] });

type LaunchItem = ReturnType<LoginItems["getLoginItemSettings"]>["launchItems"][number];

/**
 * The entries in the user's part of Windows' list that start this program, whatever their names
 * (Electron lists only those that start it). Two things Electron gets wrong are worked around, both
 * found with real Electron 44 (2026-11-15), and each alone left the switch springing back off:
 *  - its `openAtLogin` looks only under the app's model id, never under the name an entry was
 *    written with, so the list is read instead;
 *  - it reads the path it's given as a command line and cuts it at the first space, so an install
 *    under "...\ByTune Local\..." was never found: a path with a space is asked for in quotes too.
 */
function ownEntries(items: LoginItems, exe: string): LaunchItem[] {
  const found = new Map<string, LaunchItem>();
  for (const path of exe.includes(" ") ? [exe, `"${exe}"`] : [exe]) {
    for (const item of items.getLoginItemSettings({ path, args: [] }).launchItems ?? []) {
      if (item.scope === "user" && !found.has(item.name)) found.set(item.name, item);
    }
  }
  return [...found.values()];
}

export function startupState(items: LoginItems = app, supported = canStartWithWindows(), exe = process.execPath): StartupState {
  if (!supported) return { supported: false, openAtLogin: false, turnedOffByWindows: false };
  const own = ownEntries(items, exe);
  const mine = own.find((item) => item.name === LOGIN_ITEM_NAME) ?? own[0];
  return { supported: true, openAtLogin: !!mine, turnedOffByWindows: !!mine && !mine.enabled };
}

/**
 * On: the entry, and allowed in Windows' list again if it was switched off there. Off: the entry goes,
 * and with it any other that starts this program from the user's part (an older one under the model
 * id), so that off means nothing opens it at sign-in.
 */
export function setOpenAtLogin(on: boolean, items: LoginItems = app, supported = canStartWithWindows(), exe = process.execPath): StartupState {
  if (supported) {
    if (on) items.setLoginItemSettings({ ...entry(exe), name: LOGIN_ITEM_NAME, openAtLogin: true, enabled: true });
    else {
      const names = new Set([LOGIN_ITEM_NAME, ...ownEntries(items, exe).map((item) => item.name)]);
      for (const name of names) items.setLoginItemSettings({ ...entry(exe), name, openAtLogin: false });
    }
  }
  return startupState(items, supported, exe);
}
