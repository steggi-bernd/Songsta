/**
 * The playing song's lyrics: from the server, else from LRCLIB, as on the computer.
 * Remembered: what was found once is there without a connection.
 */
import { useEffect, useState } from "react";
import { usePlayer } from "./stores/player";
import { fetchLyrics, type LyricLine } from "./jellyfin";
import { lrcRows, primaryArtist, queryTitle, sungLines, unfoldStamps, type Track } from "./shared";
import { readJson, writeJson } from "./storage";
import Player from "../modules/media3-player";
import { lyricsFileOf } from "./stores/localMusic";
import { useSession } from "./stores/session";

const known = new Map<string, LyricLine[]>();

const fileOf = (id: string): string => `lyrics-${id.replace(/[^a-zA-Z0-9]/g, "_")}.json`;

const LRCLIB_AGENT = "Songsta (https://github.com/steggi-bernd/Songsta)";
const LRCLIB_MS = 7000;

/** Its answer; null for nothing there. No answer at all throws. */
async function askLrclib(path: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LRCLIB_MS);
  try {
    const res = await fetch(`https://lrclib.net/api${path}`, { headers: { "User-Agent": LRCLIB_AGENT }, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function fromLrc(lrc: string): LyricLine[] {
  return lrcRows(lrc).map((row) => ({ at: row.at, text: row.rest.replace(/<\d{1,3}:\d{2}[.:]\d{2,3}>/g, "").trim() }));
}

/**
 * What the view shows; lines kept from before a line's further stamps were read get them back.
 * A timed line without words stays, as a note: nobody sings there.
 */
const toShow = (lines: LyricLine[]): LyricLine[] =>
  sungLines(
    unfoldStamps(lines, (l) => l.at, (at, text) => ({ at, text })).map((l): LyricLine & { gap?: boolean } => (l.text.trim() ? l : { ...l, gap: true })),
    (l) => l.at
  );

function linesOf(record: any): LyricLine[] {
  const timed = typeof record?.syncedLyrics === "string" ? fromLrc(record.syncedLyrics) : [];
  if (timed.length) return timed;
  return typeof record?.plainLyrics === "string" && record.plainLyrics.trim() ? record.plainLyrics.split(/\r?\n/).map((text: string) => ({ text: text.trim() })) : [];
}

/** First the record of exactly this song; else, of those by that name, the closest in length: not a live cut of it. */
async function fromLrclib(track: Track): Promise<LyricLine[]> {
  const artist = primaryArtist(track.artist);
  const title = queryTitle(track.title);
  if (!artist || !title) return [];
  const asked = `artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
  const album = track.album ? `&album_name=${encodeURIComponent(track.album)}` : "";
  const exact = linesOf(track.duration > 0 ? await askLrclib(`/get?${asked}${album}&duration=${Math.round(track.duration)}`) : null);
  if (exact.length) return exact;
  const found: any[] = (await askLrclib(`/search?${asked}`)) ?? [];
  const off = (record: any): number => Math.abs((record?.duration ?? 0) - track.duration);
  const best = (Array.isArray(found) ? found : [])
    .filter((record) => linesOf(record).length && off(record) <= Math.max(12, track.duration * 0.08))
    .sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) || off(a) - off(b))[0];
  return linesOf(best);
}

async function load(track: Track): Promise<LyricLine[]> {
  const kept = known.get(track.id) ?? (await readJson<LyricLine[]>(fileOf(track.id)));
  if (kept) {
    const seen = toShow(kept);
    known.set(track.id, seen);
    return seen;
  }
  // A .lrc beside the file comes first, as on the computer.
  const beside = lyricsFileOf(track);
  const text = beside ? await Player.readText(beside).catch(() => null) : null;
  let got: LyricLine[] = text ? linesOf({ syncedLyrics: text }) : [];
  const session = useSession.getState().session;
  if (!got.length && session && !track.localPath) got = await fetchLyrics(session, track);
  if (!got.length) {
    try {
      got = await fromLrclib(track);
      // Asked once while the app runs, when it could answer.
      known.set(track.id, got);
    } catch {
      /* no way out to it right now: asked again next time */
    }
  }
  const shown = toShow(got);
  // None today can be some tomorrow: only what was found stays.
  if (shown.length) {
    known.set(track.id, shown);
    writeJson(fileOf(track.id), got);
  }
  return shown;
}

/** A song kept on the phone keeps its lyrics too. */
export function keepLyrics(track: Track): void {
  void load(track);
}

export function useLyrics(track: Track | undefined): LyricLine[] {
  const session = useSession((s) => s.session);
  const id = track?.id;
  const [lines, setLines] = useState<LyricLine[]>(() => (id ? known.get(id) ?? [] : []));
  useEffect(() => {
    let alive = true;
    if (!id || !track || (!session && !track.localPath)) {
      setLines([]);
      return;
    }
    const seen = known.get(id);
    if (seen) {
      setLines(seen);
      return;
    }
    setLines([]);
    void load(track).then((got) => {
      if (alive) setLines(got);
    });
    return () => {
      alive = false;
    };
    // The song is what counts, not the object carrying it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, session]);
  return lines;
}

/** The line at this moment; -1 before the first and on lyrics that aren't timed. */
/**
 * A line shows this long before it's sung, as on the computer (SyncedLyrics.tsx): read when it
 * comes, not after. Without it, and with the place told only twice a second, the lines came late.
 */
export const LINE_LEAD_MS = 350;
const CLOCK_EVERY_MS = 100;

/** The place last told, and when: in between, a playing song runs on from there. */
let told = { ms: 0, at: 0 };
usePlayer.subscribe((s, prev) => {
  if (s.positionMs !== prev.positionMs || s.isPlaying !== prev.isPlaying) told = { ms: s.positionMs, at: Date.now() };
});

/** Where the song is this moment: the player says it twice a second, in between it runs on. */
export function songNow(): number {
  const { positionMs, isPlaying, durationMs } = usePlayer.getState();
  if (!isPlaying || told.ms !== positionMs) return positionMs;
  const now = told.ms + (Date.now() - told.at);
  return durationMs > 0 ? Math.min(now, durationMs) : now;
}

/**
 * The line being sung (currentLine) as the song goes: looked at ten times a second while it plays,
 * a new value only when the line changes, so whatever shows it draws anew once a line. Not `active`
 * (a card under the closed player), it doesn't look at all.
 */
export function useLyricLine(lines: LyricLine[], active = true): number {
  const isPlaying = usePlayer((s) => active && s.isPlaying);
  const positionMs = usePlayer((s) => (active ? s.positionMs : -1));
  const [at, setAt] = useState(() => currentLine(lines, songNow()));
  useEffect(() => {
    if (!active) return;
    const look = (): void => setAt(currentLine(lines, songNow()));
    look();
    if (!isPlaying) return;
    const timer = setInterval(look, CLOCK_EVERY_MS);
    return () => clearInterval(timer);
  }, [lines, active, isPlaying, positionMs]);
  return at;
}

/** The line being sung at `positionMs`, shown LINE_LEAD_MS early; -1 before the first. */
export function currentLine(lines: LyricLine[], positionMs: number): number {
  positionMs += LINE_LEAD_MS;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].at;
    if (start === undefined) return -1;
    if (start <= positionMs) at = i;
    else break;
  }
  return at;
}
