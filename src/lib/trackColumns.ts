/**
 * The columns of a song list (components/TrackList.tsx): which ones the user wants, how wide, and
 * which of them a list at a given width can show. Number, cover, title and the row's buttons are
 * always there; everything between the title and those buttons is the user's choice, made from the
 * small plus at the head's right end and by pulling a column's left edge.
 */
import type { Track } from "../types";

export type TrackColumn = "album" | "added" | "released" | "genre" | "plays" | "format" | "time";

export interface ColumnSpec {
  key: TrackColumn;
  /** its width as it comes, and how far it can be pulled */
  width: number;
  min: number;
  max: number;
  /** numbers read better from the right */
  right?: boolean;
}

/** In the order they stand in a row. */
export const TRACK_COLUMNS: ColumnSpec[] = [
  { key: "album", width: 208, min: 96, max: 420 },
  { key: "added", width: 112, min: 84, max: 200 },
  { key: "released", width: 92, min: 56, max: 160 },
  { key: "genre", width: 128, min: 72, max: 260 },
  { key: "format", width: 116, min: 72, max: 200 },
  { key: "plays", width: 56, min: 44, max: 110, right: true },
  { key: "time", width: 44, min: 44, max: 44, right: true },
];

const SPEC = new Map(TRACK_COLUMNS.map((c) => [c.key, c]));
const KEYS = new Set<string>(TRACK_COLUMNS.map((c) => c.key));

export interface ColumnChoice {
  /** the columns asked for */
  shown: TrackColumn[];
  /** widths pulled by hand */
  widths: Partial<Record<TrackColumn, number>>;
  /** the order they stand in, dragged by their names in the head; the time stays at the end */
  order?: TrackColumn[];
}

export const DEFAULT_COLUMNS: ColumnChoice = { shown: ["album", "added", "time"], widths: {} };

const isColumn = (k: unknown): k is TrackColumn => typeof k === "string" && KEYS.has(k);

/** What was saved, as a choice; anything else is the default. */
export function readColumns(raw: unknown): ColumnChoice {
  const c = raw as Partial<ColumnChoice> | null;
  if (!c || typeof c !== "object" || !Array.isArray(c.shown)) return DEFAULT_COLUMNS;
  const shown = [...new Set(c.shown.filter(isColumn))];
  const widths: Partial<Record<TrackColumn, number>> = {};
  if (c.widths && typeof c.widths === "object") {
    for (const [k, w] of Object.entries(c.widths)) {
      const spec = SPEC.get(k as TrackColumn);
      if (spec && typeof w === "number" && Number.isFinite(w)) widths[spec.key] = Math.round(Math.min(spec.max, Math.max(spec.min, w)));
    }
  }
  return Array.isArray(c.order) ? { shown, widths, order: orderOf({ shown, widths, order: c.order.filter(isColumn) }) } : { shown, widths };
}

/** Every column in the order chosen: what was dragged where, the rest as they come, the time last. */
export function orderOf(choice: ColumnChoice): TrackColumn[] {
  const out: TrackColumn[] = [];
  for (const k of choice.order ?? []) if (isColumn(k) && k !== "time" && !out.includes(k)) out.push(k);
  for (const c of TRACK_COLUMNS) {
    if (c.key === "time" || out.includes(c.key)) continue;
    // A column the saved order doesn't know yet goes after the one it follows in a row.
    const before = TRACK_COLUMNS.findIndex((s) => s.key === c.key);
    const after = TRACK_COLUMNS.slice(0, before).map((s) => s.key).reverse().find((k) => out.includes(k));
    out.splice(after ? out.indexOf(after) + 1 : 0, 0, c.key);
  }
  return [...out, "time"];
}

/** `key` taken out and put in front of `before` (to the end, before the time, with `null`). */
export function moved(choice: ColumnChoice, key: TrackColumn, before: TrackColumn | null): ColumnChoice {
  if (key === "time" || key === before) return choice;
  const rest = orderOf(choice).filter((k) => k !== key && k !== "time");
  const at = before && before !== "time" ? rest.indexOf(before) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, key);
  return { ...choice, order: [...rest, "time"] };
}

export const widthOf = (choice: ColumnChoice, key: TrackColumn): number => choice.widths[key] ?? SPEC.get(key)!.width;

export function toggled(choice: ColumnChoice, key: TrackColumn): ColumnChoice {
  const shown = choice.shown.includes(key) ? choice.shown.filter((k) => k !== key) : [...choice.shown, key];
  return { ...choice, shown };
}

/** A column pulled to a width, within what it can take; back to its own width with `null`. */
export function resized(choice: ColumnChoice, key: TrackColumn, width: number | null): ColumnChoice {
  const spec = SPEC.get(key)!;
  const widths = { ...choice.widths };
  if (width === null) delete widths[key];
  else widths[key] = Math.round(Math.min(spec.max, Math.max(spec.min, width)));
  return { ...choice, widths };
}

/** What a row has room for besides its columns: number, cover, buttons, its padding and the gaps between them. */
const ROW_FIXED = 24 + 28 + 52 + 88;
const GAP = 14;
/** The title keeps this much whatever is switched on. */
export const TITLE_MIN = 180;
/** Given up first when a list is too narrow for all that's asked for. */
const GOES_FIRST: TrackColumn[] = ["format", "plays", "genre", "released", "added", "album"];

/**
 * The columns a list draws: the chosen ones it has something to show for, in the rows' order, as
 * many as fit beside the title. `has` says which facts any of its songs carries: a column nobody
 * could fill stays away.
 */
export function columnsFor(choice: ColumnChoice, has: Partial<Record<TrackColumn, boolean>>, room: number): { key: TrackColumn; width: number; right: boolean }[] {
  let keys = orderOf(choice).filter((k) => choice.shown.includes(k) && has[k] !== false);
  const needs = (list: TrackColumn[]): number => ROW_FIXED + TITLE_MIN + GAP * (3 + list.length) + list.reduce((sum, k) => sum + widthOf(choice, k), 0);
  for (const drop of GOES_FIRST) {
    if (room <= 0 || needs(keys) <= room) break;
    keys = keys.filter((k) => k !== drop);
  }
  return keys.map((key) => ({ key, width: widthOf(choice, key), right: SPEC.get(key)!.right === true }));
}

/** "FLAC 24/96", "MP3 320", "AAC": what the file is, as short as a column needs it. */
export function formatCell(t: Track): string {
  const name = (t.codec || t.container || "").toUpperCase();
  if (!name) return "";
  if (t.lossless || /FLAC|ALAC|WAV|AIFF|APE|WV|DSD/.test(name)) {
    const bits = t.bitsPerSample;
    const khz = t.sampleRate ? Math.round(t.sampleRate / 100) / 10 : 0;
    return bits && khz ? `${name} ${bits}/${khz}` : name;
  }
  return t.bitrate ? `${name} ${Math.round(t.bitrate / 1000)}` : name;
}

/** The day a song came out as its source knows it: the first release where that's told apart. */
export function releasedCell(t: Track): string {
  const day = t.originalDate || t.date;
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const d = new Date(`${day}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  const year = t.originalYear || t.year || (day ? Number(day.slice(0, 4)) : 0);
  return year ? String(year) : "";
}

/* ------------------------------------------------------------------ ordering a list by a column */

/** What a list can be ordered by: its columns, and the artist under each title. */
export type SortKey = "title" | "artist" | "album" | "added" | "released" | "genre" | "format" | "plays" | "time";
export interface ListSort {
  key: SortKey;
  /** newest, most, longest or Z first */
  desc: boolean;
}

export const SORT_KEYS: SortKey[] = ["title", "artist", "album", "added", "released", "genre", "format", "plays", "time"];

/** Where the first click starts: names from A, dates newest first, counts and quality highest first, lengths shortest first. */
export const FIRST_DESC: Record<SortKey, boolean> = {
  title: false,
  artist: false,
  album: false,
  genre: false,
  added: true,
  released: true,
  format: true,
  plays: true,
  time: false,
};

/** A click on a column's name: ordered by it, then the other way round, then the list's own order again. */
export function nextListSort(now: ListSort | null, key: SortKey): ListSort | null {
  if (!now || now.key !== key) return { key, desc: FIRST_DESC[key] };
  return now.desc === FIRST_DESC[key] ? { key, desc: !now.desc } : null;
}

/** A saved order, or none. */
export function readListSort(raw: unknown): ListSort | null {
  const s = raw as Partial<ListSort> | null;
  return s && typeof s === "object" && SORT_KEYS.includes(s.key as SortKey) && typeof s.desc === "boolean" ? { key: s.key as SortKey, desc: s.desc } : null;
}

/** A file's quality as one number: lossless above lossy, more bits and a higher rate above fewer. */
export function formatRank(t: Track): number {
  const name = (t.codec || t.container || "").toUpperCase();
  if (!name) return -1;
  if (t.lossless || /FLAC|ALAC|WAV|AIFF|APE|WV|DSD/.test(name)) return 1e9 + (t.bitsPerSample ?? 16) * 1e6 + (t.sampleRate ?? 44100);
  return t.bitrate ?? 0;
}

/** When a song came out, as a number to order by; 0 when nobody knows. */
export function releasedValue(t: Track): number {
  const day = t.originalDate || t.date;
  if (day && /^\d{4}-\d{2}-\d{2}/.test(day)) {
    const ms = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(ms)) return ms;
  }
  const year = t.originalYear || t.year || (day ? Number(day.slice(0, 4)) : 0);
  return year ? Date.UTC(year, 0, 1) : 0;
}

/**
 * When each song joined, to order by, where a list knows it for only some: a song without a date
 * stands where its list put it, so it counts as joined together with the dated song next to it on
 * its older side. Liked Songs list the newest first, a playlist the oldest first (`newestFirst`).
 * Songs liked here before dates were kept stay above the older likes brought over from Spotify.
 */
export function addedForOrder(dates: number[], newestFirst: boolean): number[] {
  const out = [...dates];
  const n = out.length;
  // Walk from the oldest end: an undated song takes the date of the last dated one passed, a hair later.
  let last = 0;
  let step = 0;
  for (let k = 0; k < n; k++) {
    const i = newestFirst ? n - 1 - k : k;
    if (dates[i] > 0) {
      last = dates[i];
      step = 0;
    } else {
      step += 1;
      out[i] = last + step * 1e-3;
    }
  }
  return out;
}

const fold = (s: string | undefined): string =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase();

/**
 * The songs in the order asked for; ties keep the list's own order. Songs that have nothing for that
 * column go to the end, whichever way round. `added` and `plays` give each song's number by its place.
 */
export function sortTracks(tracks: Track[], sort: ListSort | null, added: (i: number) => number, plays: (t: Track) => number): Track[] {
  if (!sort) return tracks;
  const text = (t: Track): string =>
    sort.key === "title" ? fold(t.title) : sort.key === "artist" ? fold(t.artist) : sort.key === "album" ? fold(t.album) : sort.key === "genre" ? fold(t.genre) : "";
  const number = (t: Track, i: number): number =>
    sort.key === "added" ? added(i) : sort.key === "released" ? releasedValue(t) : sort.key === "format" ? formatRank(t) : sort.key === "plays" ? plays(t) : sort.key === "time" ? t.duration || 0 : 0;
  const byText = sort.key === "title" || sort.key === "artist" || sort.key === "album" || sort.key === "genre";
  const rows = tracks.map((t, i) => ({ t, i, text: byText ? text(t) : "", n: byText ? 0 : number(t, i) }));
  const empty = (r: (typeof rows)[number]): boolean => (byText ? !r.text : sort.key === "plays" ? false : r.n <= 0);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  rows.sort((a, b) => {
    const ea = empty(a);
    const eb = empty(b);
    if (ea !== eb) return ea ? 1 : -1;
    const c = byText ? collator.compare(a.text, b.text) : a.n - b.n;
    if (c !== 0) return sort.desc ? -c : c;
    // The same artist or album: their songs keep the order they have there.
    if (sort.key === "artist" || sort.key === "album") {
      const album = collator.compare(fold(a.t.album), fold(b.t.album));
      if (album !== 0) return album;
      const disc = (a.t.discNo ?? 0) - (b.t.discNo ?? 0);
      if (disc !== 0) return disc;
      const track = (a.t.trackNo ?? 0) - (b.t.trackNo ?? 0);
      if (track !== 0) return track;
    }
    return a.i - b.i;
  });
  return rows.map((r) => r.t);
}

/** Whether a song answers what was typed into a list's search: every word somewhere in its title, artist, album or genre. */
export function matchesSearch(t: Track, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${fold(t.title)} ${fold(t.artist)} ${fold(t.album)} ${fold(t.genre)}`;
  return words.every((w) => hay.includes(w));
}
