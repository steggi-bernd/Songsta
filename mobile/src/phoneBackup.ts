/**
 * The phone's backup (backup.ts) through Android's own dialogs: saved where somebody chooses,
 * Downloads or a cloud folder, and put back from there after a new install.
 */
import Player from "../modules/media3-player";
import { BACKUP_FILES, backupFileName, foldersToPick, makeBackup, MAX_BACKUP_BYTES, readBackup, restoreFiles, type BackupProblem, type PhoneBackup } from "./backup";
import { APP_VERSION } from "./newVersion";
import { holdFiles, readJson, writeJson } from "./storage";
import { useAlbumEdits, writeAlbumPicture } from "./stores/albumEdits";
import { useLocalMusic } from "./stores/localMusic";
import { stopSync } from "./sync";

/** The phone's files a backup is made of, as they are now. */
async function readFiles(): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {};
  await Promise.all(
    BACKUP_FILES.map(async (name) => {
      files[name] = await readJson(name).catch(() => null);
    })
  );
  return files;
}

/** Asks where, then writes the backup there: the file's name, or null when somebody changed their mind. */
export async function exportBackup(): Promise<string | null> {
  const target = await Player.pickSaveDocument(backupFileName(new Date()), "application/json");
  if (!target) return null;
  const files = await readFiles();
  const backup = makeBackup({
    read: (name) => files[name] ?? null,
    picture: (key) => useAlbumEdits.getState().coverData(key),
    folders: useLocalMusic.getState().folders,
    appVersion: APP_VERSION,
    now: new Date(),
  });
  await Player.writeText(target.uri, JSON.stringify(backup));
  return target.name;
}

/** Asks for the file and reads it: the backup, what's wrong with it, or null when somebody changed their mind. */
export async function pickBackup(): Promise<PhoneBackup | BackupProblem | "unreadable" | null> {
  const picked = await Player.pickDocument(["application/json", "text/plain", "application/octet-stream"]);
  if (!picked) return null;
  if (picked.size > MAX_BACKUP_BYTES) return "too-big";
  const text = await Player.readText(picked.uri);
  return text === null ? "unreadable" : readBackup(text);
}

/**
 * The backup's files in place of the phone's. The sync stops first and nothing writes after them:
 * the app starts anew with them (Player.restartApp). Answers the music folders to pick again.
 */
export async function restoreBackup(backup: PhoneBackup): Promise<string[]> {
  stopSync();
  const files = await readFiles();
  const out = restoreFiles(backup, { read: (name) => files[name] ?? null, placePicture: writeAlbumPicture });
  for (const [name, value] of Object.entries(out)) writeJson(name, value);
  holdFiles();
  return foldersToPick(backup, useLocalMusic.getState().folders);
}
