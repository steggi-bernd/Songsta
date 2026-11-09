/**
 * Pure transforms for the backup document (export/import) — kept free of
 * Electron imports so the round-trip is unit-testable directly (see
 * tests/backup-roundtrip.test.mjs).
 *
 * The renderer's stores are persisted as zustand envelopes { state, version }
 * (see src/lib/persist.ts). The backup document, however, carries PORTABLE
 * shapes: settings as a plain key/value map and recent searches as a plain
 * string array. Reading the envelope's top level instead of its `.state` is
 * exactly what used to silently drop settings and recent searches from every
 * backup; these helpers unwrap on the way out and re-wrap on the way in.
 * Library and player stores already round-trip as envelopes untouched.
 */

/** Device-local settings a backup must never carry or overwrite: a folder, an output device, what this install has heard of. */
export const DEVICE_LOCAL_SETTINGS = new Set(["pairHinted", "localMusicFolder", "audioSinkId", "newVersion", "lastVersion", "keptLists", "setupDone", "pairedTvs"]);

/** Known settings keys — junk in, junk never out. Every setting of stores/settings.ts stands here (a test sees to that). */
export const SETTINGS_KEYS = new Set([
  "crossfadeSeconds",
  "smartFade",
  "gapless",
  "seamlessAlbums",
  "skipSilence",
  "autoplay",
  "skipEndsRepeatOne",
  "playbackSpeed",
  "audioSinkId",
  "eqEnabled",
  "eqGains",
  "eqMode",
  "peq",
  "replayGainMode",
  "replayGainTarget",
  "sidebarCollapsed",
  "libraryOrder",
  "watchFolders",
  "reduceAnimation",
  "reduceDynamicBlur",
  "liquidGlass",
  "fullBleedArtwork",
  "legacyMeshGradient",
  "animatedCanvas",
  "syncedLyrics",
  "blurUnfocusedLyrics",
  "localMusicFolder",
  "filterNonMusicAudio",
  "dontRepeatSuggestions",
  "hideVolumeBar",
  "checkNewVersion",
  "newVersion",
  "setupDone",
  "keptLists",
  "deviceLinks",
  "pairedTvs",
  "playAhead",
  "pairHinted",
  "switchOffDevices",
  "autoUpdate",
  "lastVersion",
  "discordPresence",
  "discordOwnAppId",
  "discordButton",
  "serverSync",
  "syncPlaylists",
  "serverPlays",
  "storeLinks",
  "lyricsLatin",
  "soundAnalysis",
  "exploreTab",
  "exploreLayout",
  "exploreSort",
  "rightRailWidth",
  "corners",
  "accent",
]);

/** Inner state of a persisted store: unwraps the envelope, or passes a bare map through. */
function stateOf(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const env = payload as { state?: unknown };
    if (env.state && typeof env.state === "object" && !Array.isArray(env.state)) {
      return env.state as Record<string, unknown>;
    }
    return payload as Record<string, unknown>;
  }
  return {};
}

/** The zustand envelope the renderer's persist middleware reads at hydration. */
export function envelope(state: Record<string, unknown>): { state: Record<string, unknown>; version: number } {
  return { state, version: 0 };
}

/**
 * Backup document → persisted envelope for a whole store (library, player).
 * These stores round-trip as envelopes, and writing anything else verbatim
 * used to poison the store the renderer hydrates from (an array or a bare
 * map without `state` breaks every subsequent write). Reject malformed
 * sections with the same user-facing error the document checks use.
 */
export function storeEnvelopeFromBackup(raw: unknown, name: string): { state: Record<string, unknown>; version: number } {
  const bad = (): Error => new Error(`That doesn't look like a Songsta backup (malformed ${name} section)`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad();
  const env = raw as { state?: unknown; version?: unknown };
  if (!env.state || typeof env.state !== "object" || Array.isArray(env.state)) throw bad();
  if (typeof env.version !== "number" || !Number.isFinite(env.version)) throw bad();
  return { state: env.state as Record<string, unknown>, version: env.version };
}

/** Store → backup document: whitelisted settings keys, device-local paths dropped. */
export function settingsToBackup(envelopeOrState: unknown): Record<string, unknown> {
  const state = stateOf(envelopeOrState);
  const out: Record<string, unknown> = {};
  for (const k of SETTINGS_KEYS) {
    if (DEVICE_LOCAL_SETTINGS.has(k)) continue;
    if (k in state) out[k] = state[k];
  }
  return out;
}

/**
 * Backup document → settings state to write: whitelist incoming keys, keep
 * THIS machine's device-local ones (taken from the current store).
 */
export function settingsFromBackup(incoming: unknown, currentEnvelope: unknown): Record<string, unknown> {
  const inc = stateOf(incoming);
  const cur = stateOf(currentEnvelope);
  const next: Record<string, unknown> = {};
  for (const k of SETTINGS_KEYS) {
    if (DEVICE_LOCAL_SETTINGS.has(k)) {
      if (k in cur) next[k] = cur[k];
      continue;
    }
    if (k in inc) next[k] = inc[k];
  }
  return next;
}

/** Store → backup document: recent searches as a plain string array. */
export function searchesToBackup(envelopeOrState: unknown): string[] {
  const searches = stateOf(envelopeOrState).searches;
  if (!Array.isArray(searches)) return [];
  return searches
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .slice(0, 50);
}

/**
 * Backup document → recent-searches state to write. Accepts the plain array
 * (current format) and the raw zustand envelope (what older exports actually
 * captured — previously it was silently skipped on import).
 */
export function searchesFromBackup(raw: unknown): string[] {
  const searches = Array.isArray(raw) ? raw : stateOf(raw).searches;
  if (!Array.isArray(searches)) return [];
  return searches.filter((q): q is string => typeof q === "string").slice(0, 50);
}
