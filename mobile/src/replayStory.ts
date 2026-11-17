/**
 * What the phone's Replay story says beyond the counts of stores/listens.ts summarize, as the
 * computer's slides do (src/views/ReplayView.tsx): the songs new to you in the period, mostly which
 * genre, how it sounded (hi-res, lossless, lossy) and where it came from (your server, your folders),
 * and the pulse day by day. Pure, for tests.
 */
import { splitGenres } from "../../src/lib/genres";
import type { PhoneListen, ReplayTop } from "./stores/listens";

/** What the library knows about a song, by its id (this phone's library; the computer's songs where the ids match). */
export interface SongFacts {
  genre?: string;
  codec?: string;
  lossless?: boolean;
  bitsPerSample?: number;
  sampleRate?: number;
}

export interface StoryFacts {
  /** songs whose first play anywhere was in the period, most played first */
  fresh: ReplayTop[];
  freshCount: number;
  /** genre → time listened, most first */
  genres: [string, number][];
  genreTotal: number;
  formats: { hires: number; lossless: number; lossy: number };
  sources: { local: number; jf: number; ss: number };
}

const LOSSLESS = /FLAC|ALAC|WAV|AIFF|APE|WV|DSD|PCM/;

/** The period's facts from every listen kept (all of them: whether a song is new needs what came before). */
export function storyFacts(listens: readonly PhoneListen[], from: number, to: number, lookup: (id: string) => SongFacts | undefined): StoryFacts {
  const firstAt = new Map<string, number>();
  for (const l of listens) {
    const seen = firstAt.get(l.id);
    if (seen === undefined || l.at < seen) firstAt.set(l.id, l.at);
  }
  const fresh = new Map<string, ReplayTop>();
  const genres = new Map<string, number>();
  const formats = { hires: 0, lossless: 0, lossy: 0 };
  const sources = { local: 0, jf: 0, ss: 0 };
  for (const l of listens) {
    if (l.at < from || l.at >= to) continue;
    const first = firstAt.get(l.id) ?? l.at;
    if (first >= from && first < to) {
      const row = fresh.get(l.id) ?? { name: l.title, sub: l.artist, thumb: l.thumb ?? "", ms: 0, plays: 0, id: l.id };
      row.ms += l.ms;
      row.plays += 1;
      if (!row.thumb && l.thumb) row.thumb = l.thumb;
      fresh.set(l.id, row);
    }
    if (l.id.startsWith("jf:")) sources.jf += l.ms;
    else if (l.id.startsWith("ss:")) sources.ss += l.ms;
    else if (l.id.startsWith("local:")) sources.local += l.ms;
    const facts = lookup(l.id);
    if (!facts) continue;
    const genre = splitGenres(facts.genre)[0];
    if (genre) genres.set(genre, (genres.get(genre) ?? 0) + l.ms);
    const name = (facts.codec ?? "").toUpperCase();
    const lossless = facts.lossless || LOSSLESS.test(name);
    if (lossless && ((facts.bitsPerSample ?? 16) > 16 || (facts.sampleRate ?? 44100) > 48000)) formats.hires += l.ms;
    else if (lossless) formats.lossless += l.ms;
    else if (name) formats.lossy += l.ms;
  }
  const freshList = [...fresh.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms);
  const genreList = [...genres.entries()].sort((a, b) => b[1] - a[1]);
  return {
    fresh: freshList.slice(0, 24),
    freshCount: freshList.length,
    genres: genreList,
    genreTotal: genreList.reduce((sum, [, ms]) => sum + ms, 0),
    formats,
    sources,
  };
}

/** One row of the pulse: a day of a month, or a month of a longer period. */
export interface PulseRow {
  /** where the day or month starts */
  at: number;
  unit: "day" | "month";
  ms: number;
  /** the song played longest then */
  top?: { id: string; title: string; artist: string; thumb: string };
}

/**
 * The pulse, row by row: every day of a month (this one up to today), or every month of the year so far,
 * or the last twelve months of all of it. Quiet days and months stay in, so the gaps show.
 */
export function pulseRows(listens: readonly PhoneListen[], period: "month" | "lastMonth" | "year" | "all", now: Date): PulseRow[] {
  const y = now.getFullYear();
  const m = now.getMonth();
  const rows: PulseRow[] = [];
  if (period === "month" || period === "lastMonth") {
    const month = period === "month" ? m : m - 1;
    const days = period === "month" ? now.getDate() : new Date(y, m, 0).getDate();
    for (let d = 1; d <= days; d++) rows.push({ at: new Date(y, month, d).getTime(), unit: "day", ms: 0 });
  } else {
    let first = new Date(y, 0, 1);
    if (period === "all") {
      const earliest = listens.reduce((min, l) => Math.min(min, l.at), Infinity);
      const start = Number.isFinite(earliest) ? new Date(earliest) : now;
      first = new Date(Math.max(new Date(start.getFullYear(), start.getMonth(), 1).getTime(), new Date(y, m - 11, 1).getTime()));
    }
    for (let d = first; d.getTime() <= now.getTime(); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) rows.push({ at: d.getTime(), unit: "month", ms: 0 });
  }
  if (!rows.length) return rows;
  const unit = rows[0].unit;
  const keyOf = (at: number): string => {
    const d = new Date(at);
    return unit === "day" ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : `${d.getFullYear()}-${d.getMonth()}`;
  };
  const index = new Map(rows.map((r, i) => [keyOf(r.at), i]));
  const songs = rows.map(() => new Map<string, { ms: number; listen: PhoneListen }>());
  for (const l of listens) {
    const i = index.get(keyOf(l.at));
    if (i === undefined) continue;
    rows[i].ms += l.ms;
    const song = songs[i].get(l.id) ?? { ms: 0, listen: l };
    song.ms += l.ms;
    songs[i].set(l.id, song);
  }
  rows.forEach((row, i) => {
    let best: { ms: number; listen: PhoneListen } | undefined;
    for (const song of songs[i].values()) if (!best || song.ms > best.ms) best = song;
    if (best) row.top = { id: best.listen.id, title: best.listen.title, artist: best.listen.artist, thumb: best.listen.thumb ?? "" };
  });
  return rows;
}

/** A share bar's parts: the first four by size, the rest as one. */
export function shareParts(entries: [string, number][], total: number, other: string): { label: string; share: number }[] {
  if (!total) return [];
  const parts = entries.slice(0, 4).map(([label, ms]) => ({ label, share: ms / total }));
  const rest = entries.slice(4).reduce((sum, [, ms]) => sum + ms, 0);
  return rest > 0 ? [...parts, { label: other, share: rest / total }] : parts;
}
