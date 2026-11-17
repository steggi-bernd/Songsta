/**
 * Tempo, key and energy shared between your devices through the sync service (the user's wish of
 * 2026-11-16): what one device measured, the others take in instead of measuring it again, and a key
 * set by hand follows you. Two documents of the service, merged by the apps like the library's
 * (lib/librarySync.ts, lib/syncEngine.ts):
 *
 *  - "sounds": the measurements, by song. A whole measurement (a file, its ends known) wins over one
 *    from a server's stretch; two of the same kind are the same song measured twice, and one of them
 *    stays by a fixed rule, so every device ends up with the same document.
 *  - "keys": keys set by hand, by song, each with its moment: the later one wins. Given back, the
 *    moment stays (without a key), so the old correction doesn't come back from another device.
 *
 * Songs are known by a key every device can find: a server song by its server's id (the same on every
 * device signed in to that server), a file by its artist, title and length in seconds (a file's own id
 * comes from its path on that device). Pure, one copy for the desktop and the phone; it imports
 * nothing of the library's documents, they import from here.
 */
import type { SoundFacts } from "../../electron/sound-analysis";

/** A measurement as it travels: short names, a few hundred thousand of them fit a document. */
export interface WireSound {
  /** beats per minute, 0 = no steady beat */
  b: number;
  /** the key's tonic, 0 = C … 11 = B, -1 = no clear key */
  k: number;
  /** minor */
  m?: 1;
  /** energy, 0 … 1 */
  e: number;
  /** loudness, dBFS */
  l: number;
  /** measured from a server's stretch: its ends aren't known */
  x?: 1;
  /** near-silence at the start and the end, seconds; level of the first and the last half second, dBFS (whole measurements only) */
  i?: number;
  o?: number;
  h?: number;
  t?: number;
}

export interface SoundsDoc {
  /** by song key (soundKeyOf) */
  songs?: Record<string, WireSound>;
}

/** A key set by hand as it travels. */
export interface WireKey {
  k: number;
  m?: 1;
}

export interface KeysDoc {
  /** by song key: the key set and when; without `v` it was given back to the measurement then */
  keys?: Record<string, { at: number; v?: WireKey }>;
}

/** What the documents need of a song copy to find its key. */
export interface SongCopy {
  id: string;
  title?: string;
  artist?: string;
  duration?: number;
}

/** A key set by hand on this device (src/stores/keyEdits.ts). */
export interface KeyEditHere {
  key: number;
  minor: boolean;
  at: number;
}

const MAX_KEY_LENGTH = 400;
const norm = (s: string): string => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** The key a song is known by on every device; null for one that can't be told apart (no title, artist or length). */
export function soundKeyOf(t: SongCopy): string | null {
  if (/^(jf|ss):/.test(t.id)) return t.id.length <= MAX_KEY_LENGTH ? t.id : null;
  const title = norm(t.title ?? "");
  const artist = norm(t.artist ?? "");
  const seconds = Math.round(Number(t.duration) || 0);
  if (!title || !artist || seconds <= 0) return null;
  const key = `~${artist}|${title}|${seconds}`;
  return key.length <= MAX_KEY_LENGTH ? key : null;
}

/**
 * Every key a song's measurement may stand under, best first: a server song by its id, then also by artist,
 * title and length, since a computer may have measured the same song as a file of its own.
 */
export function soundKeysOf(t: SongCopy): string[] {
  const own = soundKeyOf(t);
  const named = /^(jf|ss):/.test(t.id) ? soundKeyOf({ ...t, id: "" }) : null;
  return [own, named].filter((key): key is string => !!key);
}

const round = (v: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** A measurement as it travels. */
export function toWireSound(f: SoundFacts): WireSound {
  const w: WireSound = { b: round(f.bpm, 1), k: Math.round(f.key), e: round(f.energy, 3), l: round(f.loudness, 1) };
  if (f.minor) w.m = 1;
  if (f.excerpt) w.x = 1;
  else {
    w.i = round(f.introSilence, 2);
    w.o = round(f.outroSilence, 2);
    w.h = round(f.headDb, 1);
    w.t = round(f.tailDb, 1);
  }
  return w;
}

/** A measurement as it came: one from a stretch keeps its ends unknown, as one measured here would. */
export function fromWireSound(w: WireSound): SoundFacts {
  const whole = !w.x && w.i !== undefined && w.o !== undefined && w.h !== undefined && w.t !== undefined;
  return {
    bpm: w.b,
    key: w.k,
    minor: w.m === 1,
    energy: w.e,
    loudness: w.l,
    introSilence: whole ? (w.i as number) : 0,
    outroSilence: whole ? (w.o as number) : 0,
    headDb: whole ? (w.h as number) : w.l,
    tailDb: whole ? (w.t as number) : w.l,
    ...(whole ? {} : { excerpt: true }),
  };
}

/* ------------------------------------------------------------------ reading */

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const usableKey = (key: string): boolean => !!key && key !== "__proto__" && key.length <= MAX_KEY_LENGTH;
const within = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isMoment = (at: unknown): at is number => typeof at === "number" && Number.isFinite(at) && at >= 0;

function readWireSound(raw: unknown): WireSound | null {
  const r = object(raw);
  if (!within(r.b, 0, 400) || !within(r.k, -1, 11) || !Number.isInteger(r.k) || !within(r.e, 0, 1) || !within(r.l, -200, 20)) return null;
  const w: WireSound = { b: r.b, k: r.k, e: r.e, l: r.l };
  if (r.m === 1) w.m = 1;
  if (r.x === 1) {
    w.x = 1;
    return w;
  }
  if (within(r.i, 0, 7200) && within(r.o, 0, 7200) && within(r.h, -200, 20) && within(r.t, -200, 20)) {
    w.i = r.i;
    w.o = r.o;
    w.h = r.h;
    w.t = r.t;
  } else {
    // Ends that don't read: what holds stays, as from a stretch.
    w.x = 1;
  }
  return w;
}

/** The measurements as the service handed them, read with care. */
export function readSoundsDoc(raw: unknown): SoundsDoc {
  const songs: Record<string, WireSound> = {};
  for (const [key, entry] of Object.entries(object(object(raw).songs))) {
    if (!usableKey(key)) continue;
    const w = readWireSound(entry);
    if (w) songs[key] = w;
  }
  return Object.keys(songs).length ? { songs } : {};
}

/** The keys set by hand as the service handed them, read with care. */
export function readKeysDoc(raw: unknown): KeysDoc {
  const keys: Record<string, { at: number; v?: WireKey }> = {};
  for (const [key, entry] of Object.entries(object(object(raw).keys))) {
    if (!usableKey(key)) continue;
    const { at, v } = object(entry);
    if (!isMoment(at)) continue;
    if (v === undefined || v === null) {
      keys[key] = { at };
      continue;
    }
    const { k, m } = object(v);
    if (!within(k, 0, 11) || !Number.isInteger(k)) continue;
    keys[key] = { at, v: m === 1 ? { k, m: 1 } : { k } };
  }
  return Object.keys(keys).length ? { keys } : {};
}

/* ------------------------------------------------------------------ merging */

/** Of two answers, the one every device picks the same way. */
const fixedPick = <T>(a: T, b: T): T => (JSON.stringify(a) <= JSON.stringify(b) ? a : b);

/** Of two measurements of one song: a whole one over one from a stretch, else the same one on every device. */
function betterSound(a: WireSound, b: WireSound): WireSound {
  if (!a.x !== !b.x) return a.x ? b : a;
  return fixedPick(a, b);
}

export function mergeSoundsDocs(a: SoundsDoc, b: SoundsDoc): SoundsDoc {
  const songs: Record<string, WireSound> = { ...(a.songs ?? {}) };
  for (const [key, w] of Object.entries(b.songs ?? {})) songs[key] = songs[key] ? betterSound(songs[key], w) : w;
  return Object.keys(songs).length ? { songs } : {};
}

export function mergeKeysDocs(a: KeysDoc, b: KeysDoc): KeysDoc {
  const keys: Record<string, { at: number; v?: WireKey }> = { ...(a.keys ?? {}) };
  for (const [key, entry] of Object.entries(b.keys ?? {})) {
    const here = keys[key];
    keys[key] = !here || entry.at > here.at ? entry : entry.at < here.at ? here : fixedPick(here, entry);
  }
  return Object.keys(keys).length ? { keys } : {};
}

/* ------------------------------------------------------------------ a device's own */

/** This device's measurements as the document has them: each copy under its song's key. */
export function soundsDocOf(measured: Record<string, SoundFacts>, copyOf: (id: string) => SongCopy | undefined): SoundsDoc {
  const songs: Record<string, WireSound> = {};
  for (const [id, f] of Object.entries(measured)) {
    const copy = copyOf(id);
    const key = copy ? soundKeyOf(copy) : null;
    if (!key) continue;
    const w = toWireSound(f);
    songs[key] = songs[key] ? betterSound(songs[key], w) : w;
  }
  return Object.keys(songs).length ? { songs } : {};
}

/** The keys set by hand here as the document has them; given back ones with their moment. */
export function keysDocOf(edits: Record<string, KeyEditHere>, gone: Record<string, number>, copyOf: (id: string) => SongCopy | undefined): KeysDoc {
  let doc: KeysDoc = {};
  const put = (id: string, entry: { at: number; v?: WireKey }): void => {
    const copy = copyOf(id);
    const key = copy ? soundKeyOf(copy) : null;
    if (key) doc = mergeKeysDocs(doc, { keys: { [key]: entry } });
  };
  for (const [id, at] of Object.entries(gone)) if (isMoment(at)) put(id, { at });
  for (const [id, edit] of Object.entries(edits)) put(id, { at: edit.at, v: edit.minor ? { k: edit.key, m: 1 } : { k: edit.key } });
  return doc;
}

/** Which of these copies the shared measurements tell about, and that this device hasn't measured itself. */
export function sharedFor(copies: Iterable<SongCopy>, doc: SoundsDoc, measured: Record<string, unknown>): { id: string; facts: SoundFacts }[] {
  const out: { id: string; facts: SoundFacts }[] = [];
  const songs = doc.songs ?? {};
  for (const copy of copies) {
    if (measured[copy.id]) continue;
    const key = soundKeyOf(copy);
    const w = key ? songs[key] : undefined;
    if (w) out.push({ id: copy.id, facts: fromWireSound(w) });
  }
  return out;
}

/** What the shared keys change here, copy by copy: a key set later elsewhere, or given back later. */
export interface KeyChanges {
  set: { id: string; key: number; minor: boolean; at: number }[];
  back: { id: string; at: number }[];
}

export function keyChangesFor(copies: Iterable<SongCopy>, doc: KeysDoc, edits: Record<string, KeyEditHere>, gone: Record<string, number>): KeyChanges {
  const changes: KeyChanges = { set: [], back: [] };
  const keys = doc.keys ?? {};
  for (const copy of copies) {
    const key = soundKeyOf(copy);
    const entry = key ? keys[key] : undefined;
    if (!entry) continue;
    const mine = edits[copy.id];
    const myAt = Math.max(mine?.at ?? -1, gone[copy.id] ?? -1);
    if (entry.at <= myAt) continue;
    if (entry.v) {
      const minor = entry.v.m === 1;
      if (!mine || mine.key !== entry.v.k || mine.minor !== minor || mine.at !== entry.at) changes.set.push({ id: copy.id, key: entry.v.k, minor, at: entry.at });
    } else if (mine || gone[copy.id] !== entry.at) changes.back.push({ id: copy.id, at: entry.at });
  }
  return changes;
}
