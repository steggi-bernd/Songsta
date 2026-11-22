/**
 * The queue's rules, one copy for the computer and the phone: what comes after the song playing, the
 * songs asked for by hand (the line), branches of a list, the shuffled list's own order, and edits made
 * on another device. Every fix in these rules used to be made twice, once in each app's store.
 *
 * Pure: each function takes the queue as it stands and answers the fields that change. The stores apply
 * them and do their own part around them (the phone's native player, the computer's steering of another
 * device, the undo of branches). `key` says which ids are the same song: on the computer a song can stand
 * as a local file and as the server's copy (stores/catalog.ts songKey); on the phone an id is a song.
 */
import { orderUpTo, orderWithout, putBack, withoutSongs, type QueueBranch } from "./queueSections";

export interface QueueState<T> {
  queue: T[];
  index: number;
  /** where the songs asked for by hand end (0 when there are none) */
  lineEnd: number;
  /** the list's own order while shuffle is on */
  unshuffled: T[] | null;
  branches: QueueBranch[];
}

/** What a branch changed, kept while it can still be taken back. */
export interface BranchUndo<T> {
  before: T[];
  unshuffled: T[] | null;
}

type Song = { id: string };
type Key = (id: string) => string;
const sameId: Key = (id) => id;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Where the songs asked for by hand end: the next one asked for goes here. */
export function lineEndOf(s: { queue: unknown[]; index: number; lineEnd: number }): number {
  return clamp(s.lineEnd, s.index + 1, s.queue.length);
}

/** Songs asked for, in the list's own order: right where they were asked for, once shuffle goes off. */
export function intoOrder<T extends Song>(order: T[], current: T | undefined, skip: number, tracks: T[]): T[] {
  const asked = new Set(tracks.map((t) => t.id));
  const from = order.findIndex((t) => t.id === current?.id) + 1 + skip;
  return [...order.slice(0, from).filter((t) => !asked.has(t.id)), ...tracks, ...order.slice(from).filter((t) => !asked.has(t.id))];
}

/** Everything after the song playing goes, out of the list's own order too: shuffle going off brings none of it back. */
export function clearComing<T extends Song>(s: QueueState<T>): Pick<QueueState<T>, "queue" | "lineEnd" | "branches" | "unshuffled"> {
  return { queue: s.queue.slice(0, s.index + 1), lineEnd: 0, branches: [], unshuffled: s.unshuffled && orderUpTo(s.unshuffled, s.queue, s.index) };
}

/**
 * The songs asked for by hand go (their branches taken back first, by the caller), from the list's own
 * order as well: shuffle going off doesn't bring them back.
 */
export function clearHandMade<T extends Song>(s: QueueState<T>, key: Key = sameId): Pick<QueueState<T>, "queue" | "lineEnd" | "unshuffled"> {
  const end = lineEndOf(s);
  const rest = s.queue.slice(end);
  return {
    queue: [...s.queue.slice(0, s.index + 1), ...rest],
    lineEnd: 0,
    unshuffled: s.unshuffled && orderWithout(s.unshuffled, s.queue.slice(s.index + 1, end), rest, (t) => key(t.id)),
  };
}

/** A branch taken back: what it took out of what was coming goes back to where it was, unless it was heard meanwhile. */
export function takeBack<T extends Song>(s: QueueState<T>, branch: QueueBranch, undo: BranchUndo<T> | undefined, key: Key = sameId): Pick<QueueState<T>, "queue" | "lineEnd" | "unshuffled" | "branches"> {
  const { queue, index, unshuffled, branches } = s;
  const ids = new Set(branch.ids.map(key));
  const brought = (t: T): boolean => ids.has(key(t.id));
  const end = lineEndOf(s);
  const line = queue.slice(index + 1, end).filter((t) => !brought(t));
  const left = queue.slice(end).filter((t) => !brought(t));
  const heard = new Set(queue.slice(0, index + 1).map((t) => key(t.id)));
  const coming = undo ? putBack(undo.before, left, (t) => brought(t) && !heard.has(key(t.id)), (t) => key(t.id)) : left;
  const inOrder = new Set(undo?.unshuffled?.map((t) => key(t.id)));
  return {
    queue: [...queue.slice(0, index + 1), ...line, ...coming],
    lineEnd: index + 1 + line.length,
    unshuffled: undo?.unshuffled && unshuffled ? [...undo.unshuffled, ...unshuffled.filter((t) => !inOrder.has(key(t.id)) && !brought(t))] : unshuffled && unshuffled.filter((t) => !brought(t)),
    branches: branches.filter((b) => b.name !== branch.name),
  };
}

/**
 * Songs asked for by hand: behind the ones asked for before, first come, first played. One already in the
 * line stays where it is; one further down comes up from there instead of playing twice. Needs a song on.
 */
export function enqueue<T extends Song>(s: QueueState<T>, tracks: T[], key: Key = sameId): { at: number; fresh: T[]; state: Pick<QueueState<T>, "queue" | "lineEnd" | "unshuffled" | "branches"> } {
  const { queue, index, unshuffled, branches } = s;
  const at = lineEndOf(s);
  const waiting = new Set(queue.slice(index + 1, at).map((t) => key(t.id)));
  const fresh = tracks.filter((t) => !waiting.has(key(t.id)));
  const asked = new Set(fresh.map((t) => key(t.id)));
  return {
    at,
    fresh,
    state: {
      queue: [...queue.slice(0, at), ...fresh, ...queue.slice(at).filter((t) => !asked.has(key(t.id)))],
      lineEnd: at + fresh.length,
      unshuffled: unshuffled && intoOrder(unshuffled, queue[index], at - index - 1, fresh),
      branches: withoutSongs(branches, new Set(fresh.map((t) => t.id))),
    },
  };
}

/**
 * The list's own order (shuffle on) with a branch in it: right behind the song playing and the songs asked
 * for by hand that stay, its songs out of the rest. The song playing keeps its place, also when it's one
 * of the branch: shuffle going off goes on from it (Codex, 2026-11-21: the computer's rule took it out,
 * so the branch went to the front and shuffle off didn't bring the list back; the phone's had it right).
 */
function branchedOrder<T extends Song>(order: T[], current: T | undefined, lineKept: number, next: T[], key: Key): T[] {
  const inBranch = new Set(next.map((t) => key(t.id)));
  const at = current ? order.findIndex((t) => key(t.id) === key(current.id)) : -1;
  if (at < 0) return [...order.filter((t) => !inBranch.has(key(t.id))), ...next];
  const after = order.slice(at + 1).filter((t) => !inBranch.has(key(t.id)));
  return [...order.slice(0, at + 1), ...after.slice(0, lineKept), ...next, ...after.slice(lineKept)];
}

/**
 * A list's songs from one of them on, as a branch behind what was asked for by hand (or at `pos`): a song
 * of it already in the line plays with the branch, once; from the very song playing, the list just plays
 * on behind it. Needs a song on; another branch of the same list is taken back first, by the caller.
 */
export function branchOff<T extends Song>(s: QueueState<T>, rest: T[], name: string, key: Key = sameId, pos?: number): { undo: BranchUndo<T>; startsHere: boolean; state: Pick<QueueState<T>, "queue" | "lineEnd" | "unshuffled" | "branches"> } {
  const { queue, index, unshuffled, branches } = s;
  const current = queue[index];
  const startsHere = !!current && key(rest[0].id) === key(current.id);
  const next = startsHere ? rest.slice(1) : rest;
  const end = lineEndOf(s);
  const at = clamp(pos === undefined ? end : Math.round(pos), index + 1, queue.length);
  const keys = new Set(rest.map((t) => key(t.id)));
  const keep = (t: T): boolean => !keys.has(key(t.id));
  const head = queue.slice(index + 1, at).filter(keep);
  const gone = queue.slice(index + 1, end).filter((t) => !keep(t)).length;
  return {
    undo: { before: queue.slice(end), unshuffled },
    startsHere,
    state: {
      queue: [...queue.slice(0, index + 1), ...head, ...next, ...queue.slice(at).filter(keep)],
      lineEnd: end - gone + (at <= end ? next.length : 0),
      unshuffled: unshuffled && branchedOrder(unshuffled, current, end - index - 1 - gone, next, key),
      branches: [...withoutSongs(branches, new Set(rest.map((t) => t.id))), { name, trackId: rest[0].id, started: startsHere, ids: rest.map((t) => t.id) }],
    },
  };
}

/**
 * The copy of a song in the list's own order that an entry taken out of the queue was: on the same side of
 * the song playing (still to come, or heard), the first such copy coming, the last one heard. A song in
 * the list twice keeps its other copy (Codex, 2026-11-21: shuffle off took both out).
 */
function copyInOrder<T extends Song>(order: T[], queue: T[], index: number, at: number): number {
  const id = queue[at].id;
  const playing = order.findIndex((t) => t.id === queue[index]?.id);
  if (at === index && playing >= 0) return playing;
  const copies = order.flatMap((t, i) => (t.id === id ? [i] : []));
  if (playing < 0 || !copies.length) return copies[0] ?? -1;
  const side = at > index ? copies.filter((i) => i > playing) : copies.filter((i) => i < playing);
  if (!side.length) return copies[0];
  return at > index ? side[0] : side[side.length - 1];
}

/** One entry out: it stays out, also when shuffle goes off or a branch is taken back. */
export function removeEntry<T extends Song>(s: QueueState<T>, at: number): QueueState<T> {
  const { queue, index, lineEnd, unshuffled, branches } = s;
  const left = queue.filter((_, i) => i !== at);
  const gone = queue[at].id;
  const copy = unshuffled ? copyInOrder(unshuffled, queue, index, at) : -1;
  // Another copy still in the queue keeps the song in its branch.
  const stillThere = left.some((t) => t.id === gone);
  return {
    queue: left,
    index: at < index ? index - 1 : at === index ? Math.min(index, Math.max(left.length - 1, 0)) : index,
    lineEnd: at < lineEnd ? lineEnd - 1 : lineEnd,
    unshuffled: unshuffled && (copy >= 0 ? unshuffled.filter((_, i) => i !== copy) : unshuffled),
    branches: stillThere ? branches : withoutSongs(branches, new Set([gone])),
  };
}

/**
 * One entry moved; moved out of the line or into it, the line grows or shrinks with it. The line is
 * counted from where the song playing stands after the move: moved across it, the line can't reach past
 * the end of the list (Codex, 2026-11-21: A of A-B with X and Y asked for, moved behind Y, left the line
 * ending at 5 in a list of 4).
 */
export function moveEntry<T>(s: Pick<QueueState<T>, "queue" | "index" | "lineEnd">, from: number, to: number): Pick<QueueState<T>, "queue" | "index" | "lineEnd"> {
  const { queue, index } = s;
  const end = lineEndOf(s);
  const next = [...queue];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  // Which entries are asked for by hand, the moved one out of its place.
  const marks = queue.map((_, i) => i > index && i < end);
  const [wasAsked] = marks.splice(from, 1);
  const newIndex = from === index ? to : from > index && to <= index ? index + 1 : from < index && to >= index ? index - 1 : index;
  if (from === index) marks.splice(to, 0, false);
  else {
    const playing = from < index ? index - 1 : index;
    let line = 0;
    while (marks[playing + 1 + line]) line += 1;
    // Within the line it's asked for by hand; one already asked for may also go right behind it.
    marks.splice(to, 0, to > playing && to <= playing + line + (wasAsked ? 1 : 0));
  }
  let count = 0;
  while (marks[newIndex + 1 + count]) count += 1;
  return { queue: next, index: newIndex, lineEnd: count ? newIndex + 1 + count : 0 };
}

/**
 * Songs into the queue at a place, after the song playing at the earliest (an edit from another device,
 * lib/queueEntries.ts): among the songs asked for by hand, or right at their end, they're asked for by
 * hand too. Shuffled, they go into the list's own order behind the song in front of them.
 */
export function insertAt<T extends Song>(s: QueueState<T>, tracks: T[], at: number, key: Key = sameId): { at: number; state: Pick<QueueState<T>, "queue" | "lineEnd" | "unshuffled"> } {
  const { queue, index, unshuffled } = s;
  const pos = clamp(Math.round(at), index + 1, queue.length);
  const end = lineEndOf(s);
  const before = queue[pos - 1];
  const behind = unshuffled && before ? unshuffled.findIndex((t) => key(t.id) === key(before.id)) : -1;
  return {
    at: pos,
    state: {
      queue: [...queue.slice(0, pos), ...tracks, ...queue.slice(pos)],
      lineEnd: pos <= end ? end + tracks.length : s.lineEnd,
      unshuffled: unshuffled && [...unshuffled.slice(0, behind + 1), ...tracks, ...unshuffled.slice(behind + 1)],
    },
  };
}

/**
 * A list's entries each one of a kind (a song in it twice: the later copies become copies of their own),
 * the one at `keep` left as it is, since it's what plays. The list's own order can then tell which of two
 * copies is playing when shuffle goes off (Codex, 2026-11-21: shuffled at the second X, the first one was
 * taken, and B came again).
 */
export function oneOfAKind<T extends object>(list: T[], keep: number): T[] {
  const out = list.slice();
  const seen = new Set<T>();
  if (out[keep]) seen.add(out[keep]);
  for (let i = 0; i < out.length; i++) {
    if (i === keep) continue;
    if (seen.has(out[i])) out[i] = { ...out[i] };
    seen.add(out[i]);
  }
  return out;
}

/** Shuffle on: what was asked for by hand stays next, the rest is mixed; the list's own order is kept for later. */
export function shuffleOn<T extends object>(s: Pick<QueueState<T>, "queue" | "index" | "lineEnd">, mix: (songs: T[]) => T[]): Pick<QueueState<T>, "queue" | "unshuffled"> {
  const end = lineEndOf(s);
  const own = oneOfAKind(s.queue, s.index);
  return { unshuffled: own, queue: [...own.slice(0, end), ...mix(own.slice(end))] };
}

/** Shuffle off: the list's own order again from the song playing on, behind what was asked for by hand. Needs a song on. */
export function shuffleOff<T extends Song>(s: QueueState<T>, muted: (id: string) => boolean): Pick<QueueState<T>, "queue" | "unshuffled"> {
  const { queue, index, unshuffled } = s;
  const current = queue[index];
  const end = lineEndOf(s);
  const list = unshuffled ?? queue;
  // The very entry playing, itself in the list's own order (made one of a kind when shuffle went on); else
  // (a list read back after a restart) the copy of its song as many times in as it's been heard up to here.
  let at = list.indexOf(current);
  if (at < 0 || list.indexOf(current, at + 1) >= 0) {
    const heard = queue.slice(0, index + 1).filter((t) => t.id === current.id).length;
    const copies = list.flatMap((t, i) => (t.id === current.id ? [i] : []));
    at = copies.length ? copies[Math.min(Math.max(1, heard), copies.length) - 1] : -1;
  }
  const line = new Set(queue.slice(index + 1, end).map((t) => t.id));
  const upcoming = (at >= 0 ? list.slice(at + 1) : queue.slice(end)).filter((t) => !line.has(t.id) && !muted(t.id));
  return { unshuffled: null, queue: [...queue.slice(0, end), ...upcoming] };
}

/**
 * What another device edited: these songs come after the song playing, with `line` of them asked for by
 * hand. From `cut` on the queue stays as it is: what that device knew nothing of (syncEngine keptFrom).
 * What it took out stays out, also from the list's own order and the branches; nothing coming at all is a
 * clear, as if made here (`cleared`: the caller drops its branch undo too).
 */
export function replaceComing<T extends Song>(s: QueueState<T>, tracks: T[], line: number, cut: number | undefined, key: Key = sameId): { cleared: boolean; state: Pick<QueueState<T>, "queue" | "lineEnd" | "unshuffled" | "branches"> } {
  const { queue, index, unshuffled, branches } = s;
  const at = cut === undefined ? queue.length : clamp(cut, index + 1, queue.length);
  const coming = [...tracks, ...queue.slice(at)];
  if (!coming.length) return { cleared: true, state: clearComing(s) };
  const left = queue.slice(index + 1, at);
  const stays = new Set(coming.map((t) => key(t.id)));
  return {
    cleared: false,
    state: {
      queue: [...queue.slice(0, index + 1), ...coming],
      lineEnd: line ? index + 1 + line : 0,
      unshuffled: unshuffled && orderWithout(unshuffled, left, coming, (t) => key(t.id)),
      branches: withoutSongs(branches, new Set(left.filter((t) => !stays.has(key(t.id))).map((t) => t.id))),
    },
  };
}
