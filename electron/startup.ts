/**
 * Songsta at sign-in, on Windows. A switch in Settings writes Windows' own entry for it, the
 * one Spotify uses too ("Run" in the user's part of the registry), and Windows then opens the
 * app with its window when the user signs in. Windows' own list of startup apps (Task Manager,
 * Settings → Apps → Startup) can turn the entry off: Settings says so, and switching it on
 * there turns it back on.
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
const entry = (): { path: string; args: string[] } => ({ path: process.execPath, args: [] });

export function startupState(items: LoginItems = app, supported = canStartWithWindows()): StartupState {
  if (!supported) return { supported: false, openAtLogin: false, turnedOffByWindows: false };
  const settings = items.getLoginItemSettings(entry());
  return {
    supported: true,
    openAtLogin: settings.openAtLogin,
    turnedOffByWindows: settings.openAtLogin && settings.executableWillLaunchAtLogin === false,
  };
}

/** On: the entry, and allowed in Windows' list again if it was switched off there. Off: the entry goes. */
export function setOpenAtLogin(on: boolean, items: LoginItems = app, supported = canStartWithWindows()): StartupState {
  if (supported) {
    items.setLoginItemSettings({ ...entry(), name: LOGIN_ITEM_NAME, openAtLogin: on, ...(on ? { enabled: true } : {}) });
  }
  return startupState(items, supported);
}
