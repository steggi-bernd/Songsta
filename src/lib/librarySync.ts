/**
 * How the library is organised, the same on every device: what's pinned to the top and in which
 * order, how the library is sorted, when each album and playlist last played, the groups, and the
 * album edits (lib/albumEdits.ts) with their pictures. Four documents of the sync service, merged
 * by the apps like the playlists (lib/syncEngine.ts); here are their shapes and how two copies
 * become one. Pure, one copy for the desktop and the phone.
 *
 * Every part carries the moment it last changed, and the later change wins: a whole list (the pins,
 * a set of groups) as one, the album edits entry by entry, so a name given on the phone and a merge
 * made on the computer both stay. Something taken away keeps its moment, so it doesn't come back.
 * When-it-played times only grow. What was there before anything synced counts as old: when a
 * device first meets the others, its pins and groups join theirs instead of giving way.
 *
 * Things are known by the keys kept lists and groups use: "album:<album key>", "playlist:<id>",
 * "liked", "artist:<name>", "mix:<id>", "smart:<id>", "genre:<key>". A device keeps what it has no
 * use for (the phone the computer's smart playlists, the computer the phone's artists) as it came.
 */
import type { AlbumEdits, SongEdit } from "./albumEdits";
import { readExploreGroups, readGroups, type ExploreGroups, type Group } from "./libraryGroups";
import { safeCover } from "./playlistSync";

export type LibraryDocName = "order" | "groups" | "albumedits" | "albumpictures";
export const LIBRARY_DOCS: readonly LibraryDocName[] = ["order", "groups", "albumedits", "albumpictures"];

/** A part as it was set at one moment; without `v` it was taken away then. */
export interface Stamped<T> {
  at: number;
  v?: T;
}

export type StampedMap<T> = Record<string, Stamped<T>>;

/**
 * The moment of what was there before anything synced: the computer's ahead of the phone's, and
 * both behind any change made since. Two of them meeting keep both sides'.
 */
export const OLD_ON_COMPUTER = 2;
export const OLD_ON_PHONE = 1;
const fromBefore = (at: number): boolean => at <= OLD_ON_COMPUTER;

/** The library's sort, as the computer's library panel offers it. */
export type LibrarySort = "played" | "added" | "alpha" | "artist";
export const LIBRARY_SORTS: readonly LibrarySort[] = ["played", "added", "alpha", "artist"];

export interface OrderDoc {
  sort?: Stamped<LibrarySort>;
  /** what stands on top, first first; a playlist is pinned by its own pin (the playlists document), here it only has its place */
  pins?: Stamped<string[]>;
  /** when each album, playlist, Liked Songs, artist or mix last played as a whole, ms */
  played?: Record<string, number>;
}

export interface GroupsDoc {
  /** the library's groups: albums and playlists */
  library?: Stamped<Group[]>;
  /** Explore's own, one set per tab */
  explore?: Stamped<ExploreGroups>;
}

export const EDIT_FIELDS = ["artists", "mergedInto", "aliases", "songs", "titles"] as const;
export type EditField = (typeof EDIT_FIELDS)[number];
export type EditValues = Pick<AlbumEdits, EditField>;

export interface AlbumEditsDoc {
  artists?: StampedMap<string>;
  mergedInto?: StampedMap<string>;
  aliases?: StampedMap<string>;
  songs?: StampedMap<SongEdit>;
  titles?: StampedMap<string>;
}

export interface AlbumPicturesDoc {
  /** album key → its picture, a small data: image as a playlist's travels */
  covers?: StampedMap<string>;
}

/** The moments of each edit by field: when it was set, or taken away. */
export type EditStamps = Partial<Record<EditField, Record<string, number>>>;

/* ------------------------------------------------------------------ reading */

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const isMoment = (at: unknown): at is number => typeof at === "number" && Number.isFinite(at) && at >= 0;
/** A key read from a document that would change an object's prototype instead of naming something. */
const unsafeKey = (key: string): boolean => !key || key === "__proto__";

function readStamped<T>(raw: unknown, readValue: (v: unknown) => T | undefined): Stamped<T> | undefined {
  const { at, v } = object(raw);
  if (!isMoment(at)) return undefined;
  if (v === undefined || v === null) return { at };
  const value = readValue(v);
  return value === undefined ? undefined : { at, v: value };
}

function readStampedMap<T>(raw: unknown, readValue: (v: unknown) => T | undefined): StampedMap<T> {
  const out: StampedMap<T> = {};
  for (const [key, entry] of Object.entries(object(raw))) {
    if (unsafeKey(key)) continue;
    const stamped = readStamped(entry, readValue);
    if (stamped) out[key] = stamped;
  }
  return out;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const keyList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? [...new Set(v.filter((k): k is string => typeof k === "string" && !!k))] : undefined;
const sortOf = (v: unknown): LibrarySort | undefined => (LIBRARY_SORTS.includes(v as LibrarySort) ? (v as LibrarySort) : undefined);

function songEdit(v: unknown): SongEdit | undefined {
  const { album, albumArtist, artist, trackNo, year } = object(v);
  if (typeof album !== "string" || !album.trim()) return undefined;
  const out: SongEdit = { album };
  if (typeof albumArtist === "string" && albumArtist) out.albumArtist = albumArtist;
  if (typeof artist === "string" && artist) out.artist = artist;
  if (typeof trackNo === "number" && Number.isFinite(trackNo)) out.trackNo = trackNo;
  if (typeof year === "number" && Number.isFinite(year)) out.year = year;
  return out;
}

function readPlayed(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, at] of Object.entries(object(raw))) if (!unsafeKey(key) && isMoment(at)) out[key] = at;
  return out;
}

export function readOrderDoc(raw: unknown): OrderDoc {
  const r = object(raw);
  return compact({ sort: readStamped(r.sort, sortOf), pins: readStamped(r.pins, keyList), played: readPlayed(r.played) });
}

export function readGroupsDoc(raw: unknown): GroupsDoc {
  const r = object(raw);
  return compact({
    library: readStamped(r.library, (v) => (Array.isArray(v) ? readGroups(v) : undefined)),
    explore: readStamped(r.explore, (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? readExploreGroups(v) : undefined)),
  });
}

export function readAlbumEditsDoc(raw: unknown): AlbumEditsDoc {
  const r = object(raw);
  return compact({
    artists: readStampedMap(r.artists, text),
    mergedInto: readStampedMap(r.mergedInto, text),
    aliases: readStampedMap(r.aliases, text),
    songs: readStampedMap(r.songs, songEdit),
    titles: readStampedMap(r.titles, text),
  });
}

export function readAlbumPicturesDoc(raw: unknown): AlbumPicturesDoc {
  return compact({ covers: readStampedMap(object(raw).covers, safeCover) });
}

/** Parts that say nothing are left out: empty maps, no played times. */
function compact<D extends object>(doc: D): D {
  const out = {} as D;
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined || (value !== null && typeof value === "object" && !Object.keys(value).length)) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ comparing */

/** The same JSON whatever order an object's keys came in: two equal documents compare equal. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const sameLibraryDoc = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** The latest moment anything in a document was changed at: the clock here goes on from there. */
export function latestMoment(doc: unknown): number {
  let latest = 0;
  const walk = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || depth > 3) return;
    const at = (value as { at?: unknown }).at;
    if (isMoment(at)) {
      latest = Math.max(latest, at);
      return;
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(doc, 0);
  return latest;
}

/**
 * Moments for changes made here: later than anything this device has seen, whatever its own clock
 * says, so a change made after another device's always counts as the later one.
 */
export function stampClock(seen = 0) {
  let last = seen;
  return {
    saw(at: number): void {
      if (at > last) last = at;
    },
    now(): number {
      last = Math.max(Date.now(), last + 1);
      return last;
    },
    latest: (): number => last,
  };
}

/* ------------------------------------------------------------------ merging */

/**
 * The later of two. With `union`, a device meeting the others for the first time (its side from
 * before syncing) loses nothing it had: what each has stays, the later side's first, the same
 * at the very same moment; so both sides come to the same.
 */
function later<T>(a: Stamped<T> | undefined, b: Stamped<T> | undefined, union?: (first: T, second: T) => T): Stamped<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.at !== b.at && !(union && (fromBefore(a.at) || fromBefore(b.at)))) return a.at > b.at ? a : b;
  const aFirst = a.at > b.at || (a.at === b.at && canonical(a) >= canonical(b));
  const [first, second] = aFirst ? [a, b] : [b, a];
  if (union && first.v !== undefined && second.v !== undefined) return { at: first.at, v: union(first.v, second.v) };
  return first;
}

export function mergeStampedMaps<T>(a: StampedMap<T> = {}, b: StampedMap<T> = {}): StampedMap<T> {
  const out: StampedMap<T> = { ...a };
  for (const [key, entry] of Object.entries(b)) {
    if (unsafeKey(key)) continue;
    out[key] = later(out[key], entry) as Stamped<T>;
  }
  return out;
}

const pinUnion = (first: string[], second: string[]): string[] => [...first, ...second.filter((k) => !first.includes(k))];

/** Played times kept in the document: the latest of them. */
export const MAX_PLAYED_SYNCED = 600;

export function mergePlayed(a: Record<string, number> = {}, b: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [key, at] of Object.entries(b)) if (!unsafeKey(key) && !((out[key] ?? -1) >= at)) out[key] = at;
  const keys = Object.keys(out);
  if (keys.length <= MAX_PLAYED_SYNCED) return out;
  keys.sort((x, y) => out[y] - out[x] || (x < y ? -1 : 1));
  return Object.fromEntries(keys.slice(0, MAX_PLAYED_SYNCED).map((k) => [k, out[k]]));
}

export function mergeOrderDocs(a: OrderDoc, b: OrderDoc): OrderDoc {
  return compact({ sort: later(a.sort, b.sort), pins: later(a.pins, b.pins, pinUnion), played: mergePlayed(a.played, b.played) });
}

const groupUnion = (first: Group[], second: Group[]): Group[] => readGroups([...first, ...second.filter((g) => !first.some((h) => h.id === g.id))]);
const exploreUnion = (first: ExploreGroups, second: ExploreGroups): ExploreGroups => ({
  albums: groupUnion(first.albums, second.albums),
  artists: groupUnion(first.artists, second.artists),
  genres: groupUnion(first.genres, second.genres),
});

export function mergeGroupsDocs(a: GroupsDoc, b: GroupsDoc): GroupsDoc {
  return compact({ library: later(a.library, b.library, groupUnion), explore: later(a.explore, b.explore, exploreUnion) });
}

/**
 * Two devices merging two albums into each other at the same time would leave each shown in the
 * other: the older merge of such a ring is taken back, by a moment just after it, the same on both.
 */
function withoutMergeRings(map: StampedMap<string>): StampedMap<string> {
  const out = { ...map };
  for (const start of Object.keys(out)) {
    const path: string[] = [];
    const seen = new Set<string>();
    let at = start;
    while (out[at]?.v !== undefined && !seen.has(at)) {
      seen.add(at);
      path.push(at);
      at = out[at].v as string;
    }
    if (!seen.has(at)) continue;
    const ring = path.slice(path.indexOf(at));
    const oldest = ring.reduce((x, y) => (out[y].at < out[x].at || (out[y].at === out[x].at && y < x) ? y : x));
    out[oldest] = { at: out[oldest].at + 1 };
  }
  return out;
}

export function mergeAlbumEditsDocs(a: AlbumEditsDoc, b: AlbumEditsDoc): AlbumEditsDoc {
  const out: AlbumEditsDoc = {};
  for (const field of EDIT_FIELDS) {
    const merged = mergeStampedMaps<unknown>(a[field], b[field]);
    if (Object.keys(merged).length) (out as Record<string, unknown>)[field] = merged;
  }
  if (out.mergedInto) out.mergedInto = withoutMergeRings(out.mergedInto);
  return out;
}

export function mergeAlbumPicturesDocs(a: AlbumPicturesDoc, b: AlbumPicturesDoc): AlbumPicturesDoc {
  return compact({ covers: mergeStampedMaps(a.covers, b.covers) });
}

/** How the engine reads and merges each document. */
export const LIBRARY_DOC_KINDS: Record<LibraryDocName, { read(raw: unknown): object; merge(a: object, b: object): object }> = {
  order: { read: readOrderDoc, merge: (a, b) => mergeOrderDocs(a as OrderDoc, b as OrderDoc) },
  groups: { read: readGroupsDoc, merge: (a, b) => mergeGroupsDocs(a as GroupsDoc, b as GroupsDoc) },
  albumedits: { read: readAlbumEditsDoc, merge: (a, b) => mergeAlbumEditsDocs(a as AlbumEditsDoc, b as AlbumEditsDoc) },
  albumpictures: { read: readAlbumPicturesDoc, merge: (a, b) => mergeAlbumPicturesDocs(a as AlbumPicturesDoc, b as AlbumPicturesDoc) },
};

/* ------------------------------------------------------------------ a device's own state */

/** The album edits as a document: each entry with its moment (`old` for one from before syncing), what was taken away with when. */
export function albumEditsDoc(edits: Partial<EditValues>, stamps: EditStamps, old: number): AlbumEditsDoc {
  const doc: AlbumEditsDoc = {};
  for (const field of EDIT_FIELDS) {
    const values = (edits[field] ?? {}) as Record<string, unknown>;
    const times = stamps[field] ?? {};
    const map: StampedMap<unknown> = {};
    for (const key of new Set([...Object.keys(values), ...Object.keys(times)])) {
      if (unsafeKey(key)) continue;
      const v = values[key];
      if (v !== undefined) map[key] = { at: times[key] ?? old, v };
      else if (isMoment(times[key])) map[key] = { at: times[key] };
    }
    if (Object.keys(map).length) (doc as Record<string, unknown>)[field] = map;
  }
  return doc;
}

/** What a document says, as the values a store keeps and their moments. */
export function albumEditsFrom(doc: AlbumEditsDoc): { edits: EditValues; stamps: EditStamps } {
  const edits: EditValues = { artists: {}, mergedInto: {}, aliases: {}, songs: {}, titles: {} };
  const stamps: EditStamps = {};
  for (const field of EDIT_FIELDS) {
    const times: Record<string, number> = {};
    for (const [key, entry] of Object.entries(doc[field] ?? {})) {
      times[key] = entry.at;
      if (entry.v !== undefined) (edits[field] as Record<string, unknown>)[key] = entry.v;
    }
    stamps[field] = times;
  }
  return { edits, stamps };
}

/** Moments for what changed from one state of a map to the next: set, changed or taken away. */
export function restamp<V>(before: Record<string, V> | undefined, after: Record<string, V> | undefined, times: Record<string, number> | undefined, at: number): Record<string, number> {
  const out: Record<string, number> = { ...(times ?? {}) };
  if (before === after) return out;
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (!unsafeKey(key) && canonical(before?.[key]) !== canonical(after?.[key])) out[key] = at;
  }
  return out;
}

export const LIKED_KEY = "liked";

/** What a key names: "album", "playlist", "liked", "artist", "mix", "smart", "genre" … */
export const kindOfKey = (key: string): string => (key === LIKED_KEY ? LIKED_KEY : key.slice(0, Math.max(0, key.indexOf(":"))));

/**
 * The pins as the document should have them: this device's own kinds in its own order, in the
 * places they held, and what only other devices show where it stood. New ones of its own go last.
 */
export function withOwnPins(full: readonly string[], own: readonly string[], isOwn: (key: string) => boolean): string[] {
  const mine = own.filter(isOwn);
  const queue = [...mine];
  const out: string[] = [];
  for (const key of full) {
    if (!isOwn(key)) out.push(key);
    else if (queue.length) out.push(queue.shift() as string);
  }
  out.push(...queue);
  return [...new Set(out)];
}
