/** The phone's share of the new-version hint (lib/newVersion.ts): the look now and then, the notes, and fetching the new APK for Android to install. */
import { AppState, Linking } from "react-native";
import { create } from "zustand";
import Player from "../modules/media3-player";
import {
  isNewerVersion,
  latestApk,
  latestVersion,
  lookForNewVersion,
  NEW_VERSION_FIRST_LOOK_MS,
  NEW_VERSION_LOOK_EVERY_MS,
  RELEASE_PAGE,
  T,
  type ReleaseApk,
} from "./shared";
import { useConnection } from "./stores/connection";
import { showDialog, toast } from "./stores/popups";
import { useSettings } from "./stores/settings";

export const APP_VERSION = "1.4.0";

export function openReleasePage(): void {
  void Linking.openURL(RELEASE_PAGE).catch(() => undefined);
}

/** The newer version there is, while the hints are on. */
export function useNewerVersion(): string | null {
  const on = useSettings((s) => s.checkNewVersion);
  const latest = useSettings((s) => s.newVersion.latest);
  return on && isNewerVersion(latest, APP_VERSION) ? latest : null;
}

interface PhoneUpdate {
  phase: "none" | "downloading" | "ready" | "failed";
  /** the version it's about, once that's known */
  version: string;
  percent: number;
  /** the fetched APK */
  file: string;
}

export const usePhoneUpdate = create<PhoneUpdate>(() => ({ phase: "none", version: "", percent: 0, file: "" }));

function fetchApk(apk: ReleaseApk): void {
  usePhoneUpdate.setState({ phase: "downloading", version: apk.version, percent: 0, file: "" });
  void Player.appUpdateFetch(apk.url, `Songsta-${apk.version}.apk`, apk.sha256, apk.size).catch(() => usePhoneUpdate.setState({ phase: "failed" }));
}

/** Hands the fetched APK to Android, which asks before it installs anything. */
export function installPhoneUpdate(): void {
  const { file } = usePhoneUpdate.getState();
  if (file) void Player.appUpdateInstall(file).catch(() => usePhoneUpdate.setState({ phase: "failed", file: "" }));
}

let asking = false;

/** The press on the new version: its size counts on mobile data, so that's asked first. */
export async function updatePhone(): Promise<void> {
  if (asking || usePhoneUpdate.getState().phase === "downloading") return;
  asking = true;
  byItself = false;
  try {
    const apk = await latestApk();
    if (!apk || !isNewerVersion(apk.version, APP_VERSION)) {
      usePhoneUpdate.setState({ phase: "failed" });
      return;
    }
    if (!useConnection.getState().metered) {
      fetchApk(apk);
      return;
    }
    showDialog(
      T("You're on mobile data"),
      apk.size ? T("The update is {size} MB.", { size: Math.ceil(apk.size / 1_000_000) }) : undefined,
      [{ text: T("Cancel"), style: "cancel" }, { text: T("Use mobile data"), onPress: () => fetchApk(apk) }],
      { cancelable: true }
    );
  } finally {
    asking = false;
  }
}

/** "Look for updates": the same look without waiting for the day to be over. */
export async function lookNow(): Promise<void> {
  const settings = useSettings.getState();
  const { memory } = await lookForNewVersion(APP_VERSION, { ...settings.newVersion, checkedAt: 0 }, Date.now(), latestVersion);
  if (!memory.checkedAt) {
    toast(T("GitHub didn't answer. Try again later."), true);
    return;
  }
  useSettings.getState().change({ newVersion: memory });
  if (isNewerVersion(memory.latest, APP_VERSION)) {
    // With the hints off it still has to show, the one who pressed wants to know.
    usePhoneUpdate.setState({ version: memory.latest });
    toast(T("Songsta {version} is out, more in Settings", { version: memory.latest }), true);
    void fetchIfDue();
  } else {
    usePhoneUpdate.setState({ phase: "none", version: "", percent: 0, file: "" });
    toast(T("You have the newest version"));
  }
}

/** Fetched by itself: the one who pressed isn't waiting for it, so a failure stays quiet and Android is only called when it's allowed to come up. */
let byItself = false;
/** Android has been asked about this version, in this run. */
let offered = "";

/** On Wi-Fi it fetches a new version by itself; Android asks before it goes in. */
async function fetchIfDue(): Promise<void> {
  const { autoUpdate, newVersion } = useSettings.getState();
  const { phase } = usePhoneUpdate.getState();
  if (!autoUpdate || !isNewerVersion(newVersion.latest, APP_VERSION) || phase === "downloading" || phase === "ready" || asking) return;
  if (useConnection.getState().metered) return;
  asking = true;
  try {
    const apk = await latestApk();
    if (!apk || !isNewerVersion(apk.version, APP_VERSION) || useConnection.getState().metered) return;
    byItself = true;
    fetchApk(apk);
  } finally {
    asking = false;
  }
}

/** A version fetched by itself and ready: Android comes up once, when the app is in front and is allowed to. Otherwise the line in Settings is there for it. */
function offerIfReady(): void {
  const { phase, version } = usePhoneUpdate.getState();
  if (phase !== "ready" || !byItself || offered === version || AppState.currentState !== "active") return;
  void Player.appUpdateAllowed()
    .catch(() => false)
    .then((allowed) => {
      if (usePhoneUpdate.getState().phase !== "ready" || offered === version) return;
      offered = version;
      if (allowed) installPhoneUpdate();
      else toast(T("Songsta {version} is ready, more in Settings", { version }), true);
    });
}

export function watchNewVersion(): void {
  Player.addListener("onAppUpdate", ({ percent, file, problem }) => {
    if (percent !== undefined) usePhoneUpdate.setState({ percent });
    if (file) {
      usePhoneUpdate.setState({ phase: "ready", percent: 100, file });
      if (byItself) offerIfReady();
      // Android doesn't let an app open anything from behind; then the line in Settings is there for it.
      else if (AppState.currentState === "active") installPhoneUpdate();
      else toast(T("Songsta {version} is ready", { version: usePhoneUpdate.getState().version }), true);
    }
    if (problem) {
      usePhoneUpdate.setState({ phase: "failed" });
      if (!byItself) toast(T("Couldn't update to Songsta {version}", { version: usePhoneUpdate.getState().version }), true);
    }
  });
  AppState.addEventListener("change", (state) => {
    if (state === "active") offerIfReady();
  });
  useConnection.subscribe((s, prev) => {
    if (prev.metered && !s.metered) void fetchIfDue();
  });

  // Replaced by a new version: it says so, and the APK isn't needed anymore.
  const { lastVersion, change } = useSettings.getState();
  if (lastVersion !== APP_VERSION) {
    if (useSettings.getState().checkNewVersion && isNewerVersion(APP_VERSION, lastVersion)) toast(T("Updated to Songsta {version}", { version: APP_VERSION }), true);
    change({ lastVersion: APP_VERSION });
    void Player.appUpdateClear().catch(() => undefined);
  }

  let looking = false;
  const look = async (): Promise<void> => {
    const settings = useSettings.getState();
    if (looking || (!settings.checkNewVersion && !settings.autoUpdate)) return;
    looking = true;
    try {
      const { memory, tell } = await lookForNewVersion(APP_VERSION, settings.newVersion, Date.now(), latestVersion);
      // Hints off: nothing was said, so nothing counts as said.
      const kept = settings.checkNewVersion ? memory : { ...memory, told: settings.newVersion.told };
      if (kept.checkedAt !== settings.newVersion.checkedAt || kept.latest !== settings.newVersion.latest || kept.told !== settings.newVersion.told) useSettings.getState().change({ newVersion: kept });
      if (tell && settings.checkNewVersion) toast(T("Songsta {version} is out, more in Settings", { version: tell }), true);
      await fetchIfDue();
    } catch {
      /* no answer is no news */
    } finally {
      looking = false;
    }
  };
  setTimeout(() => void look(), NEW_VERSION_FIRST_LOOK_MS);
  setInterval(() => void look(), NEW_VERSION_LOOK_EVERY_MS);
  // Switched back on: there's no need to wait for the next hour.
  useSettings.subscribe((now, before) => {
    if ((now.checkNewVersion && !before.checkNewVersion) || (now.autoUpdate && !before.autoUpdate)) void look();
  });
}
