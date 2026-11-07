/** The desktop's share of the new-version hint (lib/newVersion.ts): the look now and then, the notes, updating from inside the app. */
import { create } from "zustand";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import { T } from "./i18n";
import {
  isNewerVersion,
  lookForNewVersion,
  NEW_VERSION_FIRST_LOOK_MS,
  NEW_VERSION_LOOK_EVERY_MS,
  NO_UPDATE,
  RELEASE_PAGE,
  shouldFetchUpdate,
  type UpdateState,
} from "./newVersion";

/** Where updating from inside the app stands (electron/app-update.ts). */
export const useAppUpdate = create<UpdateState>(() => NO_UPDATE);

/** Opens in the system browser (the main window's open handler). */
export function openReleasePage(): void {
  window.open(RELEASE_PAGE, "_blank");
}

/** The note about a failure comes once per version, unless someone pressed for another try. */
let failureTold = "";
/** Somebody pressed for this: whatever the hints say, they get an answer. */
let pressed = false;

export function startUpdate(): void {
  failureTold = "";
  pressed = true;
  void window.bytune?.startUpdate();
}

export function installUpdate(): void {
  void window.bytune?.installUpdate();
}

/** The newer version there is, while the hints are on. */
export function useNewerVersion(): string | null {
  const on = useSettings((s) => s.checkNewVersion);
  const latest = useSettings((s) => s.newVersion.latest);
  const current = window.bytune?.versions.app ?? "";
  return on && isNewerVersion(latest, current) ? latest : null;
}

function tellItsReady(version: string): void {
  useUI.getState().toast(T("Songsta {version} is ready. It installs when you close Songsta.", { version }), "info", 15_000, {
    label: T("Restart now"),
    run: installUpdate,
  });
}

function tellItsOut(version: string): void {
  const action = useAppUpdate.getState().canInstall
    ? { label: T("Update"), run: startUpdate }
    : { label: T("Download"), run: openReleasePage };
  useUI.getState().toast(T("Songsta {version} is out", { version }), "info", 12_000, action);
}

const fetchesByItself = (): boolean => useAppUpdate.getState().canInstall && useSettings.getState().autoUpdate;

function fetchIfDue(): void {
  const current = window.bytune?.versions.app ?? "";
  if (shouldFetchUpdate(useSettings.getState().newVersion.latest, current, useAppUpdate.getState(), fetchesByItself())) {
    void window.bytune?.startUpdate();
  }
}

/** "Look for updates": the same look without waiting for the day to be over. */
export async function lookNow(): Promise<void> {
  const bridge = window.bytune;
  if (!bridge) return;
  const settings = useSettings.getState();
  const { toast } = useUI.getState();
  const { memory } = await lookForNewVersion(bridge.versions.app, { ...settings.newVersion, checkedAt: 0 }, Date.now(), () => bridge.latestVersion());
  if (!memory.checkedAt) {
    toast(T("GitHub didn't answer. Try again later."), "error");
    return;
  }
  useSettings.getState().setNewVersion(memory);
  if (!isNewerVersion(memory.latest, bridge.versions.app)) {
    toast(T("You have the newest version"));
    return;
  }
  // Whoever pressed gets an answer now; the row at the top of Settings may be out of sight.
  const update = useAppUpdate.getState();
  if (update.phase === "ready" && !isNewerVersion(memory.latest, update.version)) {
    tellItsReady(update.version);
  } else if (fetchesByItself()) {
    pressed = true;
    toast(T("Downloading Songsta {version}", { version: memory.latest }));
    fetchIfDue();
  } else {
    tellItsOut(memory.latest);
  }
}

export function watchNewVersion(): () => void {
  const bridge = window.bytune;
  if (!bridge) return () => undefined;
  const hearState = (next: UpdateState): void => {
    const before = useAppUpdate.getState();
    useAppUpdate.setState(next);
    if (next.phase === before.phase) return;
    const { toast } = useUI.getState();
    // With the hints off it goes on quietly, unless somebody is waiting for it.
    const say = pressed || useSettings.getState().checkNewVersion;
    if (next.phase === "ready") {
      if (say) tellItsReady(next.version);
      pressed = false;
    } else if (next.phase === "failed") {
      const version = next.version || useSettings.getState().newVersion.latest;
      if (say && failureTold !== version) {
        failureTold = version;
        toast(T("Couldn't update to Songsta {version}", { version }), "error", 12_000, { label: T("Download page"), run: openReleasePage });
      }
      pressed = false;
    }
  };
  const offState = bridge.onUpdateState(hearState);
  void bridge.updateState().then((known) => {
    if (useAppUpdate.getState() === NO_UPDATE) useAppUpdate.setState(known);
  });

  // An update that went in when the app closed says so at the next start.
  const sayIfUpdated = (): void => {
    const current = bridge.versions.app;
    const { lastVersion, setLastVersion } = useSettings.getState();
    if (lastVersion === current) return;
    if (useSettings.getState().checkNewVersion && isNewerVersion(current, lastVersion)) {
      useUI.getState().toast(T("Updated to Songsta {version}", { version: current }), "info", 12_000, { label: T("What's new"), run: openReleasePage });
    }
    setLastVersion(current);
  };
  if (useSettings.persist.hasHydrated()) sayIfUpdated();
  else useSettings.persist.onFinishHydration(sayIfUpdated);

  let looking = false;
  const look = async (): Promise<void> => {
    const settings = useSettings.getState();
    if (looking || (!settings.checkNewVersion && !fetchesByItself())) return;
    looking = true;
    try {
      const { memory, tell } = await lookForNewVersion(bridge.versions.app, settings.newVersion, Date.now(), () => bridge.latestVersion());
      // Hints off: nothing was said, so nothing counts as said.
      useSettings.getState().setNewVersion(settings.checkNewVersion ? memory : { ...memory, told: settings.newVersion.told });
      // Fetched by itself, it's the note that it's ready that counts.
      if (tell && settings.checkNewVersion && !fetchesByItself()) tellItsOut(tell);
      fetchIfDue();
    } catch {
      /* no answer is no news */
    } finally {
      looking = false;
    }
  };
  const first = setTimeout(() => void look(), NEW_VERSION_FIRST_LOOK_MS);
  const every = setInterval(() => void look(), NEW_VERSION_LOOK_EVERY_MS);
  // Switched back on: there's no need to wait for the next hour.
  const off = useSettings.subscribe((now, before) => {
    if ((now.checkNewVersion && !before.checkNewVersion) || (now.autoUpdate && !before.autoUpdate)) void look();
  });
  return () => {
    clearTimeout(first);
    clearInterval(every);
    off();
    offState();
  };
}
