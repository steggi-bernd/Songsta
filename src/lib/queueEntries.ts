/**
 * A queue's entries by id, one copy for the computer and the phone (part 3 of the protocol rework,
 * 2026-11-21). A song can be in a queue twice, and two devices can edit one queue at once: an edit made
 * on another device names the entries it means, not songs or places, and lands where those entries stand
 * by the time it arrives (DeviceCommand "editQueue"). Two devices taking out two songs at once: both stay
 * out (Codex, 2026-11-20: the later edit brought back the song the first had taken out).
 *
 * The ids follow the queue by its songs. After every change the old and the new order are lined up
 * (lineUp, Myers' diff): an entry that stayed keeps its id, one moved keeps its id too, a new one gets a
 * new id, or the id the device that put it in named (expect). A change that keeps less than half of both
 * the old and the new list, or a list after none, is a new list: a new session, all new ids. The device
 * playing says the ids with its queue document (QueueDoc.entries and .session); a device following it
 * keeps them with its copy of that queue and says its edits by them (editsBetween).
 */
import type { WireTrack } from "./playlistSync";

export type QueueOp =
  /** that entry goes */
  | { op: "remove"; entry: string }
  /** that entry right behind the first of `after` still there; none named: at the very top */
  | { op: "move"; entry: string; after: string[] }
  /** these songs in, behind the first of `after` still there, under these ids (one for each song) */
  | { op: "insert"; after: string[]; tracks: WireTrack[]; entries: string[] }
  /** everything after the song playing goes */
  | { op: "clear" }
  /** what was asked for by hand goes */
  | { op: "clearLine" };

/** The queue as it stood once: its songs (by key), their entries, the song playing. */
export interface EntryState {
  session: string;
  keys: readonly string[];
  ids: readonly string[];
  index: number;
}

/** How many edits two orders may be apart and still be lined up exactly; further apart (a shuffle), by their songs. */
const EXACT_UP_TO = 200;
/** How many states of a queue are kept, for an edit an older app made on one of them. */
const STATES_KEPT = 24;
/** An edit names this many entries it goes behind, the nearest first, in case another device took some out. */
const ANCHORS = 3;
/** An edit from an older app lines up with the state it was made on within this many edits, or it's taken as before. */
const LIST_EDITS_UP_TO = 64;
/** How far around its place the last song an older app saw is looked for (syncEngine ANCHOR_REACH). */
const ANCHOR_REACH = 64;
/** More edits than this in one command aren't read. */
const MOST_OPS = 2000;

export function randomId(): string {
  return `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Pairs [i, j] with a[i] === b[j], in order, along a shortest way from a to b (Myers' diff), or null when
 * that takes more than `most` edits. What two orders share at their start and their end lines up at once,
 * so an edit in a long queue costs little.
 */
export function lineUp(a: readonly string[], b: readonly string[], most: number): Array<[number, number]> | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = shortestEdit(a, start, endA, b, start, endB, most);
  if (!middle) return null;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  for (const pair of middle) pairs.push(pair);
  for (let k = 0; endA + k < a.length; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

function shortestEdit(a: readonly string[], a0: number, a1: number, b: readonly string[], b0: number, b1: number, most: number): Array<[number, number]> | null {
  const n = a1 - a0;
  const m = b1 - b0;
  if (!n || !m) return [];
  const off = most + 1;
  const v = new Int32Array(2 * most + 3);
  // How far along a each diagonal k got before step d, for d = 0, 1, …: kept from -d-1 to d+1.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= most; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, a0, b0);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, a0: number, b0: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const at = (k: number): number => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([a0 + x, b0 + y]);
    }
    x = prevX;
    y = prevY;
  }
  return pairs.reverse();
}

/** How many entries two orders have in common by their songs, wherever they stand. */
function sharedCount(a: readonly string[], b: readonly string[]): number {
  const count = new Map<string, number>();
  for (const key of a) count.set(key, (count.get(key) ?? 0) + 1);
  let shared = 0;
  for (const key of b) {
    const left = count.get(key) ?? 0;
    if (left <= 0) continue;
    count.set(key, left - 1);
    shared += 1;
  }
  return shared;
}

/** Lined up exactly where they're close; orders far apart (a shuffle) by their songs, each song's entries in their order. */
function pairUp(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const exact = lineUp(a, b, EXACT_UP_TO);
  if (exact) return exact;
  const places = new Map<string, number[]>();
  a.forEach((key, i) => push(places, key, i));
  const pairs: Array<[number, number]> = [];
  b.forEach((key, j) => {
    const i = places.get(key)?.shift();
    if (i !== undefined) pairs.push([i, j]);
  });
  return pairs;
}

/** An edit by place, about to be made: an entry taken out, one moved (to its place in the list after). */
export type ForeseenChange = { remove: number } | { move: [number, number] } | { start: true };

export interface EntryBook {
  session(): string;
  /** the queue's songs (by key), as last followed */
  keys(): readonly string[];
  /**
   * The edit about to be made, by place: the ids follow it exactly, where lining up songs can't tell two
   * copies side by side apart (Codex, 2026-11-21: of A X X B, the second X taken out after the first left
   * the first one's id on it, and the second removal found nothing). Unused by the end of the turn, it goes.
   */
  foresee(change: ForeseenChange): void;
  /** the entries of the queue as it is now, one id for each */
  ids(): readonly string[];
  indexOf(id: string): number;
  /** After every change of the queue or of the song playing: its songs (by key) and where it plays. */
  follow(keys: readonly string[], index: number): void;
  /** A queue taken from another device, with the ids it said for the songs of it found here (none said: new ones). */
  seed(keys: readonly string[], index: number, ids: readonly (string | undefined)[], session?: string): void;
  /** The next new entries of these songs get these ids: another device put them in and named them. */
  expect(named: ReadonlyArray<{ key: string; id: string }>): void;
  /** The states this queue stood in lately, the newest first; a new list forgets the old one's. */
  states(): readonly EntryState[];
}

export function createEntryBook(newId: () => string = randomId): EntryBook {
  let session = newId();
  let keys: readonly string[] = [];
  let ids: readonly string[] = [];
  let index = 0;
  let named: Array<{ key: string; id: string }> = [];
  let namedTurn = 0;
  let foreseen: ForeseenChange | null = null;
  let foreseenTurn = 0;
  /** The arrays after a foreseen change; null when it doesn't fit them. */
  const applied = (change: Exclude<ForeseenChange, { start: true }>): { keys: string[]; ids: string[] } | null => {
    const k = keys.slice();
    const i = ids.slice();
    if ("remove" in change) {
      if (change.remove < 0 || change.remove >= k.length) return null;
      k.splice(change.remove, 1);
      i.splice(change.remove, 1);
      return { keys: k, ids: i };
    }
    const [from, to] = change.move;
    if (from < 0 || from >= k.length || to < 0 || to >= k.length) return null;
    const [movedKey] = k.splice(from, 1);
    k.splice(to, 0, movedKey);
    const [movedId] = i.splice(from, 1);
    i.splice(to, 0, movedId);
    return { keys: k, ids: i };
  };
  let states: EntryState[] = [];
  const remember = (): void => {
    states.unshift({ session, keys, ids, index });
    if (states.length > STATES_KEPT) states.length = STATES_KEPT;
  };
  return {
    session: () => session,
    keys: () => keys,
    ids: () => ids,
    indexOf: (id) => ids.indexOf(id),
    foresee(change) {
      foreseen = change;
      const turn = ++foreseenTurn;
      queueMicrotask(() => {
        if (foreseenTurn === turn) foreseen = null;
      });
    },
    follow(next, at) {
      const change = foreseen;
      if (change && "start" in change) {
        foreseen = null;
        this.seed(next, at, []);
        return;
      }
      if (same(keys, next)) {
        if (at !== index) {
          index = at;
          remember();
        }
        return;
      }
      // The edit said ahead, and it's what happened: its entries, exactly.
      foreseen = null;
      const exact = change ? applied(change) : null;
      if (exact && same(exact.keys, next)) {
        keys = exact.keys;
        ids = exact.ids;
        index = at;
        remember();
        return;
      }
      // A new list: fewer than half of the songs on either side are on the other (moved ones count: a shuffle is no new list).
      const shared = sharedCount(keys, next);
      const fresh = !keys.length || (shared * 2 < keys.length && shared * 2 < next.length);
      // Lined up only when the entries carry over: a new list gets new ids anyway (Codex, section 16: a switch
      // between two 10,000-song lists took half the time).
      const pairs = fresh ? [] : pairUp(keys, next);
      if (fresh) {
        session = newId();
        states = [];
      }
      const out: Array<string | undefined> = new Array(next.length);
      const used = new Set<string>();
      if (!fresh) {
        for (const [i, j] of pairs) {
          out[j] = ids[i];
          used.add(ids[i]);
        }
      }
      // Put in on another device, under the ids it named.
      const wanted = new Map<string, string[]>();
      for (const n of named) push(wanted, n.key, n.id);
      for (let j = 0; j < next.length; j++) {
        if (out[j] !== undefined) continue;
        const id = wanted.get(next[j])?.shift();
        if (id !== undefined && !used.has(id)) {
          out[j] = id;
          used.add(id);
        }
      }
      // Moved: an entry gone from one place, its song new at another, keeps its id.
      if (!fresh) {
        const matched = new Set(pairs.map(([i]) => i));
        const left = new Map<string, number[]>();
        keys.forEach((key, i) => {
          if (!matched.has(i) && !used.has(ids[i])) push(left, key, i);
        });
        for (let j = 0; j < next.length; j++) {
          if (out[j] !== undefined) continue;
          const i = left.get(next[j])?.shift();
          if (i === undefined) continue;
          out[j] = ids[i];
          used.add(ids[i]);
        }
      }
      for (let j = 0; j < next.length; j++) if (out[j] === undefined) out[j] = newId();
      keys = next.slice();
      ids = out as string[];
      index = at;
      named = named.filter((n) => !used.has(n.id));
      remember();
    },
    seed(next, at, given, givenSession) {
      session = givenSession || newId();
      states = [];
      const used = new Set<string>();
      ids = next.map((_, j) => {
        const id = given[j];
        if (typeof id === "string" && id && !used.has(id)) {
          used.add(id);
          return id;
        }
        return newId();
      });
      keys = next.slice();
      index = at;
      named = [];
      remember();
    },
    expect(list) {
      named = [...list];
      // Meant for the change being made now, maybe in a few steps: what it didn't use goes with this turn.
      const turn = ++namedTurn;
      if (named.length) queueMicrotask(() => {
        if (namedTurn === turn) named = [];
      });
    },
    states: () => states,
  };
}

/** Indices of a longest strictly rising run through `values` (not necessarily next to each other). */
function longestRising(values: readonly number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(i);
  return out.reverse();
}

/**
 * An edit made here on a copy of another device's queue, as edits of its entries for the device playing
 * it, which applies them where those entries stand there by then (applyEdits): what went, what moved and
 * behind what, what's new and behind what. `before` and `after`: the entries' ids before and after the
 * edit; `songAt(j)`: the song at place j after it, for the new ones.
 */
export function editsBetween(before: readonly string[], after: readonly string[], songAt: (j: number) => WireTrack | undefined): QueueOp[] {
  const was = new Map<string, number>();
  before.forEach((id, i) => was.set(id, i));
  const now = new Set(after);
  const ops: QueueOp[] = [];
  for (const id of before) if (!now.has(id)) ops.push({ op: "remove", entry: id });
  // Of the entries on both sides, the most that are still in their order stay; the others moved.
  const common = after.filter((id) => was.has(id));
  const stay = new Set(longestRising(common.map((id) => was.get(id) as number)).map((k) => common[k]));
  const placed: string[] = [];
  const anchors = (): string[] => placed.slice(-ANCHORS).reverse();
  let adding: Extract<QueueOp, { op: "insert" }> | null = null;
  for (let j = 0; j < after.length; j++) {
    const id = after[j];
    if (!was.has(id)) {
      const track = songAt(j);
      if (!track) continue;
      if (!adding) {
        adding = { op: "insert", after: anchors(), tracks: [], entries: [] };
        ops.push(adding);
      }
      adding.tracks.push(track);
      adding.entries.push(id);
      placed.push(id);
      continue;
    }
    adding = null;
    if (!stay.has(id)) ops.push({ op: "move", entry: id, after: anchors() });
    placed.push(id);
  }
  return ops;
}

/**
 * Two devices' changes to one order of distinct ids (Liked Songs' order, plan section 5), both kept: what
 * changed here since `base` (taken out, added, moved) applied to `theirs`, the order another device wrote
 * meanwhile. One moved up goes in front of the song it was put before, one moved down behind the one it
 * was put after, so the other device's moves around it stay; a song moved on both stands where it was put
 * here (the change made last). Added here: behind the song before it here.
 */
export function mergeOrder(base: readonly string[], mine: readonly string[], theirs: readonly string[]): string[] {
  // Nothing changed here since the order agreed on: theirs, as it is (Codex, section 16: 10,000 favorites
  // in a hundredth of the time). A list of its own.
  if (same(base, mine)) return theirs.slice();
  const was = new Map<string, number>();
  base.forEach((id, i) => was.set(id, i));
  const here = new Set(mine);
  const result = theirs.filter((id) => !(was.has(id) && !here.has(id)));
  const common = mine.filter((id) => was.has(id));
  const stay = new Set(longestRising(common.map((id) => was.get(id) as number)).map((k) => common[k]));
  for (let j = 0; j < mine.length; j++) {
    const id = mine[j];
    if (stay.has(id)) continue;
    const at = result.indexOf(id);
    if (at >= 0) result.splice(at, 1);
    // Put at the very top or the very end here: there too.
    if (j === 0) {
      result.unshift(id);
      continue;
    }
    if (j === mine.length - 1) {
      result.push(id);
      continue;
    }
    // Moved up: in front of the next song that stayed; else behind the song before it here.
    const next = mine.slice(j + 1).find((n) => stay.has(n) && result.includes(n));
    if (next !== undefined && was.has(id) && (was.get(id) as number) > (was.get(next) as number)) {
      result.splice(result.indexOf(next), 0, id);
      continue;
    }
    let place = 0;
    for (let k = j - 1; k >= 0; k--) {
      const p = result.indexOf(mine[k]);
      if (p >= 0) {
        place = p + 1;
        break;
      }
    }
    result.splice(place, 0, id);
  }
  return result;
}

/** What the device applying edits does to its own queue. */
export interface EditPlayer<T> {
  index(): number;
  /** where the songs asked for by hand end: songs whose place is gone go there */
  lineEnd(): number;
  /** these songs as this device has them; undefined for one it doesn't */
  songs(tracks: readonly WireTrack[]): Array<T | undefined>;
  key(song: T): string;
  remove(at: number): void;
  move(from: number, to: number): void;
  insert(songs: T[], at: number): void;
  clear(): void;
  clearLine(): void;
}

/**
 * Edits from another device, where their entries stand now. A remove finds nothing when its entry went
 * meanwhile, and an entry that started playing meanwhile plays on, unless it was the one playing there
 * too (`playing`: the entry playing where the edit was made). A move or new songs go behind the first of
 * their anchors still there; a move whose anchors all went stays put, new songs whose anchors all went
 * go behind what was asked for by hand. "partial" when something found nothing to apply to.
 */
export function applyEdits<T>(book: EntryBook, ops: readonly QueueOp[], player: EditPlayer<T>, playing?: string): "done" | "partial" {
  let missed = 0;
  const slotAfter = (after: readonly string[]): number | null => {
    if (!after.length) return 0;
    for (const id of after) {
      const at = book.indexOf(id);
      if (at >= 0) return at + 1;
    }
    return null;
  };
  for (const op of ops) {
    const before = book.ids();
    switch (op.op) {
      case "clear":
        player.clear();
        continue;
      case "clearLine":
        player.clearLine();
        continue;
      case "remove": {
        const at = book.indexOf(op.entry);
        if (at >= 0 && (at !== player.index() || op.entry === playing)) {
          book.foresee({ remove: at });
          player.remove(at);
        }
        break;
      }
      case "move": {
        const from = book.indexOf(op.entry);
        const slot = slotAfter(op.after);
        if (from < 0 || slot === null) break;
        const to = from < slot ? slot - 1 : slot;
        if (to === from) continue;
        book.foresee({ move: [from, to] });
        player.move(from, to);
        break;
      }
      case "insert": {
        const songs: T[] = [];
        const named: Array<{ key: string; id: string }> = [];
        player.songs(op.tracks).forEach((song, i) => {
          if (!song) return;
          songs.push(song);
          const id = op.entries[i];
          if (typeof id === "string") named.push({ key: player.key(song), id });
        });
        if (!songs.length) break;
        const slot = slotAfter(op.after) ?? player.lineEnd();
        book.expect(named);
        player.insert(songs, slot);
        book.expect([]);
        break;
      }
      default:
        continue;
    }
    if (book.ids() === before) missed++;
  }
  return missed ? "partial" : "done";
}

/** How much of a queue an app that sends the whole list saw: this many songs after the song playing, up to this one. */
export interface ListReach {
  ahead: number;
  /** the last song it saw, by key, when it says: looked for near its place in each state */
  anchor?: string;
}

/** Where a song stands near `ahead` places after the song playing, or -1 (syncEngine anchorPlace, by key). */
function nearby(keys: readonly string[], index: number, ahead: number, key: string): number {
  const at = index + Math.max(1, ahead);
  if (at < keys.length && keys[at] === key) return at;
  for (let d = 1; d <= ANCHOR_REACH; d++) {
    if (at - d > index && at - d < keys.length && keys[at - d] === key) return at - d;
    if (at + d < keys.length && keys[at + d] === key) return at + d;
  }
  return -1;
}

/**
 * What an app that sends the whole of what comes after the song playing (setUpcoming: every app before
 * edits by entry) changed, as edits of entries: its list lined up against the queue as it stood when that
 * app saw it, the closest of the last few states, as far as it saw then (`reach`). Two such edits made on
 * the same queue both stay, and what that app never saw stays as it is (Codex, 2026-11-20). Null when no
 * state is close enough, or nothing comes at all (a clear): then the edit is taken as before.
 */
export function editsFromList(book: EntryBook, sent: readonly string[], reach: ListReach, songAt: (j: number) => WireTrack | undefined): QueueOp[] | null {
  if (!sent.length) return null;
  type Fit = { far: number; state: EntryState; end: number; pairs: Array<[number, number]> };
  const closest = (playing: string | undefined): Fit | null => {
    let best: Fit | null = null;
    for (const state of book.states()) {
      if (state.session !== book.session()) continue;
      if (playing !== undefined && state.ids[state.index] !== playing) continue;
      const from = state.index + 1;
      const anchored = reach.anchor === undefined ? -1 : nearby(state.keys, state.index, reach.ahead, reach.anchor);
      const end = anchored >= 0 ? anchored + 1 : from + reach.ahead;
      const seen = state.keys.slice(from, end);
      const pairs = lineUp(seen, sent, LIST_EDITS_UP_TO);
      if (!pairs) continue;
      const far = seen.length + sent.length - 2 * pairs.length;
      if (!best || far < best.far) best = { far, state, end, pairs };
      if (!far) break;
    }
    return best;
  };
  // That app's copy goes along with the song playing here, so the states with the same entry playing come
  // first: an older one with another song playing can look the same by chance ("the next song taken out"
  // looks like the state where that song was playing), and would lose the edit.
  const now = book.states()[0];
  const best = closest(now ? now.ids[now.index] : undefined) ?? closest(undefined);
  if (!best) return null;
  const { state, end, pairs } = best;
  const from = state.index + 1;
  const seenIds = state.ids.slice(from, end);
  const seenKeys = state.keys.slice(from, end);
  const sentIds: Array<string | undefined> = new Array(sent.length);
  const matched = new Set<number>();
  for (const [i, j] of pairs) {
    sentIds[j] = seenIds[i];
    matched.add(i);
  }
  // Moved there: gone from one place, the same song new at another.
  const left = new Map<string, number[]>();
  seenKeys.forEach((key, i) => {
    if (!matched.has(i)) push(left, key, i);
  });
  for (let j = 0; j < sent.length; j++) {
    if (sentIds[j] !== undefined) continue;
    const i = left.get(sent[j])?.shift();
    sentIds[j] = i !== undefined ? seenIds[i] : randomId();
  }
  const playing = state.ids[state.index];
  const head = playing === undefined ? [] : [playing];
  return editsBetween([...head, ...seenIds], [...head, ...(sentIds as string[])], (j) => (j >= head.length ? songAt(j - head.length) : undefined));
}

const isWire = (t: unknown): t is WireTrack => !!t && typeof t === "object" && typeof (t as { id?: unknown }).id === "string";
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Edits as another device sent them, whatever came: what isn't an edit is left out. */
export function readOps(raw: unknown): QueueOp[] {
  if (!Array.isArray(raw)) return [];
  const out: QueueOp[] = [];
  for (const op of raw.slice(0, MOST_OPS)) {
    if (!op || typeof op !== "object") continue;
    const o = op as Record<string, unknown>;
    if (o.op === "clear" || o.op === "clearLine") out.push({ op: o.op });
    else if (o.op === "remove" && typeof o.entry === "string") out.push({ op: "remove", entry: o.entry });
    else if (o.op === "move" && typeof o.entry === "string" && isIds(o.after)) out.push({ op: "move", entry: o.entry, after: o.after.slice(0, ANCHORS) });
    else if (o.op === "insert" && isIds(o.after) && Array.isArray(o.tracks) && isIds(o.entries)) {
      const tracks: WireTrack[] = [];
      const entries: string[] = [];
      o.tracks.forEach((track, i) => {
        const id = (o.entries as string[])[i];
        if (!isWire(track) || typeof id !== "string") return;
        tracks.push(track);
        entries.push(id);
      });
      if (tracks.length) out.push({ op: "insert", after: o.after.slice(0, ANCHORS), tracks, entries });
    }
  }
  return out;
}
