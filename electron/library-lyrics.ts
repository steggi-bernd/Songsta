/**
 * Lyrics for the local player, in this order:
 *
 *  1. what the music already carries — a sidecar .lrc next to the file, the
 *     file's own lyrics tag, or the lyrics a Jellyfin/Navidrome server has
 *  2. an earlier online answer from the disk cache
 *  3. the open lyric providers (lyrics.ts); a hit is then cached on disk
 *
 * So a song with its own lyrics never goes online, and a song that needed the
 * providers asks them once. Misses are only remembered for the session: the
 * providers swallow network errors, so a miss can't be told apart from being
 * offline, and caching it would hide lyrics that do exist.
 *
 * Every answer also goes into the lyrics index (lyrics-index.ts), which a
 * background pass (indexLibraryLyrics) fills with the files' own lyrics and
 * the cached ones — so Search finds songs by a line of their lyrics.
 */
import { app } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fetchLyrics as fetchJellyfinLyrics, readLibrary as readJellyfinLibrary } from "./jellyfin";
import { fetchLyrics as fetchSubsonicLyrics, readLibrary as readSubsonicLibrary } from "./subsonic";
import { localTrackById, readLocalLibrary } from "./local-library";
import { fetchLyrics as fetchProviderLyrics, isPlaceholderFetched, lyricsFromText, type FetchedLyrics } from "./lyrics";
import { keepLyricsIndexOf, linesOf, lyricsIndexEntry, noteLyrics, saveLyricsIndex, setLyricsIndexEntry } from "./lyrics-index";
import { unfoldStamps } from "../src/lib/lrc";

export interface LyricsRequest {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

const MAX_SIDECAR_BYTES = 512 * 1024;

function lrcStamp(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, "0")}:${(sec - m * 60).toFixed(2).padStart(5, "0")}`;
}

/** `Song.lrc` next to `Song.flac`. */
async function sidecarLyrics(audioPath: string): Promise<FetchedLyrics | null> {
  const stem = path.join(path.dirname(audioPath), path.basename(audioPath, path.extname(audioPath)));
  for (const candidate of [`${stem}.lrc`, `${stem}.LRC`]) {
    try {
      const stat = await fs.promises.stat(candidate);
      if (!stat.isFile() || stat.size > MAX_SIDECAR_BYTES) continue;
      const found = lyricsFromText("Lyrics file (.lrc)", await fs.promises.readFile(candidate, "utf-8"));
      if (found) return found;
    } catch {
      /* no such file */
    }
  }
  return null;
}

/** USLT/SYLT (MP3), LYRICS (FLAC/Ogg), ©lyr (M4A) — whatever the tags carry. */
async function embeddedLyrics(audioPath: string): Promise<FetchedLyrics | null> {
  try {
    const { parseFile } = await import("music-metadata");
    const meta = await parseFile(audioPath, { duration: false, skipCovers: true });
    for (const tag of meta.common.lyrics ?? []) {
      // Synchronized frames carry their own stamps; only millisecond stamps are usable.
      const timed = (tag.syncText ?? []).filter((s) => typeof s.timestamp === "number");
      if (timed.length && Number(tag.timeStampFormat) === 2) {
        const found = lyricsFromText(
          "Embedded lyrics",
          timed.map((s) => `[${lrcStamp((s.timestamp as number) / 1000)}]${s.text}`).join("\n")
        );
        if (found) return found;
      }
      if (tag.text) {
        const found = lyricsFromText("Embedded lyrics", tag.text);
        if (found) return found;
      }
    }
  } catch {
    /* unreadable tags */
  }
  return null;
}

/* ------------------------------------------------------------- disk cache */

function cacheFile(id: string): string {
  const name = crypto.createHash("sha1").update(id).digest("hex").slice(0, 24);
  return path.join(app.getPath("userData"), "lyrics-cache", `${name}.json`);
}

async function readCached(id: string): Promise<FetchedLyrics | null> {
  const file = cacheFile(id);
  try {
    const raw = JSON.parse(await fs.promises.readFile(file, "utf-8")) as { lyrics?: FetchedLyrics };
    const lyrics = raw.lyrics ?? null;
    // Earlier versions kept an instrumental's "纯音乐，请欣赏" as its lyrics.
    if (lyrics && isPlaceholderFetched(lyrics)) {
      await fs.promises.rm(file, { force: true });
      return null;
    }
    // Kept before a line's further stamps were read.
    if (lyrics?.synced) lyrics.synced = unfoldStamps(lyrics.synced, (l) => l.time * 1000, (at, text, from) => ({ ...from, time: at / 1000, text }));
    return lyrics;
  } catch {
    return null;
  }
}

async function writeCached(id: string, lyrics: FetchedLyrics): Promise<void> {
  try {
    const file = cacheFile(id);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify({ at: Date.now(), lyrics }));
  } catch (err) {
    console.warn("[bytune] lyrics cache write failed:", err instanceof Error ? err.message : err);
  }
}

/* ------------------------------------------------------------- lookup */

/** Online answers (and misses) already fetched this session. */
const sessionMemo = new Map<string, FetchedLyrics | null>();

/** The music's own lyrics, if it has any. */
async function ownLyrics(id: string): Promise<FetchedLyrics | null> {
  if (id.startsWith("local:")) {
    const track = localTrackById(id);
    if (!track) return null;
    return (await sidecarLyrics(track.path)) ?? (await embeddedLyrics(track.path));
  }
  if (id.startsWith("jf:")) {
    const text = await fetchJellyfinLyrics(id.slice(3));
    return text ? lyricsFromText("Jellyfin", text) : null;
  }
  if (id.startsWith("ss:")) {
    const text = await fetchSubsonicLyrics(id.slice(3));
    return text ? lyricsFromText("Navidrome", text) : null;
  }
  return null;
}

export async function libraryLyrics(q: LyricsRequest): Promise<FetchedLyrics | null> {
  if (!q?.id) return null;
  // Read fresh every time: editing a .lrc while ByTune runs shows up on the next play.
  const own = await ownLyrics(q.id);
  if (own) {
    // A file's own lyrics are indexed from the file (indexLibraryLyrics); a server's, as they come.
    if (!q.id.startsWith("local:")) noteLyrics(q.id, own);
    return own;
  }
  if (sessionMemo.has(q.id)) return sessionMemo.get(q.id) ?? null;
  const cached = await readCached(q.id);
  if (cached) {
    sessionMemo.set(q.id, cached);
    noteLyrics(q.id, cached);
    return cached;
  }
  const duration = typeof q.duration === "number" && Number.isFinite(q.duration) ? Math.round(q.duration) : 0;
  const found = await fetchProviderLyrics(
    { id: q.id, title: q.title || "", artist: q.artist || "", album: q.album, duration },
    { prioritizeWordSync: true }
  ).catch(() => null);
  sessionMemo.set(q.id, found);
  if (sessionMemo.size > 500) sessionMemo.delete(sessionMemo.keys().next().value as string);
  if (found) {
    await writeCached(q.id, found);
    noteLyrics(q.id, found);
  }
  return found;
}

/* ------------------------------------------------------------- the search index */

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function mtimeOf(file: string): Promise<number> {
  try {
    return Math.floor((await fs.promises.stat(file)).mtimeMs);
  } catch {
    return 0;
  }
}

/** The .lrc beside a file, by the time it was last changed (0: none). */
async function sidecarMtime(audioPath: string): Promise<number> {
  const stem = path.join(path.dirname(audioPath), path.basename(audioPath, path.extname(audioPath)));
  return (await mtimeOf(`${stem}.lrc`)) || (await mtimeOf(`${stem}.LRC`));
}

let indexing: Promise<void> | null = null;
let indexAgain = false;

/**
 * Fills the lyrics index in the background: every local file's own lyrics
 * (its .lrc, its lyrics tag) — read again only when the file or its .lrc
 * changed — or else its cached online lyrics, and the cached lyrics of every
 * server song. A few songs at a time, so nothing else waits. One pass at a
 * time; a call during one makes it go round once more.
 */
export function indexLibraryLyrics(): Promise<void> {
  if (indexing) {
    indexAgain = true;
    return indexing;
  }
  indexing = (async () => {
    do {
      indexAgain = false;
      await indexPass();
    } while (indexAgain);
  })()
    .catch((err) => console.warn("[bytune] lyrics index:", err instanceof Error ? err.message : err))
    .finally(() => {
      indexing = null;
    });
  return indexing;
}

async function indexPass(): Promise<void> {
  const keep = new Set<string>();
  let read = 0;
  for (const t of readLocalLibrary().tracks) {
    keep.add(t.id);
    const sig = `${Math.floor(t.mtime)}:${t.size}:${await sidecarMtime(t.path)}`;
    if (lyricsIndexEntry(t.id)?.sig === sig) continue;
    const lyrics = (await sidecarLyrics(t.path)) ?? (await embeddedLyrics(t.path)) ?? (await readCached(t.id));
    const { lines, times } = linesOf(lyrics);
    setLyricsIndexEntry(t.id, { sig, lines, ...(times ? { times } : {}) });
    if (++read % 20 === 0) await pause(30);
  }
  const serverIds = [...readJellyfinLibrary().tracks, ...readSubsonicLibrary().tracks].map((t) => t.id);
  for (const id of serverIds) {
    keep.add(id);
    const cachedAt = await mtimeOf(cacheFile(id));
    const cur = lyricsIndexEntry(id);
    // Lyrics noted while playing stand; a cache file only adds what isn't there yet.
    if (!cachedAt || cur?.sig === "seen" || cur?.sig === `cache:${cachedAt}`) continue;
    const { lines, times } = linesOf(await readCached(id));
    if (lines.length) setLyricsIndexEntry(id, { sig: `cache:${cachedAt}`, lines, ...(times ? { times } : {}) });
    if (++read % 20 === 0) await pause(30);
  }
  keepLyricsIndexOf(keep);
  await saveLyricsIndex();
}
