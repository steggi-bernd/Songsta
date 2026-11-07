/**
 * Whether a newer version is out. Both apps ask GitHub for the number of the newest release, at most once a day,
 * and say so quietly: one short note per version, then a dot on the settings button and a line in Settings for as
 * long as it lasts. On Windows the desktop app can then fetch and install it itself (electron/app-update.ts);
 * everywhere else the note leads to the release page, and the phone hands the new APK to Android.
 */
export const RELEASE_API = "https://api.github.com/repos/steggi-bernd/Songsta/releases/latest";
export const RELEASE_PAGE = "https://github.com/steggi-bernd/Songsta/releases/latest";

const ASK_EVERY_MS = 24 * 60 * 60 * 1000;
/** how often a running app sees whether that day is over */
export const NEW_VERSION_LOOK_EVERY_MS = 60 * 60 * 1000;
/** the first look comes when the start is over */
export const NEW_VERSION_FIRST_LOOK_MS = 20_000;

export interface NewVersionMemory {
  /** when GitHub last answered */
  checkedAt: number;
  /** the newest version it named */
  latest: string;
  /** the version the short note has been about */
  told: string;
}

export const NO_VERSION_MEMORY: NewVersionMemory = { checkedAt: 0, latest: "", told: "" };

/** Where updating from inside the desktop app stands. */
export interface UpdateState {
  phase: "none" | "downloading" | "ready" | "failed";
  /** the version it's about, once that's known */
  version: string;
  /** of the download, 0 to 100 */
  percent: number;
  /** this install can replace itself */
  canInstall: boolean;
}

export const NO_UPDATE: UpdateState = { phase: "none", version: "", percent: 0, canInstall: false };

function numbers(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function isNewerVersion(version: string, than: string): boolean {
  const a = numbers(version);
  const b = numbers(than);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The version number in GitHub's answer; whatever else it could say is no version. */
export function versionOfRelease(answer: unknown): string | null {
  const tag = (answer as { tag_name?: unknown } | null)?.tag_name;
  return typeof tag === "string" && numbers(tag) ? tag.trim().replace(/^v/, "") : null;
}

/** What a release says about the phone's APK; nothing while it has none (yet). */
export interface ReleaseApk {
  version: string;
  url: string;
  /** in bytes; 0 when it doesn't say */
  size: number;
  /** empty when it doesn't say */
  sha256: string;
}

export function apkOfRelease(answer: unknown): ReleaseApk | null {
  const version = versionOfRelease(answer);
  const assets = (answer as { assets?: unknown } | null)?.assets;
  if (!version || !Array.isArray(assets)) return null;
  const apk = assets.find((a) => (a as { name?: unknown } | null)?.name === "Songsta.apk") as
    | { browser_download_url?: unknown; size?: unknown; digest?: unknown }
    | undefined;
  const url = apk?.browser_download_url;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
  const digest = typeof apk?.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(apk.digest)?.[1] : null;
  return { version, url, size: typeof apk?.size === "number" && apk.size > 0 ? apk.size : 0, sha256: digest ?? "" };
}

/** The question itself: nothing about the listener goes along, and no answer is simply no news. */
async function askForRelease(): Promise<unknown> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 10_000);
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Songsta" },
      signal: stop.signal,
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function latestVersion(): Promise<string | null> {
  return versionOfRelease(await askForRelease());
}

export async function latestApk(): Promise<ReleaseApk | null> {
  return apkOfRelease(await askForRelease());
}

/** Whether to fetch the newest version without being asked. A version that's ready stays unless an even newer one is out. */
export function shouldFetchUpdate(latest: string, current: string, update: UpdateState, byItself: boolean): boolean {
  if (!byItself || !update.canInstall || !isNewerVersion(latest, current) || update.phase === "downloading") return false;
  return update.phase !== "ready" || isNewerVersion(latest, update.version);
}

/** One look: GitHub is asked only when its last answer is a day old. What to remember, and the version to say something about. */
export async function lookForNewVersion(
  current: string,
  memory: NewVersionMemory,
  now: number,
  ask: () => Promise<string | null>
): Promise<{ memory: NewVersionMemory; tell: string | null }> {
  let next = memory;
  // A clock set back would otherwise keep the next question away for as long.
  if (now - memory.checkedAt >= ASK_EVERY_MS || now < memory.checkedAt) {
    const latest = await ask();
    if (latest) next = { ...next, checkedAt: now, latest };
  }
  const tell = isNewerVersion(next.latest, current) && next.told !== next.latest ? next.latest : null;
  if (tell) next = { ...next, told: tell };
  return { memory: next, tell };
}
