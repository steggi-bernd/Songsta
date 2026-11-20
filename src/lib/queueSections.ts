/**
 * What the queue shows of the songs asked for by hand, on the computer and the
 * phone: one by one, first come, first played. A branch brings its whole list,
 * so it gets a line of its own, shows its first few songs and folds the rest into
 * one row until opened.
 */

/** A branch in a queue: the list it came from (one branch per list), its first song, and the songs it brought. */
export interface QueueBranch {
  name: string;
  trackId: string;
  /** its first song has come on: nothing is chosen any more, though it can still be taken back */
  started: boolean;
  ids: string[];
}

export type HandRow<T> =
  | { kind: "song"; track: T; at: number; branch: string | null }
  /** a branch begins: how many of its songs are in line, and whether some of them fold */
  | { kind: "branch"; branch: string; count: number; folds: boolean }
  | { kind: "more"; branch: string; count: number };

/** A branch's songs shown before the rest folds. */
const SHOWN_OF_A_BRANCH = 3;

export function handRows<T extends { id: string }>(queue: T[], index: number, lineEnd: number, branches: QueueBranch[], opened: ReadonlySet<string> = new Set()): HandRow<T>[] {
  const end = Math.min(queue.length, Math.max(index + 1, lineEnd));
  const owner = new Map<string, string>();
  for (const b of branches) for (const id of b.ids) if (!owner.has(id)) owner.set(id, b.name);
  const rows: HandRow<T>[] = [];
  let at = index + 1;
  while (at < end) {
    const branch = owner.get(queue[at].id) ?? null;
    if (!branch) {
      rows.push({ kind: "song", track: queue[at], at, branch });
      at += 1;
      continue;
    }
    let stop = at + 1;
    while (stop < end && owner.get(queue[stop].id) === branch) stop += 1;
    const count = stop - at;
    const folds = count > SHOWN_OF_A_BRANCH;
    const shown = !folds || opened.has(branch) ? count : SHOWN_OF_A_BRANCH;
    rows.push({ kind: "branch", branch, count, folds });
    for (let i = 0; i < shown; i++) rows.push({ kind: "song", track: queue[at + i], at: at + i, branch });
    if (shown < count) rows.push({ kind: "more", branch, count: count - shown });
    at = stop;
  }
  return rows;
}

/**
 * The branches as the queue stands now. One whose songs are all behind goes. A
 * chosen song taken out hands its mark to the next one of the branch. `started`:
 * its first song is on or behind, so going back before it makes it chosen again.
 */
export function tendedBranches<T extends { id: string }>(branches: QueueBranch[], queue: T[], index: number): QueueBranch[] {
  if (!branches.length) return branches;
  const upcoming = new Set(queue.slice(index + 1).map((t) => t.id));
  const current = queue[index]?.id;
  const ahead = (id: string): boolean => id === current || upcoming.has(id);
  let changed = false;
  const next: QueueBranch[] = [];
  for (const b of branches) {
    if (!b.ids.some(ahead)) {
      changed = true;
      continue;
    }
    const trackId = b.started || ahead(b.trackId) ? b.trackId : (b.ids.find(ahead) ?? b.trackId);
    const started = !upcoming.has(trackId);
    if (trackId !== b.trackId || started !== b.started) {
      changed = true;
      next.push({ ...b, trackId, started });
    } else {
      next.push(b);
    }
  }
  return changed ? next : branches;
}

/** These songs aren't a branch's any more: asked for by hand, taken out, or in a newer branch. A branch left with none goes. */
export function withoutSongs(branches: QueueBranch[], songs: ReadonlySet<string>): QueueBranch[] {
  let changed = false;
  const next: QueueBranch[] = [];
  for (const b of branches) {
    if (!b.ids.some((id) => songs.has(id))) {
      next.push(b);
      continue;
    }
    changed = true;
    const ids = b.ids.filter((id) => !songs.has(id));
    if (ids.length) next.push({ ...b, ids, trackId: ids.includes(b.trackId) ? b.trackId : ids[0] });
  }
  return changed ? next : branches;
}

/**
 * What's coming, with what a branch took out of it back: each song behind the one it
 * came after back then, what's there now staying as it stands. `before` is what was
 * coming when the branch was made.
 */
export function putBack<T>(before: T[], now: T[], taken: (song: T) => boolean, keyOf: (song: T) => string): T[] {
  const here = new Set(now.map(keyOf));
  const behind = new Map<string, T[]>();
  let anchor = "";
  for (const song of before) {
    const key = keyOf(song);
    if (here.has(key)) {
      anchor = key;
    } else if (taken(song)) {
      const list = behind.get(anchor);
      if (list) list.push(song);
      else behind.set(anchor, [song]);
    }
  }
  const out = [...(behind.get("") ?? [])];
  for (const song of now) {
    out.push(song);
    const more = behind.get(keyOf(song));
    if (more) out.push(...more);
  }
  return out;
}

/**
 * Where a song asked for by name stands in the queue. It can be there twice: heard
 * already, and asked for again. `by`: how far from the playing song it was seen,
 * which settles it; else its nearest copy, ahead rather than behind.
 */
export function placeOf<T extends { id: string }>(queue: T[], id: string, index: number, by?: number, keyOf: (song: T) => string = (song) => song.id): number {
  if (by !== undefined && queue[index + by] && keyOf(queue[index + by]) === id) return index + by;
  let best = -1;
  queue.forEach((song, i) => {
    if (keyOf(song) !== id) return;
    if (best < 0 || Math.abs(i - index) <= Math.abs(best - index)) best = i;
  });
  return best;
}

/**
 * The song a device is asked to go to, in its own queue. One step along the list needs no name to
 * agree on: two devices can know one song by different copies.
 */
export function jumpTarget<T extends { id: string }>(queue: T[], id: string, index: number, by?: number, keyOf: (song: T) => string = (song) => song.id): number {
  const at = placeOf(queue, id, index, by, keyOf);
  if (at >= 0) return at;
  return (by === 1 || by === -1) && queue[index + by] ? index + by : -1;
}

/** The part of a list around a song that goes along to another device. */
export function listAround<T extends { id: string }>(list: T[], id: string, behind: number, ahead: number): T[] {
  const at = Math.max(0, list.findIndex((t) => t.id === id));
  return list.slice(Math.max(0, at - behind), at + ahead);
}

/** A queue's hand-made part as it goes between devices: in the list that's sent, whose start may be cut off. */
export function lineInList(lineEnd: number, from: number): number {
  return Math.max(0, lineEnd - from);
}

/**
 * A shuffled list's own order once everything after the song playing is cleared: nothing after that
 * song, so turning shuffle off brings none of it back. Turning it off finds the song the same way.
 */
export function orderUpTo<T extends { id: string }>(order: T[], queue: T[], index: number): T[] {
  const at = order.findIndex((t) => t.id === queue[index]?.id);
  return at >= 0 ? order.slice(0, at + 1) : queue.slice(0, index + 1);
}

/** Songs that left what's to come leave the shuffled list's own order too, unless they're still to come. */
export function orderWithout<T extends { id: string }>(order: T[], left: readonly T[], coming: readonly T[], keyOf: (song: T) => string = (song) => song.id): T[] {
  const stays = new Set(coming.map(keyOf));
  const gone = new Set(left.map(keyOf).filter((key) => !stays.has(key)));
  return gone.size ? order.filter((t) => !gone.has(keyOf(t))) : order;
}
