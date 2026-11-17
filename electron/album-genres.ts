/**
 * Album genres from the open databases, so an album's genre needn't rest on its tags alone (the user
 * wasn't happy with how genres were sorted, 2026-11-15): MusicBrainz's genres for the album, voted
 * on by its community (with how many votes each), and the genres Wikidata states for it. The
 * renderer weighs them against the tags (src/lib/albumGenres.ts).
 *
 * One album at a time through MusicBrainz's queue (metadata.ts: one request a second, as it asks),
 * in the background, each answer kept: an album is asked once, one nobody knows again after a
 * month. Only an album's name and artist leave the computer, as for the artist pages' facts.
 */
import * as persist from "./persist";
import { lookupAlbumGenres, type AlbumGenres } from "./metadata";

const STORE = "album-genres";
const RETRY_UNKNOWN_MS = 30 * 86_400_000;
const SAVE_EVERY = 10;
/** Offline: the same album again after half a minute, then twice as long each time, at most half an hour. */
const RETRY_FIRST_MS = 30_000;
const RETRY_MOST_MS = 30 * 60_000;

export interface AlbumGenreEntry extends Partial<AlbumGenres> {
  /** when it was asked */
  at: number;
  /** nobody knew the album */
  none?: boolean;
}

let cache: Record<string, AlbumGenreEntry> | null = null;
const queue: { key: string; title: string; artist: string }[] = [];
const queued = new Set<string>();
let running = false;
let unsaved = 0;
let tell: (() => void) | null = null;
/** Counts the stops (the setting went off), so an album that failed just before one isn't put back. */
let stops = 0;

function load(): Record<string, AlbumGenreEntry> {
  if (!cache) {
    const raw = persist.readData(STORE) as Record<string, AlbumGenreEntry> | null;
    cache = raw && typeof raw === "object" ? raw : {};
  }
  return cache;
}

/** What's known so far, album key → genres. */
export function albumGenresKnown(): Record<string, AlbumGenreEntry> {
  return load();
}

/** Said when answers came in (a few at a time): the renderer reads them again. */
export function onAlbumGenres(listener: () => void): void {
  tell = listener;
}

/** Albums to ask about; the ones known (or asked lately without an answer) are left out. */
export function askAlbumGenres(albums: { key: string; title: string; artist: string }[]): number {
  const known = load();
  const now = Date.now();
  let added = 0;
  for (const a of albums) {
    if (!a.key || !a.title || queued.has(a.key)) continue;
    const entry = known[a.key];
    if (entry && (!entry.none || now - entry.at < RETRY_UNKNOWN_MS)) continue;
    queue.push(a);
    queued.add(a.key);
    added += 1;
  }
  if (!running && queue.length) void work();
  return added;
}

/** The setting went off: nothing more is asked. What's known stays. */
export function stopAlbumGenres(): void {
  queue.length = 0;
  queued.clear();
  stops += 1;
}

async function work(): Promise<void> {
  running = true;
  let retryIn = RETRY_FIRST_MS;
  try {
    while (queue.length) {
      const next = queue.shift() as { key: string; title: string; artist: string };
      const stopsBefore = stops;
      let entry: AlbumGenreEntry;
      try {
        const found = await lookupAlbumGenres(next.artist, next.title);
        entry = found ? { at: Date.now(), ...found } : { at: Date.now(), none: true };
        retryIn = RETRY_FIRST_MS;
      } catch {
        // Offline or refused: not marked unknown; the same album again later, waiting longer each time.
        if (stops !== stopsBefore) continue;
        queue.unshift(next);
        await new Promise((r) => setTimeout(r, retryIn));
        retryIn = Math.min(RETRY_MOST_MS, retryIn * 2);
        continue;
      }
      load()[next.key] = entry;
      queued.delete(next.key);
      if (++unsaved >= SAVE_EVERY || !queue.length) {
        unsaved = 0;
        await persist.writeData(STORE, load()).catch(() => undefined);
        tell?.();
      }
    }
  } finally {
    running = false;
  }
}
