/**
 * Backup export / import — the desktop port of mobile's Backup.kt.
 *
 * A backup is one JSON document the user saves anywhere via the native save
 * picker and restores via the native open picker (no storage permission
 * model on desktop; the dialogs ARE the permission):
 *
 *   { app: "bytune", version: 1, exportedAt,
 *     settings, library, player, recentSearches, listening }
 *
 * Included: settings (minus device-local paths), the full library
 * (liked/playlists/folders/history/downloads index), the player queue,
 * recent searches, and every listening-history bucket.
 * Deliberately excluded: the approved-dirs allowlist and the local-library
 * index (device paths that may not exist on restore; re-picking the folder
 * re-indexes, and local ids are path hashes so playlists re-link).
 *
 * Semantics are replace, not merge (mobile parity): importing wipes the
 * current stores first, so a backup never doubles plays or mixes configs.
 */
import { BrowserWindow, dialog } from "electron";
import * as fs from "fs";
import * as persist from "./persist";
import {
  envelope,
  searchesFromBackup,
  searchesToBackup,
  settingsFromBackup,
  settingsToBackup,
  storeEnvelopeFromBackup,
} from "./backup-transfer";
import { exportAll as statsExportAll, importAll as statsImportAll, type MonthBucket } from "./stats";
import * as transition from "./data-transition";

const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

export interface BackupFile {
  app: string;
  version: number;
  exportedAt: string;
  settings: Record<string, unknown>;
  library: unknown;
  player: unknown;
  recentSearches: unknown;
  listening: MonthBucket[];
}

export async function backupExport(parent: BrowserWindow | null): Promise<{ path?: string; cancelled?: boolean }> {
  const now = new Date();
  const file: BackupFile = {
    app: "bytune",
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    // Stores live on disk as zustand envelopes { state, version }; the backup
    // carries portable shapes (settings map, searches array). Passing the
    // envelope's top level here is what used to export settings/searches empty.
    settings: settingsToBackup(persist.readData("settings")),
    library: persist.readData("library"),
    player: persist.readData("player"),
    recentSearches: searchesToBackup(persist.readData("recent-searches")),
    listening: statsExportAll(),
  };
  const stamp = now.toISOString().slice(0, 10);
  const saveOpts = {
    title: "Export Songsta backup",
    defaultPath: `songsta-backup-${stamp}.json`,
    filters: [{ name: "Songsta backup", extensions: ["json"] }],
  };
  const res = parent
    ? await dialog.showSaveDialog(parent, saveOpts)
    : await dialog.showSaveDialog(saveOpts);
  if (res.canceled || !res.filePath) return { cancelled: true };
  await fs.promises.writeFile(res.filePath, JSON.stringify(file, null, 2), "utf-8");
  return { path: res.filePath };
}

export async function backupImport(
  parent: BrowserWindow | null
): Promise<{ restored?: boolean; cancelled?: boolean; months?: number }> {
  const openOpts = {
    title: "Import Songsta backup",
    properties: ["openFile" as const],
    filters: [{ name: "Songsta backup", extensions: ["json"] }],
  };
  const res = parent
    ? await dialog.showOpenDialog(parent, openOpts)
    : await dialog.showOpenDialog(openOpts);
  if (res.canceled || res.filePaths.length === 0) return { cancelled: true };
  const file = res.filePaths[0];
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > MAX_BACKUP_BYTES) {
    throw new Error("That backup file is too large to import");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.promises.readFile(file, "utf-8"));
  } catch {
    throw new Error("That doesn't look like a Songsta backup");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("That doesn't look like a Songsta backup");
  }
  const doc = raw as Record<string, unknown>;
  if (doc.app !== "bytune") throw new Error("That backup is from another app");
  if (typeof doc.version !== "number" || doc.version > BACKUP_VERSION) {
    throw new Error("That backup was written by a newer version of Songsta");
  }

  // Store sections must be real zustand envelopes — anything else used to be
  // written verbatim and broke the store the renderer hydrates from.
  const nextLibrary = doc.library != null ? storeEnvelopeFromBackup(doc.library, "library") : null;
  const nextPlayer = doc.player != null ? storeEnvelopeFromBackup(doc.player, "player") : null;

  // The write section is serialized with resets and renderer writes (dialog +
  // parse stay outside — they must not hold the queue while the user browses
  // for a file). Without this a write queued behind a reset could resurrect
  // erased data.
  return transition.serializeData(async () => {
    // Settings: whitelist incoming keys, keep this machine's device-local
    // ones, and write back the zustand envelope the store hydrates from on
    // reload. Re-read inside the queue so a queued write's outcome is the
    // base, not a snapshot taken while the picker was open.
    const nextSettings = settingsFromBackup(doc.settings, persist.readData("settings"));
    await persist.writeData("settings", envelope(nextSettings));

    if (nextLibrary) {
      await persist.writeData("library", nextLibrary);
    }
    if (nextPlayer) await persist.writeData("player", nextPlayer);
    // Recent searches: plain array (current format) or a raw zustand envelope
    // (what older exports captured — previously this import was a no-op).
    // An absent field leaves the local store untouched.
    if (doc.recentSearches != null) {
      await persist.writeData("recent-searches", envelope({ searches: searchesFromBackup(doc.recentSearches) }));
    }

    let months = 0;
    if (Array.isArray(doc.listening)) {
      // The import runs synchronously on the main process; a hostile backup with
      // millions of buckets would freeze the app for minutes. Cap at the
      // retention horizon the stats module keeps (36 months).
      const buckets = (doc.listening as unknown[])
        .filter(
          (b): b is MonthBucket => !!b && typeof b === "object" && typeof (b as MonthBucket).month === "string"
        )
        .slice(0, 36);
      statsImportAll(buckets);
      months = buckets.length;
    }
    return { restored: true, months };
  });
}
