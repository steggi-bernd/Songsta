/**
 * Updating from inside the app, on Windows. The installer and its checksum come from the newest GitHub release
 * (electron-updater reads latest.yml there). A finished download waits: it goes in when the app closes, after
 * everything is saved, or at once on a press of "Restart now". Music is never interrupted for it.
 *
 * Elsewhere the note leads to the release page: macOS doesn't take an unsigned update, a .deb needs a password,
 * and the AppImage's way of replacing itself hasn't been tried on a real Linux yet.
 */
import { app } from "electron";
import type { AppUpdater } from "electron-updater";
import { isNewerVersion, latestVersion, NO_UPDATE, type UpdateState } from "../src/lib/newVersion";

const canInstall = !!app.isPackaged && process.platform === "win32";

let state: UpdateState = { ...NO_UPDATE, canInstall };
let announce: (state: UpdateState) => void = () => undefined;
let restartAfter = false;
let updater: AppUpdater | null = null;

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  announce(state);
}

/** Loaded when first needed: the start of the app has better things to do. */
function loadUpdater(): AppUpdater {
  if (updater) return updater;
  const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
  autoUpdater.autoDownload = false;
  // The installer starts on "quit" below, when the app has saved everything, not while it still writes.
  autoUpdater.autoInstallOnAppQuit = false;
  // Left alone, every request would carry a random id kept for this install. Nothing here needs one.
  autoUpdater.requestHeaders = { "x-user-staging-id": "none" };
  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    const percent = Math.floor(progress.percent);
    if (percent !== state.percent) set({ percent });
  });
  updater = autoUpdater;
  return autoUpdater;
}

export function configureAppUpdate(onChange: (state: UpdateState) => void): void {
  announce = onChange;
  if (!canInstall) return;
  // The last thing the app does. A crash doesn't get here with 0, and then it isn't the moment.
  app.on("quit", (_event, exitCode) => {
    if (exitCode === 0 && state.phase === "ready") updater?.quitAndInstall(true, restartAfter);
  });
}

export function updateState(): UpdateState {
  return state;
}

/** The newest version there is. A release without its update files (yet) still has a number on GitHub. */
export async function latestKnown(): Promise<string | null> {
  if (canInstall) {
    try {
      const found = await loadUpdater().checkForUpdates();
      if (found) return found.updateInfo.version;
    } catch {
      /* the plain question below */
    }
  }
  return latestVersion();
}

/** Fetches the newest version; it then waits for the app to close. */
export async function startUpdate(): Promise<void> {
  if (!canInstall || state.phase === "downloading") return;
  set({ phase: "downloading", percent: 0 });
  try {
    const loaded = loadUpdater();
    const found = await loaded.checkForUpdates();
    const version = found?.updateInfo.version ?? "";
    if (!isNewerVersion(version, app.getVersion())) {
      set({ phase: "none", version: "", percent: 0 });
      return;
    }
    set({ version });
    await loaded.downloadUpdate();
    set({ phase: "ready", percent: 100 });
  } catch (err) {
    console.warn("[bytune] update failed:", err);
    set({ phase: "failed" });
  }
}

/** "Restart now": the normal way out, so everything is saved, and the new version opens by itself. */
export function installUpdate(): void {
  if (state.phase !== "ready") return;
  restartAfter = true;
  app.quit();
}
