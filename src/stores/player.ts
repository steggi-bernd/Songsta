/**
 * Player state — pure data; playback side effects live in lib/audio.ts.
 *
 * A song found in several places (a local file and its Jellyfin copy) is ONE
 * song here too: the queue never holds two copies of it, and "play this
 * song" finds it whichever copy it is handed. Which copy sounds is the
 * engine's business at play time (local first) — invisible to the queue.
 *
 * Shuffling reorders what comes next, so the list on screen is what actually
 * plays: Next goes down it, Previous back up to the song that was heard.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { withoutOtherCopies } from "../lib/duplicates";
import * as rules from "../lib/queueCore";
import type { ForeseenChange } from "../lib/queueEntries";
import { placeOf, tendedBranches, type QueueBranch } from "../lib/queueSections";
// Coalescing, lazily serialized storage: the engine bumps `position` ~4Hz and
// persist saves on every change — that would stringify the whole queue and
// hit disk/IPC several times a second.
import { lazyJSONStorage } from "../lib/persist";
import type { Track } from "../types";
import { songKey } from "./catalog";
import { isMuted } from "./muted";
import { useSettings } from "./settings";

export type RepeatMode = "off" | "all" | "one";

/** Autoplay's way of going on when the queue has run out (lib/audio.ts). */
let queueRanOut: (() => void) | null = null;
export function setQueueRanOut(next: typeof queueRanOut): void {
  queueRanOut = next;
}

/** While somebody is choosing music for another device, what's asked for goes there (lib/zones.ts). */
let playHook: ((tracks: Track[], start: number) => boolean) | null = null;
export function setPlayHook(hook: typeof playHook): void {
  playHook = hook;
}

/**
 * While this computer follows another device, what's asked of the player here
 * is for that one: one stream, wherever you stand (lib/homeSync.ts).
 */
export interface Steering {
  /** this list from this song; `keepOrder` when it's in its final order already */
  play(tracks: Track[], start: number, keepOrder: boolean): void;
  /**
   * What comes after the playing song, edited here: `all` when nothing comes after these, also what this
   * computer never saw of that queue; `line` when it was what was asked for by hand that went.
   */
  upcoming(tracks: Track[], all?: boolean, line?: boolean): void;
  add(tracks: Track[]): void;
  jump(track: Track): void;
  branchOff(tracks: Track[], name: string): void;
  cancelBranch(name: string): void;
  shuffle(on: boolean): void;
  repeat(mode: RepeatMode): void;
  next(): void;
  previous(): void;
  volume(level: number): void;
}
let steering: Steering | null = null;
export function setSteering(next: Steering | null): void {
  steering = next;
}

/**
 * Told of an edit by place before it's made (an entry taken out, one moved), so the queue's entry ids
 * follow it exactly (lib/homeSync.ts, lib/queueEntries.ts): two copies side by side stay told apart.
 */
let editAhead: ((change: ForeseenChange) => void) | null = null;
export function setEditAhead(next: typeof editAhead): void {
  editAhead = next;
}

/** What a branch changed, by the list it came from, while it can still be taken back. */
const branchUndo = new Map<string, { before: Track[]; unshuffled: Track[] | null }>();

/** The queue with a branch taken back: what it took out of what was coming goes back to where it was, unless it was heard meanwhile. */
function withoutBranch(s: rules.QueueState<Track>, branch: QueueBranch): Partial<PlayerState> {
  const undo = branchUndo.get(branch.name);
  branchUndo.delete(branch.name);
  return rules.takeBack(s, branch, undo, songKey);
}

export function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  /** 0..1 — how much of the current track the audio element has buffered */
  buffered: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** the list's own order, to go back to when shuffle is turned off */
  unshuffled: Track[] | null;
  /** where the songs asked for by hand end in the queue, branches included: the next one asked for goes here */
  lineEnd: number;
  branches: QueueBranch[];
  /** the volume of the device this computer follows */
  remoteVolume: number | null;
  /** bumped whenever the engine should hard-seek to `position` */
  seekNonce: number;
  error: string | null;
  /** the copy each loaded track plays from (a local file or a server stream) — written by the engine */
  sources: Record<string, Track>;

  current(): Track | null;
  /** A song asked for, with its list after it. Muted ones in the list stay out; the asked-for one plays anyway. */
  playQueue(tracks: Track[], startIndex?: number): void;
  /** A whole list from its Play or Shuffle button: nothing in it is asked for by name, so nothing muted plays. */
  playAll(tracks: Track[], random?: boolean): void;
  playTrack(track: Track): void;
  /** To a song of the queue. Shuffled and further down, it comes next: what it jumped stays to come, and Previous finds the song that was on. */
  jumpTo(at: number): void;
  /** Right behind the playing song and what was asked for before: first come, first played. Answers how many are in that line now. */
  addToQueue(tracks: Track | Track[]): number;
  /** The song next, the rest of its list after it, what was coming behind them, each once. `at`: where it was dropped. */
  branchOff(tracks: Track[], name: string, at?: number): void;
  /** The branch into this list that starts from this song, if there is one. */
  branchFrom(trackId: string, name: string): QueueBranch | undefined;
  /** The branch into this list goes, and what it took out of what was coming comes back. Without a name, the newest one. */
  cancelBranch(name?: string): void;
  /** What comes after the playing song, as another device edited it; `line` of them were asked for by hand. */
  replaceUpcoming(tracks: Track[], line?: number, keepFrom?: number): void;
  /** Only what was asked for by hand goes. */
  clearLine(): void;
  /**
   * Songs into the queue at `at` (after the playing song at the earliest).
   * `dropCopies`: songs coming up that they already bring are dropped — each plays once.
   */
  insertInQueue(tracks: Track[], at: number, dropCopies?: boolean): void;
  removeAt(i: number): void;
  moveInQueue(from: number, to: number): void;
  clearUpcoming(): void;
  /** drop second copies of a song from the queue (e.g. one saved before the copies were merged) */
  collapseCopies(): void;
  next(manual?: boolean): void;
  prev(): void;
  toggle(): void;
  setPlaying(playing: boolean): void;
  seek(sec: number): void;
  setVolume(v: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;

  /* internal setters used by the audio engine */
  _setTime(position: number, duration?: number): void;
  _setBuffered(ratio: number): void;
  _setBuffering(buffering: boolean): void;
  _setError(error: string | null): void;
  _setSource(trackId: string, version: Track): void;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Repeat-one is about the song it was turned on for: go to another one, and the whole list repeats from there (Settings). */
function leaving(repeat: RepeatMode): { repeat?: RepeatMode } {
  return repeat === "one" && useSettings.getState().skipEndsRepeatOne ? { repeat: "all" } : {};
}

/** What the volume was before it was muted from here, on the device this computer follows. */
let lastRemoteVolume = 0.5;

export const usePlayer = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      index: 0,
      playing: false,
      buffering: false,
      position: 0,
      duration: 0,
      buffered: 0,
      volume: 0.8,
      muted: false,
      shuffle: false,
      repeat: "off",
      unshuffled: null,
      lineEnd: 0,
      branches: [],
      remoteVolume: null,
      seekNonce: 0,
      error: null,
      sources: {},

      current() {
        const { queue, index } = get();
        return queue[index] ?? null;
      },

      playQueue(tracks, startIndex = 0) {
        if (!tracks.length) return;
        if (playHook?.(tracks, startIndex)) return;
        const asked = tracks[clamp(startIndex, 0, tracks.length - 1)];
        const open = tracks.filter((t) => t === asked || !isMuted(t.id));
        // A list holding two copies of a song (a playlist with the local file
        // and its server copy) still queues it once — the clicked one stays.
        const { list, keep } = withoutOtherCopies(open, songKey, open.indexOf(asked));
        const at = Math.max(0, keep);
        if (steering) {
          steering.play(list, at, false);
          return;
        }
        const { shuffle, queue, index, repeat, playing } = get();
        branchUndo.clear();
        // Shuffled, each entry one of a kind: shuffle going off finds the very one that plays (lib/queueCore.ts).
        const own = shuffle ? rules.oneOfAKind(list, at) : list;
        editAhead?.({ start: true });
        set({
          // Listening to another song. With nothing on, repeat-one may well be meant for this one.
          ...(playing && queue[index] && queue[index].id !== list[at].id ? leaving(repeat) : {}),
          queue: shuffle ? [own[at], ...shuffled(own.filter((_, i) => i !== at))] : list,
          index: shuffle ? 0 : at,
          unshuffled: shuffle ? own : null,
          lineEnd: 0,
          branches: [],
          playing: true,
          position: 0,
          error: null,
        });
      },

      playAll(tracks, random = false) {
        const open = tracks.filter((t) => !isMuted(t.id));
        if (open.length) get().playQueue(open, random || get().shuffle ? Math.floor(Math.random() * open.length) : 0);
      },

      playTrack(track) {
        const { queue, index } = get();
        // Nothing on to put it after: a list of one, started the way every list starts.
        if (!queue[index]) {
          get().playQueue([track], 0);
          return;
        }
        const at = placeOf(queue, songKey(track.id), index, undefined, (t) => songKey(t.id));
        if (at >= 0) {
          get().jumpTo(at);
          return;
        }
        const q = [...queue.slice(0, index + 1), track, ...queue.slice(index + 1)];
        if (steering) {
          steering.play(q, index + 1, true);
          return;
        }
        const { lineEnd, unshuffled, repeat, playing } = get();
        set({
          ...(playing ? leaving(repeat) : {}),
          queue: q,
          index: index + 1,
          lineEnd: lineEnd > index + 1 ? lineEnd + 1 : lineEnd,
          unshuffled: unshuffled && rules.intoOrder(unshuffled, queue[index], 0, [track]),
          playing: true,
          position: 0,
          error: null,
        });
      },

      jumpTo(at) {
        const { queue, index, shuffle, lineEnd, repeat } = get();
        if (at < 0 || at >= queue.length) return;
        if (steering) {
          steering.jump(queue[at]);
          return;
        }
        if (shuffle && at > index + 1) {
          const q = [...queue];
          const [song] = q.splice(at, 1);
          q.splice(index + 1, 0, song);
          set({ ...leaving(repeat), queue: q, index: index + 1, lineEnd: at >= lineEnd && lineEnd > index + 1 ? lineEnd + 1 : lineEnd, playing: true, position: 0, error: null });
          return;
        }
        set({ ...(queue[at].id === queue[index]?.id ? {} : leaving(repeat)), index: at, playing: true, position: 0, error: null });
      },

      addToQueue(tracks) {
        const list = withoutOtherCopies(Array.isArray(tracks) ? tracks : [tracks], songKey).list;
        if (!list.length) return 0;
        steering?.add(list);
        const { queue, index } = get();
        if (!queue.length) {
          set({ queue: list, index: 0, playing: false, position: 0, lineEnd: 0 });
          return 0;
        }
        // Behind what was asked for before; in the line already, it stays where it is (lib/queueCore.ts).
        const { at, fresh, state } = rules.enqueue(get(), list, songKey);
        set(state);
        return at + fresh.length - index - 1;
      },

      branchOff(rest, name, at) {
        if (!rest.length) return;
        steering?.branchOff(rest, name);
        // Another song of the same list: the branch starts there instead.
        const same = get().branches.find((b) => b.name === name);
        if (same) set(withoutBranch(get(), same));
        if (!get().queue.length) {
          if (!steering) get().playQueue(rest, 0);
          return;
        }
        // Behind everything asked for by hand, and part of it; from the very song playing, its list plays on behind it (lib/queueCore.ts).
        const { undo, state } = rules.branchOff(get(), rest, name, songKey, at);
        branchUndo.set(name, undo);
        set(state);
      },

      branchFrom(trackId, name) {
        return get().branches.find((b) => b.trackId === trackId && b.name === name);
      },

      cancelBranch(name) {
        const { branches } = get();
        const branch = name === undefined ? branches[branches.length - 1] : branches.find((b) => b.name === name);
        if (!branch) return;
        steering?.cancelBranch(branch.name);
        set(withoutBranch(get(), branch));
      },

      replaceUpcoming(tracks, line = 0, keepFrom) {
        // From `keepFrom` on the queue stays: what the device that edited it knew nothing of. Cleared there: as if cleared here.
        const { cleared, state } = rules.replaceComing(get(), tracks, line, keepFrom, songKey);
        if (cleared) branchUndo.clear();
        set(state);
      },

      clearLine() {
        for (const b of get().branches) set(withoutBranch(get(), b));
        set(rules.clearHandMade(get(), songKey));
        const { queue, index } = get();
        steering?.upcoming(queue.slice(index + 1), false, true);
      },

      insertInQueue(tracks, at, dropCopies = false) {
        const list = withoutOtherCopies(tracks, songKey).list;
        if (!list.length) return;
        const { queue, index } = get();
        if (!queue.length) {
          set({ queue: list, index: 0, playing: false, position: 0 });
          return;
        }
        const pos = clamp(Math.round(at), index + 1, queue.length);
        // What is coming up, either side of the new songs (the playing one stays as it is).
        const keys = new Set(list.map((t) => songKey(t.id)));
        const keep = (t: Track): boolean => !dropCopies || !keys.has(songKey(t.id));
        // Dropped among what was asked for by hand, or right at its end: it's one of those now.
        const end = clamp(get().lineEnd, index + 1, queue.length);
        const gone = queue.slice(index + 1, end).filter((t) => !keep(t)).length;
        const head = queue.slice(index + 1, pos).filter(keep);
        const q = [...queue.slice(0, index + 1), ...head, ...list, ...queue.slice(pos).filter(keep)];
        set({ queue: q, lineEnd: end - gone + (pos <= end ? list.length : 0) });
        steering?.upcoming(q.slice(index + 1));
      },

      removeAt(i) {
        const { queue, index } = get();
        if (i < 0 || i >= queue.length) return;
        // It stays out, also when shuffle goes off or a branch is taken back.
        editAhead?.({ remove: i });
        const next = rules.removeEntry(get(), i);
        // The song on screen went: the one after it starts from its top, not from that one's place.
        set({ ...(i === index ? { position: 0 } : {}), ...next });
        steering?.upcoming(next.queue.slice(next.index + 1));
      },

      moveInQueue(from, to) {
        const { queue } = get();
        if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
        editAhead?.({ move: [from, to] });
        const next = rules.moveEntry(get(), from, to);
        set(next);
        steering?.upcoming(next.queue.slice(next.index + 1));
      },

      clearUpcoming() {
        branchUndo.clear();
        set(rules.clearComing(get()));
        steering?.upcoming([], true);
      },

      collapseCopies() {
        // The playing entry stays put (same object, same index offset), so
        // the engine never reloads it — only other copies of songs go.
        const { queue, index } = get();
        const { list, keep } = withoutOtherCopies(queue, songKey, index);
        if (list.length === queue.length) return;
        // The line loses what went from it.
        const stays = new Set(list);
        set({ queue: list, index: Math.max(0, keep), lineEnd: queue.slice(0, get().lineEnd).filter((t) => stays.has(t)).length });
      },

      next(manual = false) {
        if (steering) {
          steering.next();
          return;
        }
        const { queue, index, repeat } = get();
        if (!queue.length) {
          set({ playing: false });
          return;
        }
        const goesOn = manual ? leaving(repeat) : {};
        let ni = index + 1;
        if (ni >= queue.length) {
          // Skipping past the end with Autoplay on: what the queue's end does, as on the phone.
          if (manual && (goesOn.repeat ?? repeat) !== "all" && useSettings.getState().autoplay && queueRanOut) {
            queueRanOut();
            return;
          }
          if (manual || repeat === "all") {
            ni = 0;
          } else {
            set({ playing: false, position: 0 });
            return;
          }
        }
        if (ni === index) {
          // Round to the very same song (a queue of one): it starts over — the
          // same index alone changes nothing the engine would act on.
          set({ playing: true, position: 0, error: null, seekNonce: get().seekNonce + 1 });
          return;
        }
        set({ ...goesOn, index: ni, playing: true, position: 0, error: null });
      },

      prev() {
        if (steering) {
          steering.previous();
          return;
        }
        if (get().position > 3) {
          set({ position: 0, seekNonce: get().seekNonce + 1 });
          return;
        }
        const { queue, index, repeat } = get();
        if (!queue.length) return;
        // At the very start only Repeat goes round; otherwise the song starts over.
        const ni = index > 0 ? index - 1 : repeat === "all" ? queue.length - 1 : index;
        if (ni === index) {
          set({ position: 0, seekNonce: get().seekNonce + 1 });
          return;
        }
        set({ ...leaving(repeat), index: ni, playing: true, position: 0, error: null });
      },

      toggle() {
        // Nothing to play or pause: flipping `playing` against an empty queue
        // left the play button reading "Pause" with no audio behind it.
        if (!get().queue.length) return;
        set({ playing: !get().playing });
      },

      setPlaying(playing) {
        // Mirrors toggle(): a media-key "play" with an empty queue (e.g.
        // after removing every queued track) must not flip the store into a
        // playing state nothing can back.
        if (playing && !get().queue.length) return;
        set({ playing });
      },

      seek(sec) {
        const { duration } = get();
        set({
          position: clamp(sec, 0, duration > 0 ? duration : sec),
          seekNonce: get().seekNonce + 1,
        });
      },

      setVolume(v) {
        if (steering) {
          const level = clamp(v, 0, 1);
          if (level > 0) lastRemoteVolume = level;
          steering.volume(level);
          set({ remoteVolume: level });
          return;
        }
        set({ volume: clamp(v, 0, 1), muted: false });
      },

      toggleMute() {
        if (steering) {
          const { remoteVolume } = get();
          if (remoteVolume !== null) get().setVolume(remoteVolume > 0 ? 0 : lastRemoteVolume);
          return;
        }
        set({ muted: !get().muted });
      },

      toggleShuffle() {
        const { shuffle, queue, index } = get();
        if (steering) {
          steering.shuffle(!shuffle);
          set({ shuffle: !shuffle });
          return;
        }
        if (!queue[index]) {
          set({ shuffle: !shuffle });
          return;
        }
        // What was asked to come next stays next; off, the list's own order again from the song playing on.
        set(shuffle ? { shuffle: false, ...rules.shuffleOff(get(), isMuted) } : { shuffle: true, ...rules.shuffleOn(get(), shuffled) });
      },

      cycleRepeat() {
        const order: RepeatMode[] = ["off", "all", "one"];
        const repeat = order[(order.indexOf(get().repeat) + 1) % order.length];
        steering?.repeat(repeat);
        set({ repeat });
      },

      _setTime(position, duration) {
        const d = Number.isFinite(duration) && (duration ?? 0) > 0 ? (duration as number) : get().duration;
        set({ position, duration: d });
      },

      _setBuffered(buffered) {
        if (Math.abs(get().buffered - buffered) > 0.005) set({ buffered });
      },

      _setBuffering(buffering) {
        set({ buffering });
      },

      _setError(error) {
        set({ error });
      },

      _setSource(trackId, version) {
        // Only the decks' tracks matter: the current one and the one fading in.
        const { queue, index, sources } = get();
        const keep = new Set([trackId, queue[index]?.id, queue[index + 1]?.id]);
        const next: Record<string, Track> = {};
        for (const [id, v] of Object.entries(sources)) if (keep.has(id)) next[id] = v;
        next[trackId] = version;
        set({ sources: next });
      },
    }),
    {
      name: "player",
      // v1: the volume slider is perceptual (output gain = slider³, see
      // lib/audio.ts). The stored value used to BE the gain — move the slider
      // to the position that produces it, so nothing sounds different.
      // v2: shuffle orders the queue itself, Next no longer picks at random.
      version: 2,
      migrate: (persisted, version) => {
        const s = persisted as Partial<PlayerState> | null;
        if (s && version < 1 && typeof s.volume === "number" && Number.isFinite(s.volume)) {
          s.volume = Math.cbrt(clamp(s.volume, 0, 1));
        }
        if (s && version < 2 && s.shuffle && Array.isArray(s.queue)) {
          const at = typeof s.index === "number" ? s.index : 0;
          s.unshuffled = s.queue;
          s.queue = [...s.queue.slice(0, at + 1), ...shuffled(s.queue.slice(at + 1))];
        }
        return s as PlayerState;
      },
      storage: lazyJSONStorage<PlayerState>(),
      partialize: (s) =>
        ({
          queue: s.queue,
          index: s.index,
          position: s.position,
          volume: s.volume,
          muted: s.muted,
          shuffle: s.shuffle,
          repeat: s.repeat,
          unshuffled: s.unshuffled,
          lineEnd: s.lineEnd,
          branches: s.branches,
        }) as unknown as PlayerState,
    }
  )
);

// A branch's first song came on: nothing is chosen any more; it can still be taken back until its songs are through.
usePlayer.subscribe((s, prev) => {
  if (!s.branches.length || (s.index === prev.index && s.queue === prev.queue)) return;
  const branches = tendedBranches(s.branches, s.queue, s.index);
  if (branches === s.branches) return;
  for (const b of s.branches) if (!branches.some((kept) => kept.name === b.name)) branchUndo.delete(b.name);
  usePlayer.setState({ branches });
});

/** A song chosen to branch off from, until it comes on. */
export const useBranchChosen = (trackId: string): boolean =>
  usePlayer((s) => s.branches.some((b) => !b.started && songKey(b.trackId) === songKey(trackId)));
