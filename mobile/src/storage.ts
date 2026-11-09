/**
 * Small JSON files in the app's own folder: the library's copy, the playlists,
 * where the player stopped. A new version is written beside the old one and only
 * then takes its place, so an app killed halfway keeps the last good one.
 */
import { File, Paths } from "expo-file-system";

const nextOf = (name: string): File => new File(Paths.document, `${name}.next`);

/** A backup was put back (phoneBackup.ts): nothing still running here writes over it before the app starts anew. */
let held = false;

export function holdFiles(): void {
  held = true;
}

export async function readJson<T>(name: string): Promise<T | null> {
  for (const file of [new File(Paths.document, name), nextOf(name)]) {
    try {
      if (file.exists) return JSON.parse(await file.text()) as T;
    } catch {
      /* not readable: the other one, if there is one */
    }
  }
  return null;
}

export function writeJson(name: string, value: unknown): void {
  if (held) return;
  try {
    const next = nextOf(name);
    if (next.exists) next.delete();
    // Not the plain write: that one runs later on its own, and two of them can tear a file apart.
    next.writeSync(JSON.stringify(value));
    const file = new File(Paths.document, name);
    if (file.exists) file.delete();
    next.rename(name);
  } catch {
    /* a copy for next time: the app runs on without it */
  }
}

export function removeJson(name: string): void {
  if (held) return;
  try {
    for (const file of [new File(Paths.document, name), nextOf(name)]) {
      if (file.exists) file.delete();
    }
  } catch {
    /* gone either way next time it is written */
  }
}
