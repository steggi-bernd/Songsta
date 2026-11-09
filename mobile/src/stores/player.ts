/**
 * The queue and what the native player is doing. This store owns the queue's
 * order and tells the player every change; shuffling reorders what comes
 * next, so the list on screen is what actually plays.
 *
 * Where playback stopped is kept on the phone and restored paused at the next
 * start, and the sync service carries the same note between devices: a phone
 * that isn't playing continues from where another device stopped.
 *
 * There is one stream: a device that isn't playing shows the one that is, and
 * whatever is asked of it goes there, a new song and the volume too. "This phone"
 * in Devices brings the music here and stops it there. Only a second stream,
 * asked for there as well, lets both go their own way.
 */
import { Platform } from "react-native";
import { create } from "zustand";
import Player, { type PlaybackState, type QueueItem, type RepeatMode } from "../../modules/media3-player";
import { streamUrl, type Session } from "../jellyfin";
import { withoutServer } from "../addresses";
import { branched } from "../playingFrom";
import { chooseStream, levelGain, ORIGINAL, sameChoice, stepDown, type Leveling, type QualityMode, type StreamChoice } from "../quality";
import { jumpTarget, lineInList, listAround, placeOf, playCreditSeconds, putBack, tendedBranches, toWireTrack, withoutSongs, type DeviceCommand, type DevicePresence, type PlaybackNote, type QueueBranch, type QueueDoc, type RemoteDevice, type Track, type WireTrack } from "../shared";
import { readJson, writeJson } from "../storage";
import { useConnection } from "./connection";
import { isAround, useDevices } from "./devices";
import { fileOfSong } from "./localMusic";
import { downloadsLine, useDownloads } from "./downloads";
import { useLibrary } from "./library";
import { findSong } from "./playlists";
import { toast } from "./popups";
import { here, useSession } from "./session";
import { useSettings } from "./settings";
import { T } from "../shared";

const FILE = "player.json";
const QUALITY_FILE = "quality.json";
const SAVE_EVERY_MS = 5000;

interface Saved {
  context: string;
  ids: string[];
  index: number;
  positionMs: number;
  repeat: RepeatMode;
  /** when this was last worth continuing from */
  at?: number;
  queueId?: string;
  /** where the songs asked for by hand end */
  line?: number;
  branches?: QueueBranch[];
  home?: string | null;
}

/** What the queue asks of whatever plays it: this phone's own player, or a device on the network (stores/zones.ts). */
export type PlayerOutput = Pick<
  typeof Player,
  "setQueue" | "replaceUpcoming" | "replaceCurrent" | "addItems" | "insertItems" | "removeItem" | "moveItem" | "play" | "pause" | "seekTo" | "skipTo" | "next" | "previous" | "setRepeat" | "setGain"
>;

/** The device on the network that plays the queue instead of this phone. */
export interface OutputDevice {
  id: string;
  name: string;
  tv: boolean;
}

let output: PlayerOutput = Player;

/** Where the songs asked for by hand end in the queue: the next one goes here. */
const lineAt = (queue: Track[], index: number): number => Math.min(queue.length, Math.max(index + 1, usePlayer.getState().lineEnd));
/** What a branch changed, by the list it came from, while it can still be taken back. */
const branchUndo = new Map<string, { before: Track[]; unshuffled: Track[] | null }>();

/** "Playing from": the list of the branch that's on, and back to what was playing when its songs are through. */
function namesNow(branches: QueueBranch[], { context, homeContext }: Pick<PlayerState, "context" | "homeContext">): Pick<PlayerState, "context" | "homeContext"> {
  const running = branches.filter((b) => b.started).pop();
  if (running) return { context: running.name, homeContext: homeContext ?? context };
  return homeContext === null ? { context, homeContext } : { context: homeContext, homeContext: null };
}

/** The queue with a branch taken back: what it took out of what was coming goes back to where it was, unless it was heard meanwhile. */
function withoutBranch(branch: QueueBranch): Partial<PlayerState> {
  const state = usePlayer.getState();
  const { queue, index, unshuffled } = state;
  const undo = branchUndo.get(branch.name);
  branchUndo.delete(branch.name);
  const ids = new Set(branch.ids);
  const end = lineAt(queue, index);
  const line = queue.slice(index + 1, end).filter((t) => !ids.has(t.id));
  const left = queue.slice(end).filter((t) => !ids.has(t.id));
  const heard = new Set(queue.slice(0, index + 1).map((t) => t.id));
  const coming = undo ? putBack(undo.before, left, (t) => ids.has(t.id) && !heard.has(t.id), (t) => t.id) : left;
  const inOrder = new Set(undo?.unshuffled?.map((t) => t.id));
  const branches = state.branches.filter((b) => b.name !== branch.name);
  return {
    queue: [...queue.slice(0, index + 1), ...line, ...coming],
    lineEnd: index + 1 + line.length,
    unshuffled: undo?.unshuffled && unshuffled ? [...undo.unshuffled, ...unshuffled.filter((t) => !inOrder.has(t.id) && !ids.has(t.id))] : unshuffled && unshuffled.filter((t) => !ids.has(t.id)),
    branches,
    ...namesNow(branches, state),
  };
}

/** While somebody chooses music for another device, what's asked for goes there. Answers whether it took it. */
let playHook: ((tracks: Track[], start: number, shuffle: boolean) => boolean) | null = null;
export function setPlayHook(hook: typeof playHook): void {
  playHook = hook;
}

/** Another device whose music this one shows and steers, itself silent. */
export interface FollowedDevice {
  id: string;
  name: string;
  kind: DevicePresence["kind"];
  playing: boolean;
  positionMs: number;
  durationMs: number;
  /** when that position was heard (this phone's clock) */
  heardAt: number;
}

interface PlayerState {
  /** the device this one is showing; null while it plays or rests by itself */
  remote: FollowedDevice | null;
  /** the device on the network that plays the queue; null for this phone */
  device: OutputDevice | null;
  queue: Track[];
  index: number;
  /** what the queue plays from now: an album's name, a playlist's, a branch's */
  context: string;
  /** the list that comes after the branch playing now; null while none is */
  homeContext: string | null;
  /** what was started as a whole, as Your Library names it: "album:…", "artist:…", "playlist:…", "mix:…"; null for songs from anywhere else (stores/played.ts) */
  source: string | null;
  isPlaying: boolean;
  playWhenReady: boolean;
  isBuffering: boolean;
  positionMs: number;
  durationMs: number;
  repeat: RepeatMode;
  shuffle: boolean;
  /** the order to go back to when shuffle is turned off */
  unshuffled: Track[] | null;
  /** where the songs asked for by hand end in the queue, branches included: the next one goes here */
  lineEnd: number;
  branches: QueueBranch[];
  /** this phone plays its own music next to another device's, by request */
  secondStream: boolean;
  /** the volume of the device being followed */
  remoteVolume: number | null;
  /** Sets it from here. */
  setRemoteVolume(level: number): void;
  /** when the sleep timer pauses the music */
  sleepAt: number | null;
  error: string | null;
  quality: QualityMode;
  /** the copy the playing song comes from */
  stream: StreamChoice;
  /** what the sound goes through: decoder, output, speed */
  audio: string;
  /** 24-bit files keep their resolution up to the system's mixer */
  keep24Bit: boolean;
  setKeep24Bit(on: boolean): void;
  leveling: Leveling;
  setLeveling(leveling: Leveling): void;
  setQuality(mode: QualityMode): void;
  /**
   * A song asked for, with its list after it. Muted ones in the list stay out; the asked-for one plays anyway.
   * `source`: the list as Your Library names it, when a whole album, artist, playlist or mix was started (stores/played.ts).
   */
  playTracks(tracks: Track[], start: number, context: string, shuffle?: boolean, source?: string | null): void;
  /** A whole list from its Play or Shuffle button: nothing in it is asked for by name, so nothing muted plays. Play goes by the shuffle that's on, as on the computer. */
  playAll(tracks: Track[], context: string, shuffle?: boolean, source?: string | null): void;
  /** The music of the device being followed comes here and plays on. */
  takeHere(): void;
  /** This device's music goes to another one and plays on there. */
  sendTo(deviceId: string): Promise<boolean>;
  toggle(): void;
  next(): void;
  previous(): void;
  seek(ms: number): void;
  skipTo(index: number): void;
  /** To the song a swipe brought in, -1 or 1 along the queue and round its ends. */
  skipBy(delta: number): void;
  cycleRepeat(): void;
  toggleShuffle(): void;
  /** Right after the playing song and everything asked for before it: first come, first played. Answers how many are in that line now. */
  addToQueue(tracks: Track[]): number;
  /** A song of a list and the rest of that list behind what was asked for before, what was coming behind them. Answers how many songs that is. */
  branchOff(list: Track[], from: number, name: string): number;
  /** The branch into this list that starts from this song, if there is one. */
  branchFrom(trackId: string, name: string): QueueBranch | undefined;
  /** The branch into this list goes, and what it took out of what was coming comes back. Without a name, the newest one. */
  cancelBranch(name?: string): void;
  /** Only what was asked for by hand goes. */
  clearLine(): void;
  removeAt(index: number): void;
  moveItem(from: number, to: number): void;
  clearUpcoming(): void;
  cycleSleepTimer(): number | null;
  restore(): Promise<void>;
  stop(): void;
  clearError(): void;
}

function urlOf(s: Session | null, t: Track, choice: StreamChoice): string {
  // In a folder on this phone: nothing beats that.
  const file = fileOfSong(t);
  if (file) return file;
  const kept = useDownloads.getState().kept[t.id];
  if (kept) return `file://${kept.file}`;
  return s ? streamUrl(s, t, choice) : "";
}

/** A song as this phone's own player takes it; also for when it plays along with other devices. */
export function toItem(t: Track): QueueItem {
  const s = useSession.getState().session;
  const choice = choiceFor(t);
  chosen.set(t.id, choice);
  return {
    id: t.id,
    url: urlOf(s, t, choice),
    title: t.title,
    artist: t.artist,
    album: t.album ?? "",
    artworkUrl: t.thumb ? useDownloads.getState().covers[withoutServer(t.thumb)] ?? here(t.thumb) : undefined,
    gainDb: levelGain(t.rg?.trackGain, usePlayer.getState().leveling),
  };
}

export function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SLEEP_STEPS = [15, 30, 60];

export const usePlayer = create<PlayerState>((set, get) => ({
  remote: null,
  device: null,
  queue: [],
  index: 0,
  context: "",
  source: null,
  homeContext: null,
  isPlaying: false,
  playWhenReady: false,
  isBuffering: false,
  positionMs: 0,
  durationMs: 0,
  repeat: "off",
  shuffle: false,
  unshuffled: null,
  lineEnd: 0,
  branches: [],
  secondStream: false,
  remoteVolume: null,
  sleepAt: null,
  error: null,
  quality: "auto",
  stream: ORIGINAL,
  audio: "",
  keep24Bit: false,
  leveling: "normal",

  setQuality(mode) {
    capKbps = null;
    jumpedAt = Date.now();
    set({ quality: mode });
    writeJson(QUALITY_FILE, { mode, keep24Bit: get().keep24Bit, leveling: get().leveling });
    refreshStreams(true);
  },

  setKeep24Bit(keep24Bit) {
    set({ keep24Bit });
    writeJson(QUALITY_FILE, { mode: get().quality, keep24Bit, leveling: get().leveling });
    jumpedAt = Date.now();
    void Player.setKeep24Bit(keep24Bit, true);
  },

  setLeveling(leveling) {
    set({ leveling });
    writeJson(QUALITY_FILE, { mode: get().quality, keep24Bit: get().keep24Bit, leveling });
    const { queue, index } = get();
    const current = queue[index];
    if (!current) return;
    void output.setGain(levelGain(current.rg?.trackGain, leveling) ?? 0);
    void output.replaceUpcoming(queue.slice(index + 1).map(toItem));
  },

  playTracks(all, start, context, shuffle = get().shuffle, source = null) {
    if (playHook?.(all, start, shuffle)) return;
    // Without a way to the server only what's on the phone can play.
    const { kept } = useDownloads.getState();
    const offline = useConnection.getState().reach === "offline";
    const { muted } = useLibrary.getState();
    const asked = all[Math.max(0, Math.min(start, all.length - 1))];
    const tracks = all.filter((t) => (!offline || kept[t.id] || fileOfSong(t)) && (t === asked || !muted.has(t.id)));
    if (!tracks.length) {
      if (offline && all.length) toast(T("Your server is out of reach, and this isn't downloaded"));
      return;
    }
    const askedAt = Math.max(0, tracks.indexOf(asked));
    const { remote } = get();
    if (remote) {
      // One stream: the device playing plays it, and this phone shows it from that device's next word.
      const from = Math.max(0, askedAt - LIST_BEHIND);
      void deviceLink?.sendList(remote.id, tracks.slice(from, from + LONGEST_LIST).map(toWireTrack), context, { action: "playList", start: askedAt - from, context, shuffle });
      queueId = "";
      steeringTo = { id: asked.id, until: Date.now() + STEER_PATIENCE_MS };
      set({ queue: [asked], index: 0, context, source, homeContext: null, shuffle, unshuffled: null, lineEnd: 0, branches: [], durationMs: asked.duration * 1000, error: null });
      hold(0, true);
      return;
    }
    let queue = tracks;
    let index = askedAt;
    if (shuffle) {
      queue = [tracks[index], ...shuffled(tracks.filter((_, i) => i !== index))];
      index = 0;
    }
    load(queue, index, context, { shuffle, unshuffled: shuffle ? tracks : null }, source);
  },

  playAll(all, context, shuffle = get().shuffle, source = null) {
    const { muted } = useLibrary.getState();
    const open = all.filter((t) => !muted.has(t.id));
    if (!open.length) {
      if (all.length) toast(T("Everything here is muted"));
      return;
    }
    get().playTracks(open, shuffle ? Math.floor(Math.random() * open.length) : 0, context, shuffle, source);
  },

  takeHere() {
    const { remote } = get();
    if (!remote) return;
    // The pause is for a device that doesn't know the second word yet.
    void deviceLink?.send(remote.id, { action: "pause" });
    void deviceLink?.send(remote.id, { action: "yield", to: deviceLink.self });
    stopFollowing(true);
  },

  async sendTo(deviceId) {
    if (!deviceLink) return false;
    const sent = await deviceLink.handOver(deviceId);
    if (!sent) return false;
    followNext = deviceId;
    set({ secondStream: false });
    void output.pause();
    return true;
  },

  toggle() {
    const { remote } = get();
    if (remote) {
      void deviceLink?.send(remote.id, { action: remote.playing ? "pause" : "play" });
      hold(remote.positionMs + (remote.playing ? Date.now() - remote.heardAt : 0), !remote.playing);
      return;
    }
    if (get().playWhenReady) void output.pause();
    else if (get().queue.length) void output.play();
  },
  next() {
    const { remote } = get();
    if (remote) {
      if (get().queue[get().index + 1]) steerTo(get().index + 1);
      else void deviceLink?.send(remote.id, { action: "next" });
      return;
    }
    jumpedAt = Date.now();
    const { queue, index, repeat } = get();
    // On repeat-one the player itself doesn't go anywhere from the last song.
    if (index >= queue.length - 1 && repeat !== "all") {
      if (repeat === "one") leaveRepeatOne();
      if (get().repeat === "all") void output.next();
      // Nothing after it: what the queue's end does, or round to its start, as on the computer.
      else if (useSettings.getState().autoplay) keepGoing();
      else void output.skipTo(0, true);
    } else {
      void output.next();
    }
    activity();
  },
  previous() {
    const { remote } = get();
    if (remote) {
      // Well into a song Previous starts it over, as on the player itself.
      const { index, positionMs } = get();
      if (index > 0 && positionMs <= RESTART_AFTER_MS) steerTo(index - 1);
      else get().seek(0);
      return;
    }
    jumpedAt = Date.now();
    void output.previous();
    activity();
  },
  seek(ms) {
    const { remote } = get();
    if (remote) {
      void deviceLink?.send(remote.id, { action: "seek", positionMs: ms });
      hold(ms, remote.playing);
      return;
    }
    jumpedAt = Date.now();
    set({ positionMs: ms });
    void output.seekTo(ms);
    activity();
  },
  skipTo(target) {
    const { remote, index, shuffle } = get();
    if (remote) {
      steerTo(target);
      return;
    }
    jumpedAt = Date.now();
    // Shuffled and further down: it comes next, what it jumped stays to come, and Previous finds the song that was on.
    if (shuffle && target > index + 1) {
      get().moveItem(target, index + 1);
      void output.skipTo(index + 1, true);
    } else {
      void output.skipTo(target, true);
    }
    activity();
  },
  skipBy(delta) {
    const { queue, index, playWhenReady, remote, repeat } = get();
    if (!queue.length) return;
    const target = (index + delta + queue.length) % queue.length;
    if (remote) {
      if (target !== index) steerTo(target);
      else void deviceLink?.send(remote.id, { action: delta > 0 ? "next" : "previous" });
      return;
    }
    if (repeat === "one" && target !== index) leaveRepeatOne();
    skipTarget = target;
    skipUntil = Date.now() + SKIP_PATIENCE_MS;
    jumpedAt = Date.now();
    set({ index: target, positionMs: 0, durationMs: queue[target].duration * 1000, error: null });
    void output.skipTo(target, playWhenReady);
    activity();
    save(true);
  },

  cycleRepeat() {
    const order: RepeatMode[] = ["off", "all", "one"];
    const repeat = order[(order.indexOf(get().repeat) + 1) % order.length];
    const { remote } = get();
    set({ repeat });
    if (remote) {
      void deviceLink?.send(remote.id, { action: "repeat", mode: repeat });
      return;
    }
    void output.setRepeat(repeat);
    deviceLink?.presence();
  },

  toggleShuffle() {
    const { shuffle, queue, index, unshuffled, remote } = get();
    if (remote) {
      void deviceLink?.send(remote.id, { action: "shuffle", on: !shuffle });
      set({ shuffle: !shuffle });
      return;
    }
    const current = queue[index];
    if (!current) {
      set({ shuffle: !shuffle });
      return;
    }
    // What was asked to come next stays next.
    const end = lineAt(queue, index);
    const line = queue.slice(index + 1, end);
    const lineIds = new Set(line.map((t) => t.id));
    if (!shuffle) {
      const upcoming = shuffled(queue.slice(end));
      set({ shuffle: true, unshuffled: queue, queue: [...queue.slice(0, index + 1), ...line, ...upcoming] });
      void output.replaceUpcoming([...line, ...upcoming].map(toItem));
    } else {
      // The list's own order again, from the song playing on.
      const list = unshuffled ?? queue;
      const at = list.findIndex((t) => t.id === current.id);
      const { muted } = useLibrary.getState();
      const upcoming = (at >= 0 ? list.slice(at + 1) : queue.slice(end)).filter((t) => !lineIds.has(t.id) && !muted.has(t.id));
      set({ shuffle: false, unshuffled: null, queue: [...queue.slice(0, index + 1), ...line, ...upcoming] });
      void output.replaceUpcoming([...line, ...upcoming].map(toItem));
    }
    queueChanged();
    save(true);
  },

  addToQueue(tracks) {
    const { queue, index, unshuffled, remote, branches } = get();
    const current = queue[index];
    if (!current) {
      if (remote) sendSongs(remote.id, tracks, { action: "enqueue", next: true });
      else get().playTracks(tracks, 0, "Queue");
      return 0;
    }
    // While a device is followed it goes there, and shows here at once.
    if (remote) sendSongs(remote.id, tracks, { action: "enqueue", next: true });
    // Behind the ones asked for before: first come, first played.
    const at = lineAt(queue, index);
    // In the line already: it stays where it is.
    const waiting = new Set(queue.slice(index + 1, at).map((t) => t.id));
    const fresh = tracks.filter((t) => !waiting.has(t.id));
    // Shuffle turned off later keeps them where they were asked for.
    const inOrder = unshuffled ? unshuffled.findIndex((t) => t.id === current.id) + at - index : 0;
    // Further down the list too: it comes up from there, it doesn't play twice.
    const asked = new Set(fresh.map((t) => t.id));
    const stillToCome = (list: Track[]): Track[] => list.filter((t) => !asked.has(t.id));
    if (!remote) for (let i = queue.length - 1; i >= at; i--) if (asked.has(queue[i].id)) void output.removeItem(i);
    const end = at + fresh.length;
    set({
      queue: [...queue.slice(0, at), ...fresh, ...stillToCome(queue.slice(at))],
      lineEnd: end,
      unshuffled: unshuffled && [...unshuffled.slice(0, inOrder), ...fresh, ...stillToCome(unshuffled.slice(inOrder))],
      branches: withoutSongs(branches, asked),
    });
    if (!remote) {
      void output.insertItems(at, fresh.map(toItem));
      queueChanged();
      save(true);
    }
    return end - index - 1;
  },

  branchOff(list, from, name) {
    // Without a way to the server only what's on the phone can play.
    const { kept } = useDownloads.getState();
    const offline = useConnection.getState().reach === "offline";
    const { muted } = useLibrary.getState();
    const rest = list.slice(from).filter((t, i) => (!offline || kept[t.id] || fileOfSong(t)) && (i === 0 || !muted.has(t.id)));
    if (!rest.length) return 0;
    const { remote } = get();
    // While a device is followed it goes there, and shows here at once.
    if (remote) sendSongs(remote.id, rest, { action: "branchOff", name });
    // Another song of the same list: the branch starts there instead.
    const same = get().branches.find((b) => b.name === name);
    if (same) set(withoutBranch(same));
    const { queue, index, unshuffled, branches } = get();
    const current = queue[index];
    if (!current) {
      if (!remote) get().playTracks(rest, 0, name, false);
      return rest.length;
    }
    // From the very song that's playing: it just plays on, with its list behind it.
    const startsHere = rest[0].id === current.id;
    const next = startsHere ? rest.slice(1) : rest;
    // Behind everything asked for by hand, and part of it: what's asked for next comes behind the whole branch.
    const at = lineAt(queue, index);
    // A song of the branch that was asked for already plays with the branch, once.
    const brought = new Set(rest.map((t) => t.id));
    const line = queue.slice(index + 1, at).filter((t) => !brought.has(t.id));
    const coming = queue.slice(at);
    const upcoming = [...line, ...branched(coming, next)];
    const inOrder = unshuffled ? unshuffled.findIndex((t) => t.id === current.id) + at - index : 0;
    branchUndo.set(name, { before: coming, unshuffled });
    const now = [...withoutSongs(branches, brought), { name, trackId: rest[0].id, started: startsHere, ids: rest.map((t) => t.id) }];
    set({
      queue: [...queue.slice(0, index + 1), ...upcoming],
      lineEnd: index + 1 + line.length + next.length,
      unshuffled: unshuffled && [...unshuffled.slice(0, inOrder), ...branched(unshuffled.slice(inOrder), next)],
      branches: now,
      ...namesNow(now, get()),
    });
    if (!remote) {
      void output.replaceUpcoming(upcoming.map(toItem));
      queueChanged();
      save(true);
    }
    return rest.length;
  },

  branchFrom(trackId, name) {
    return get().branches.find((b) => b.trackId === trackId && b.name === name);
  },

  cancelBranch(name) {
    const { branches, remote } = get();
    const branch = name === undefined ? branches[branches.length - 1] : branches.find((b) => b.name === name);
    if (!branch) return;
    if (remote) void deviceLink?.send(remote.id, { action: "cancelBranch", name: branch.name });
    set(withoutBranch(branch));
    if (remote) return;
    const { queue, index } = get();
    void output.replaceUpcoming(queue.slice(index + 1).map(toItem));
    queueChanged();
    save(true);
  },

  clearLine() {
    const { remote } = get();
    for (const b of get().branches) set(withoutBranch(b));
    const { queue, index } = get();
    const rest = queue.slice(lineAt(queue, index));
    set({ queue: [...queue.slice(0, index + 1), ...rest], lineEnd: 0 });
    if (remote) {
      sendUpcoming();
      return;
    }
    void output.replaceUpcoming(rest.map(toItem));
    queueChanged();
    save(true);
  },

  removeAt(index) {
    const { queue, index: current, remote, lineEnd, unshuffled, branches } = get();
    if (index === current || !queue[index]) return;
    const gone = queue[index].id;
    // It stays out, also when shuffle goes off or a branch is taken back.
    set({
      queue: queue.filter((_, i) => i !== index),
      index: index < current ? current - 1 : current,
      lineEnd: index < lineEnd ? lineEnd - 1 : lineEnd,
      unshuffled: unshuffled && unshuffled.filter((t) => t.id !== gone),
      branches: withoutSongs(branches, new Set([gone])),
    });
    if (remote) {
      sendUpcoming();
      return;
    }
    void output.removeItem(index);
    queueChanged();
    save(true);
  },

  moveItem(from, to) {
    const { queue, index: current, remote, lineEnd } = get();
    if (from === to || from === current || to < 0 || to >= queue.length) return;
    // Moved out of the line or into it.
    const inLine = (i: number): boolean => i > current && i < lineEnd;
    const line = inLine(from) && !inLine(to) ? lineEnd - 1 : !inLine(from) && inLine(to) ? lineEnd + 1 : lineEnd;
    const next = [...queue];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    const shift = from < current && to >= current ? -1 : from > current && to <= current ? 1 : 0;
    set({ queue: next, index: current + shift, lineEnd: line });
    if (remote) {
      sendUpcoming();
      return;
    }
    void output.moveItem(from, to);
    queueChanged();
    save(true);
  },

  clearUpcoming() {
    const { queue, index, remote } = get();
    branchUndo.clear();
    set({ queue: queue.slice(0, index + 1), lineEnd: 0, branches: [], ...namesNow([], get()) });
    if (remote) {
      sendUpcoming();
      return;
    }
    void output.replaceUpcoming([]);
    queueChanged();
    save(true);
  },

  /** Off → 15 → 30 → 60 minutes → off; answers the minutes now set. */
  cycleSleepTimer() {
    const { sleepAt } = get();
    const left = sleepAt ? Math.round((sleepAt - Date.now()) / 60000) : 0;
    const step = SLEEP_STEPS.find((m) => m > left + 1) ?? null;
    set({ sleepAt: step ? Date.now() + step * 60000 : null });
    return step;
  },

  setRemoteVolume(level) {
    const { remote } = get();
    if (!remote) return;
    volumeHeldUntil = Date.now() + VOLUME_HELD_MS;
    set({ remoteVolume: level });
    volumeWanted = level;
    if (volumeTimer) return;
    const send = (): void => {
      const target = usePlayer.getState().remote;
      if (target && volumeWanted !== null) void deviceLink?.send(target.id, { action: "volume", level: volumeWanted });
      volumeWanted = null;
    };
    send();
    volumeTimer = setTimeout(() => {
      volumeTimer = null;
      send();
    }, VOLUME_EVERY_MS);
  },

  async restore() {
    const savedQuality = await readJson<{ mode?: QualityMode; keep24Bit?: boolean; leveling?: Leveling }>(QUALITY_FILE);
    if (savedQuality?.mode) set({ quality: savedQuality.mode });
    if (savedQuality?.leveling) set({ leveling: savedQuality.leveling });
    if (savedQuality?.keep24Bit) {
      set({ keep24Bit: true });
      await Player.setKeep24Bit(true, false);
    }
    const saved = await readJson<Saved>(FILE);
    activityAt = saved?.at ?? 0;
    queueId = saved?.queueId ?? "";
    const byId = useLibrary.getState().byId;
    const queue = (saved?.ids ?? []).map((id) => byId.get(id)).filter((t): t is Track => !!t);
    const state = await Player.getState().catch(() => null);
    if (state && state.count > 0) {
      // The service played on while the app was away: the list is the saved one.
      if (queue.length === state.count) set({ queue, index: state.index, context: saved?.context ?? "", lineEnd: saved?.line ?? 0, branches: saved?.branches ?? [], homeContext: saved?.home ?? null });
      onState(state);
      return;
    }
    if (!saved || !queue.length) return;
    const index = Math.min(saved.index, queue.length - 1);
    lastIndex = index;
    set({ queue, index, context: saved.context, positionMs: saved.positionMs, repeat: saved.repeat ?? "off", lineEnd: saved.line ?? 0, branches: saved.branches ?? [], homeContext: saved.home ?? null });
    await output.setQueue(queue.map(toItem), index, saved.positionMs, false);
    showStream();
    await output.setRepeat(saved.repeat ?? "off");
  },

  stop() {
    followNext = null;
    void output.pause();
    void output.setQueue([], 0, 0, false);
    branchUndo.clear();
    set({ queue: [], index: 0, context: "", source: null, homeContext: null, positionMs: 0, durationMs: 0, unshuffled: null, lineEnd: 0, branches: [], sleepAt: null });
    activityAt = 0;
    queueId = "";
    writeJson(FILE, null);
  },

  clearError: () => set({ error: null }),
}));

/** Repeat-one is about the song it was turned on for: go to another one, and the whole list repeats from there (Settings). */
function leaveRepeatOne(): boolean {
  if (!useSettings.getState().skipEndsRepeatOne) return false;
  usePlayer.setState({ repeat: "all" });
  void output.setRepeat("all");
  deviceLink?.presence();
  return true;
}

/** A list from the top, whatever came before it. */
function load(queue: Track[], index: number, context: string, order: { shuffle: boolean; unshuffled: Track[] | null }, source: string | null = null): void {
  const before = usePlayer.getState();
  // Listening to another song. With nothing on, repeat-one may well be meant for this one.
  if (before.repeat === "one" && before.playWhenReady && before.queue[before.index] && before.queue[before.index].id !== queue[index]?.id) leaveRepeatOne();
  branchUndo.clear();
  usePlayer.setState({ queue, index, context, source, homeContext: null, ...order, lineEnd: 0, branches: [], positionMs: 0, error: null });
  void output.setQueue(queue.map(toItem), index, 0, true);
  showStream();
  queueChanged();
  save(true);
}

/** A branch's first song came on: nothing is chosen any more, and "Playing from" says its list until its songs are through. */
usePlayer.subscribe((s, prev) => {
  if (!s.branches.length || (s.index === prev.index && s.queue === prev.queue)) return;
  const branches = tendedBranches(s.branches, s.queue, s.index);
  if (branches === s.branches) return;
  for (const b of s.branches) if (!branches.some((kept) => kept.name === b.name)) branchUndo.delete(b.name);
  // Followed, the device playing says what it plays from.
  usePlayer.setState(s.remote ? { branches } : { branches, ...namesNow(branches, s) });
});

/* ------------------------------------------------------------- the native player's news */

let lastSave = 0;
function save(now = false): void {
  if (!now && Date.now() - lastSave < SAVE_EVERY_MS) return;
  lastSave = Date.now();
  const { queue, index, context, positionMs, repeat, lineEnd, branches, homeContext } = usePlayer.getState();
  const saved: Saved = { context, ids: queue.map((t) => t.id), index, positionMs, repeat, at: activityAt, queueId, line: lineEnd, branches, home: homeContext };
  writeJson(FILE, saved);
}

/** One play per listen, by the rule the desktop's statistics use: time heard, not where the scrubber went. */
let counted = false;
let heardMs = 0;
let lastIndex = -1;
let lastPosition = 0;
const LONGEST_TICK_MS = 2000;

/** A swipe moves the page at once: what the player said before it heard of the swipe must not move it back. */
let skipTarget: number | null = null;
let skipUntil = 0;
const SKIP_PATIENCE_MS = 1500;

function onState(s: PlaybackState): void {
  // While another device is followed this one has nothing to say, unless somebody starts it here all the same.
  if (usePlayer.getState().remote) {
    if (!s.isPlaying) return;
    stopFollowing(false, false);
  }
  if (skipTarget !== null) {
    if (s.index !== skipTarget && Date.now() < skipUntil) return;
    skipTarget = null;
  }
  const prev = usePlayer.getState();
  // On repeat-one the player stays on its song by itself: another song means somebody skipped, here, on the lock screen or on headphones.
  if (s.repeat === "one" && s.index !== prev.index && prev.queue[s.index]?.id !== prev.queue[prev.index]?.id && leaveRepeatOne()) s = { ...s, repeat: "all" };
  if (output === Player) {
    bandwidthBps = s.bandwidthBps ?? 0;
    watchStalls(s);
    watchRate(s);
  }
  if (prev.isPlaying !== s.isPlaying || (s.isPlaying && prev.index !== s.index)) activity();
  else if (s.isPlaying) routineActivity();
  if (s.isPlaying && !prev.isPlaying) claimStream();
  if (s.isPlaying) lookAtVolume();
  usePlayer.setState({
    index: s.index,
    isPlaying: s.isPlaying,
    // At the queue's end nothing plays on, whatever was asked for.
    playWhenReady: s.playWhenReady && !s.isEnded,
    isBuffering: s.isBuffering,
    positionMs: s.positionMs,
    durationMs: s.durationMs,
    repeat: s.repeat,
    audio: s.audio,
  });
  const step = s.positionMs - lastPosition;
  // A new song, or this one over from its start (repeat, or scrubbed back there): a new listen.
  if (s.index !== lastIndex || (step < 0 && s.positionMs < LONGEST_TICK_MS)) {
    counted = false;
    heardMs = 0;
  } else if (s.isPlaying && step > 0 && step < LONGEST_TICK_MS) {
    heardMs += step;
  }
  if (s.index !== lastIndex) {
    showStream();
    // Long enough ago that the connection may have recovered: the next song tries again.
    if (capKbps !== null && Date.now() - capSetAt > CAP_LASTS_MS) capKbps = null;
    refreshStreams(false);
  }
  lastIndex = s.index;
  lastPosition = s.positionMs;
  const track = prev.queue[s.index];
  if (track && !counted && heardMs / 1000 >= playCreditSeconds(track.duration)) {
    counted = true;
    useLibrary.getState().notePlayed(track);
  }
  if (s.isEnded && !prev.remote && s.repeat === "off") keepGoing();
  if (prev.sleepAt && Date.now() >= prev.sleepAt) {
    usePlayer.setState({ sleepAt: null });
    void output.pause();
  }
  save(prev.isPlaying !== s.isPlaying || prev.index !== s.index);
}

/* ------------------------------------------------------------- when the queue runs out */

/** How long a song counts as just heard, for "don't repeat". */
const HEARD_LATELY_MS = 7 * 24 * 60 * 60_000;
let keptGoingAt = 0;

/** Autoplay: something else from the library, what the queue doesn't hold yet first. */
function keepGoing(): void {
  const { autoplay, dontRepeat } = useSettings.getState();
  // One end, one song: the player says it's at the end more than once.
  if (!autoplay || Date.now() - keptGoingAt < 2000) return;
  const { queue } = usePlayer.getState();
  const { data, tracks, muted } = useLibrary.getState();
  const { kept } = useDownloads.getState();
  const offline = useConnection.getState().reach === "offline";
  const pool = tracks.filter((t) => !muted.has(t.id) && (!offline || kept[t.id] || fileOfSong(t)));
  const heard = new Set(queue.map((t) => t.id));
  const now = Date.now();
  if (dontRepeat) for (const [id, count] of Object.entries(data.counts)) if (now - (count.lastAt ?? 0) < HEARD_LATELY_MS) heard.add(id);
  const fresh = pool.filter((t) => !heard.has(t.id));
  const from = fresh.length ? fresh : pool;
  const pick = from[Math.floor(Math.random() * from.length)];
  if (!pick) return;
  keptGoingAt = now;
  const at = queue.length;
  usePlayer.setState({ queue: [...queue, pick] });
  void output.addItems([toItem(pick)]);
  void output.skipTo(at, true);
  queueChanged();
  save(true);
}

/* ------------------------------------------------------------- which copy of a song plays */

/** Buffering this long with somebody waiting, or running dry again this soon: the connection doesn't carry what's playing. */
const STALL_MS = 6000;
const STALLS_AGAIN_WITHIN_MS = 45_000;
/** A jump to another place loads for a moment; that says nothing about the connection. */
const LOADING_AFTER_JUMP_MS = 3000;
const CAP_LASTS_MS = 5 * 60_000;

let bandwidthBps = 0;
/** what the connection recently failed to carry */
let capKbps: number | null = null;
let capSetAt = 0;
let transcodesWork = true;
/** the copy asked for, by song */
const chosen = new Map<string, StreamChoice>();
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let waitingNow = false;
let lastStallAt = 0;
let jumpedAt = 0;

function choiceFor(t: Track): StreamChoice {
  // A device fetches the file itself, whatever this phone's connection or downloads are like.
  if (output !== Player) return ORIGINAL;
  if (fileOfSong(t)) return { kind: "download", compact: false };
  const kept = useDownloads.getState().kept[t.id];
  if (kept) return { kind: "download", compact: kept.compact };
  if (!transcodesWork) return ORIGINAL;
  return chooseStream(t, usePlayer.getState().quality, bandwidthBps, capKbps, useConnection.getState().metered);
}

function showStream(): void {
  const { queue, index } = usePlayer.getState();
  const current = queue[index];
  usePlayer.setState({ stream: (current && chosen.get(current.id)) || ORIGINAL });
}

/** Brings what's asked of the server in line with the mode and the connection. The playing song only when told. */
function refreshStreams(currentToo: boolean): void {
  const { queue, index, positionMs } = usePlayer.getState();
  const current = queue[index];
  if (!current) return;
  if (currentToo && !sameChoice(chosen.get(current.id), choiceFor(current))) {
    void output.replaceCurrent(toItem(current), positionMs);
    showStream();
  }
  const upcoming = queue.slice(index + 1);
  if (upcoming.some((t) => !sameChoice(chosen.get(t.id), choiceFor(t)))) void output.replaceUpcoming(upcoming.map(toItem));
}

function smallerCopy(): void {
  const { quality, queue, index } = usePlayer.getState();
  const current = queue[index];
  if (quality !== "auto" || !current || chosen.get(current.id)?.kind === "download") return;
  const cap = stepDown(current, chosen.get(current.id) ?? ORIGINAL);
  if (cap === null) return;
  capKbps = cap;
  capSetAt = Date.now();
  jumpedAt = capSetAt;
  lastStallAt = 0;
  refreshStreams(true);
}

/** Only when the server still answers where it did: moved or gone says nothing about how much the connection carries. */
function smallerCopyIfStillThere(): void {
  const before = useSession.getState().session?.server;
  void useConnection.getState().check().then((reach) => {
    if (reach !== "offline" && useSession.getState().session?.server === before) smallerCopy();
  });
}

function watchStalls(s: PlaybackState): void {
  const waiting = s.isBuffering && s.playWhenReady;
  if (!waiting) {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    waitingNow = false;
    return;
  }
  if (!waitingNow) {
    waitingNow = true;
    const now = Date.now();
    // A song under way that ran dry. The first time can be a bump in the road; soon again it isn't.
    if (s.positionMs > 0 && now - jumpedAt > LOADING_AFTER_JUMP_MS) {
      if (now - lastStallAt < STALLS_AGAIN_WITHIN_MS) smallerCopyIfStillThere();
      else lastStallAt = now;
    }
  }
  if (stallTimer) return;
  stallTimer = setTimeout(() => {
    stallTimer = null;
    smallerCopyIfStillThere();
  }, STALL_MS);
}

/* ------------------------------------------------------------- how fast it really runs */

/** A stretch of plain playing against the clock: 1 is right. Goes out with the note, for when something sounds off. */
const RATE_STRETCH_MS = 10_000;
let rateFrom: { at: number; position: number; index: number } | null = null;
let rateOff = "";

function watchRate(s: PlaybackState): void {
  const now = Date.now();
  if (!s.isPlaying || s.isBuffering || now - jumpedAt < RATE_STRETCH_MS) {
    rateFrom = null;
    return;
  }
  if (!rateFrom || rateFrom.index !== s.index) {
    rateFrom = { at: now, position: s.positionMs, index: s.index };
    return;
  }
  if (now - rateFrom.at < RATE_STRETCH_MS) return;
  const rate = (s.positionMs - rateFrom.position) / (now - rateFrom.at) / useSettings.getState().speed;
  rateFrom = { at: now, position: s.positionMs, index: s.index };
  if (rate > 1.15 || rate < 0.85) rateOff = `ran at ${rate.toFixed(2)}x, ${new Date(now).toISOString()}`;
}

/* ------------------------------------------------------------- where it plays */

/** A zone's news, in the player's own words. */
export function zoneReport(s: PlaybackState): void {
  if (output !== Player) onState(s);
}

export function outputChanged(device: OutputDevice): void {
  const now = usePlayer.getState().device;
  if (now?.id !== device.id || now.name !== device.name || now.tv !== device.tv) usePlayer.setState({ device });
}

/**
 * The queue plays somewhere else from here on: a device on the network, or this
 * phone with null. It goes on from the place it had reached, playing if it was
 * unless told otherwise. What's followed is left behind, paused.
 */
export function switchOutput(next: { output: PlayerOutput; device: OutputDevice } | null, play?: boolean): void {
  const { queue, index, positionMs, playWhenReady, remote, repeat } = usePlayer.getState();
  const wanted = play ?? (remote ? remote.playing : playWhenReady);
  if (remote) {
    void deviceLink?.send(remote.id, { action: "pause" });
    stopFollowing(false, false);
  }
  const before = output;
  output = next?.output ?? Player;
  usePlayer.setState({ device: next?.device ?? null, error: null, stream: ORIGINAL });
  jumpedAt = Date.now();
  skipTarget = null;
  // Nothing may be left here that starts by itself, or shows in the notification.
  if (before === Player && output !== Player) void Player.setQueue([], 0, 0, false);
  if (!queue.length) {
    usePlayer.setState({ isPlaying: false, playWhenReady: false, isBuffering: false });
    return;
  }
  void output.setQueue(queue.map(toItem), index, positionMs, wanted);
  // Whatever plays it goes round the same way.
  void output.setRepeat(repeat);
  showStream();
  activity();
}

/* ------------------------------------------------------------- following another device */

/** A device that was only paused stays on screen for this long; then this phone is by itself again. */
const FOLLOW_PAUSED_MS = 5 * 60_000;
const FOLLOW_TICK_MS = 500;
/** Reports arrive when they arrive: less than this from the clock running here is no move, and the words on screen stay put. */
const FOLLOW_DRIFT_MS = 1500;

interface DeviceLink {
  /** this phone's id among the devices */
  self: string;
  send(deviceId: string, command: DeviceCommand): Promise<boolean>;
  /** A command with a list of songs of any length: they go ahead as the queue document. */
  sendList(deviceId: string, tracks: WireTrack[], context: string | undefined, command: DeviceCommand): Promise<boolean>;
  handOver(deviceId: string): Promise<boolean>;
  /** Look at the position and queue documents again. */
  look(): void;
  /** What this phone says about itself changed. */
  presence(): void;
  /** Whether the service answers: without it the others hear nothing. */
  connected?(): boolean;
}

/** A list this long goes by the queue document rather than in a command. */
const SONGS_IN_A_COMMAND = 100;
const LONGEST_LIST = 5000;
const LIST_BEHIND = 200;
/** A volume dragged here: what the other device says for a moment is older than that. */
const VOLUME_HELD_MS = 1500;
const VOLUME_EVERY_MS = 150;
/** A song asked of the device being followed: what it says for this long may be from before it got there. */
const STEER_PATIENCE_MS = 5000;
/** A pause or a seek there: the same, for a moment. */
const STEER_HOLD_MS = 2000;
/** Well into a song Previous starts it over. */
const RESTART_AFTER_MS = 3000;
let steeringTo: { id: string; until: number } | null = null;
let steerHoldUntil = 0;
let volumeHeldUntil = 0;
let volumeWanted: number | null = null;
let volumeTimer: ReturnType<typeof setTimeout> | null = null;

/** Songs for another device: right in the command if they fit. */
function sendSongs(deviceId: string, tracks: Track[], command: DeviceCommand): void {
  const wire = tracks.slice(0, LONGEST_LIST).map(toWireTrack);
  if (wire.length <= SONGS_IN_A_COMMAND) void deviceLink?.send(deviceId, { ...command, tracks: wire } as DeviceCommand);
  else void deviceLink?.sendList(deviceId, wire, undefined, command);
}

/** The queue was edited here while another device plays it. */
function sendUpcoming(): void {
  const { remote, queue, index, lineEnd } = usePlayer.getState();
  if (remote) sendSongs(remote.id, queue.slice(index + 1), { action: "setUpcoming", line: Math.max(0, lineEnd - index - 1) });
}

/** Started here, not following anybody: there's one stream, and it's here now. */
/** started while the service was away: the others hear of it when it's back */
let claimWhenBack = false;
const playingHereNow = (): boolean => {
  const { isPlaying, playWhenReady, remote } = usePlayer.getState();
  return (isPlaying || playWhenReady) && !remote;
};

function claimStream(): void {
  followNext = null;
  if (usePlayer.getState().secondStream || !deviceLink) return;
  // With the service away nobody hears of it: it's said when it's back.
  claimWhenBack = deviceLink.connected?.() === false;
  for (const d of useDevices.getState().others.filter(isAround)) {
    if (d.presence.playing && !d.presence.separate) void deviceLink.send(d.id, { action: "yield", to: deviceLink.self });
  }
}

/** This phone's volume, for those who steer it. Android tells nobody when the keys change it. */
let phoneVolume: number | null = null;
let volumeAskedAt = 0;
const VOLUME_LOOK_EVERY_MS = 2000;
function lookAtVolume(): void {
  if (output !== Player || Date.now() - volumeAskedAt < VOLUME_LOOK_EVERY_MS) return;
  volumeAskedAt = Date.now();
  void Player.getMediaVolume()
    .then((level) => {
      if (level === phoneVolume) return;
      phoneVolume = level;
      deviceLink?.presence();
    })
    .catch(() => undefined);
}

/** This phone plays its own music from here on; the device being followed goes on with its own. */
export function startSecondStream(): string | null {
  const { remote } = usePlayer.getState();
  if (!remote) return null;
  usePlayer.setState({ secondStream: true });
  followNext = null;
  stopFollowing(false);
  deviceLink?.presence();
  return remote.name;
}

/** Back to one stream: the music here stops, and this phone shows what plays elsewhere. */
export function endSecondStream(): void {
  void output.pause();
  usePlayer.setState({ secondStream: false, isPlaying: false, playWhenReady: false });
  const { others } = useDevices.getState();
  followNext = others.filter(isAround).find((d) => d.presence.playing && d.presence.track)?.id ?? null;
  hearDevices(others);
  deviceLink?.presence();
}

let deviceLink: DeviceLink | null = null;
/** the device this phone just handed its music to: followed at once */
let followNext: string | null = null;
let followTick: ReturnType<typeof setInterval> | null = null;
let followPausedSince = 0;

export function linkDevices(link: DeviceLink | null): void {
  deviceLink = link;
}

function tickFollow(): void {
  const { remote } = usePlayer.getState();
  if (!remote?.playing) return;
  const running = remote.positionMs + (Date.now() - remote.heardAt);
  usePlayer.setState({ positionMs: remote.durationMs > 0 ? Math.min(remote.durationMs, running) : running });
}

/** What the screen shows right after a command, until the device's own word comes. */
function hold(positionMs: number, playing: boolean): void {
  const { remote } = usePlayer.getState();
  if (!remote) return;
  steerHoldUntil = Date.now() + STEER_HOLD_MS;
  usePlayer.setState({ remote: { ...remote, positionMs, playing, heardAt: Date.now() }, positionMs, playWhenReady: playing, isPlaying: playing });
}

/** A song asked of the device being followed: on screen at once, and what that device says before it got there doesn't move it back. */
function steerTo(target: number): void {
  const { remote, queue, index } = usePlayer.getState();
  const song = queue[target];
  if (!remote || !song) return;
  steeringTo = { id: song.id, until: Date.now() + STEER_PATIENCE_MS };
  const durationMs = song.duration * 1000;
  usePlayer.setState({ index: target, positionMs: 0, durationMs, playWhenReady: true, isPlaying: true, error: null, remote: { ...remote, playing: true, positionMs: 0, durationMs, heardAt: Date.now() } });
  void deviceLink?.send(remote.id, { action: "jump", trackId: song.id, by: target - index, track: toWireTrack(song) });
}

/** This phone is by itself again: the queue goes to its own player, from the place the other device had reached. */
function stopFollowing(play: boolean, loadHere = true): void {
  const { queue, index, positionMs, repeat } = usePlayer.getState();
  if (followTick) clearInterval(followTick);
  followTick = null;
  followNext = null;
  steeringTo = null;
  steerHoldUntil = 0;
  usePlayer.setState({ remote: null, playWhenReady: play, isPlaying: play, remoteVolume: null });
  if (loadHere && queue.length) {
    jumpedAt = Date.now();
    void output.setQueue(queue.map(toItem), index, positionMs, play);
    // It goes on the way it did there, not the way this phone's own player was left.
    void output.setRepeat(repeat);
    showStream();
  }
  activity();
}

function follow(device: RemoteDevice): void {
  const p = device.presence;
  if (!p.track) return;
  const before = usePlayer.getState();
  if (!before.remote) {
    // Nothing of its own may start under the other device's music.
    void output.setQueue([], 0, 0, false);
    followTick = setInterval(tickFollow, FOLLOW_TICK_MS);
    followPausedSince = 0;
  }
  if (p.playing) followPausedSince = 0;
  else if (!followPausedSince) followPausedSince = Date.now();
  const song = findSong(p.track) ?? ({ thumb: "", ...p.track } as Track);
  const { queue, index } = before;
  // What it says from before it got to what was asked of it doesn't move the screen back.
  const waiting = !!steeringTo && Date.now() < steeringTo.until && song.id !== steeringTo.id;
  if (!waiting) steeringTo = null;
  const held = before.remote && (waiting || Date.now() < steerHoldUntil) ? before.remote : null;
  const heardMs = p.positionMs + (p.playing ? device.ageMs : 0);
  // A song only just starting there doesn't know its length yet.
  const lengthMs = p.durationMs > 0 ? p.durationMs : song.duration * 1000;
  const runningMs = before.remote?.playing && p.playing && queue[index]?.id === song.id ? before.remote.positionMs + (Date.now() - before.remote.heardAt) : null;
  const close = before.remote && runningMs !== null && Math.abs(runningMs - heardMs) < FOLLOW_DRIFT_MS ? before.remote : null;
  const changes: Partial<PlayerState> = {
    remote: held
      ? { ...held, id: device.id, name: p.name, kind: p.kind }
      : close
        ? { ...close, id: device.id, name: p.name, kind: p.kind, durationMs: lengthMs }
        : { id: device.id, name: p.name, kind: p.kind, playing: p.playing, positionMs: heardMs, durationMs: lengthMs, heardAt: Date.now() },
    ...(held ? {} : { ...(close ? {} : { positionMs: heardMs }), durationMs: lengthMs, playWhenReady: p.playing, isPlaying: p.playing }),
    isBuffering: false,
    error: null,
    shuffle: p.shuffle ?? before.shuffle,
    repeat: p.repeat ?? before.repeat,
    context: p.context ?? before.context,
    ...(Date.now() > volumeHeldUntil ? { remoteVolume: p.volume ?? null } : {}),
  };
  if (!waiting && queue[index]?.id !== song.id) {
    const at = placeOf(queue, song.id, index);
    if (at >= 0 && p.queueId === queueId) changes.index = at;
    else {
      // The queue itself comes with the look below.
      changes.queue = [song];
      changes.index = 0;
      changes.unshuffled = null;
      changes.context = p.context ?? "";
      changes.homeContext = null;
      changes.lineEnd = 0;
      changes.branches = [];
      queueId = "";
      deviceLink?.look();
    }
  } else if (!waiting && p.queueId && p.queueId !== queueId) {
    // The same song, in a list that isn't the one here.
    deviceLink?.look();
  }
  usePlayer.setState(changes);
  // Not playing any more: the others shouldn't go by what it said before.
  if (!before.remote) deviceLink?.presence();
}

/** The other devices said something: who, if anybody, this phone shows. */
export function hearDevices(others: RemoteDevice[]): void {
  useDevices.setState({ others });
  if (claimWhenBack && others.length) {
    claimWhenBack = false;
    if (playingHereNow()) claimStream();
  }
  // Music on a device of the network is this phone's own, playing or not.
  if (output !== Player) return;
  // Its own stream, by request: whatever the others do.
  if (usePlayer.getState().secondStream) return;
  const { remote, isPlaying, playWhenReady } = usePlayer.getState();
  if (!remote && (isPlaying || playWhenReady)) return;
  const around = others.filter(isAround);
  const followed = remote ? around.find((d) => d.id === remote.id && d.presence.track) : undefined;
  const handedTo = followNext ? around.find((d) => d.id === followNext && d.presence.playing && d.presence.track) : undefined;
  if (handedTo) followNext = null;
  const playing = around.find((d) => d.presence.playing && d.presence.track && !d.presence.separate);
  const stillWanted = followed && (followed.presence.playing || !followPausedSince || Date.now() - followPausedSince < FOLLOW_PAUSED_MS);
  // A pause a moment ago is a person between songs: their own queue stays until then.
  const idleHere = Date.now() - ownActivityAt > IDLE_BEFORE_TAKING_OVER_MS;
  const target = handedTo ?? (stillWanted ? followed : undefined) ?? (idleHere ? playing : undefined);
  if (target) follow(target);
  else if (remote) stopFollowing(false);
}

/** What another device asks of this one. */
export function runCommand(command: DeviceCommand): void {
  const player = usePlayer.getState();
  const songsOf = (wire: WireTrack[] | undefined): Track[] => (wire ?? []).map(findSong).filter((t): t is Track => !!t);
  if (command.action === "yield") {
    // The music started on another device: there is one stream, and it's there now.
    if (player.secondStream) return;
    followNext = command.to;
    if (player.playWhenReady && !player.remote) void output.pause();
    return;
  }
  if (player.remote && command.action !== "syncLikes" && command.action !== "enqueue") {
    // Anything else is for a device that plays, and this one doesn't any more: it's from before the music moved on.
    if (command.action !== "takeOver" && command.action !== "playList") return;
    // Asked to play here: whatever this phone was showing, it's this phone's music now.
    stopFollowing(false);
  }
  switch (command.action) {
    case "play":
      if (!usePlayer.getState().playWhenReady) usePlayer.getState().toggle();
      break;
    case "pause":
      if (usePlayer.getState().playWhenReady) usePlayer.getState().toggle();
      break;
    case "next":
      usePlayer.getState().next();
      break;
    case "previous":
      usePlayer.getState().previous();
      break;
    case "seek":
      usePlayer.getState().seek(command.positionMs);
      break;
    case "jump": {
      const { queue, index } = usePlayer.getState();
      // By the song, whichever copy of it that device has in its list.
      const id = (command.track && findSong(command.track)?.id) ?? command.trackId;
      const at = jumpTarget(queue, id, index, command.by);
      if (at >= 0) usePlayer.getState().skipTo(at);
      break;
    }
    case "enqueue": {
      const songs = songsOf(command.tracks);
      if (songs.length) usePlayer.getState().addToQueue(songs);
      break;
    }
    case "takeOver":
      usePlayer.setState({ secondStream: false });
      void output.play();
      break;
    case "playList": {
      const asked = command.tracks?.[command.start];
      const song = asked && findSong(asked);
      const songs = songsOf(command.tracks);
      if (!songs.length) break;
      const start = song ? Math.max(0, songs.indexOf(song)) : 0;
      if (command.keepOrder) load(songs, start, command.context ?? usePlayer.getState().context, { shuffle: usePlayer.getState().shuffle, unshuffled: null });
      else usePlayer.getState().playTracks(songs, start, command.context ?? "", command.shuffle ?? usePlayer.getState().shuffle);
      break;
    }
    case "setUpcoming": {
      const { queue, index } = usePlayer.getState();
      const upcoming = songsOf(command.tracks);
      usePlayer.setState({ queue: [...queue.slice(0, index + 1), ...upcoming], lineEnd: command.line ? index + 1 + command.line : 0 });
      void output.replaceUpcoming(upcoming.map(toItem));
      queueChanged();
      save(true);
      break;
    }
    case "branchOff":
      usePlayer.getState().branchOff(songsOf(command.tracks), 0, command.name);
      break;
    case "cancelBranch":
      usePlayer.getState().cancelBranch(command.name);
      break;
    case "shuffle":
      if (usePlayer.getState().shuffle !== command.on) usePlayer.getState().toggleShuffle();
      break;
    case "repeat":
      usePlayer.setState({ repeat: command.mode });
      void output.setRepeat(command.mode);
      deviceLink?.presence();
      break;
    case "volume":
      if (output === Player) {
        phoneVolume = command.level;
        void Player.setMediaVolume(command.level).catch(() => undefined);
      }
      break;
    default:
      break;
  }
}

/** This phone as the other devices see it. */
export function phonePresence(): DevicePresence {
  const { queue, index, positionMs, durationMs, isPlaying, playWhenReady, context, remote, device, shuffle, repeat, secondStream } = usePlayer.getState();
  const track = queue[index];
  const model = String((Platform.constants as { Model?: string }).Model ?? "Phone");
  const name = device ? `${model} · ${device.name}` : model;
  const separate = secondStream || undefined;
  if (remote || !track) return { name, kind: "phone", separate, playing: false, positionMs: 0, durationMs: 0, track: null };
  return {
    name,
    kind: "phone",
    separate,
    playing: isPlaying || playWhenReady,
    positionMs,
    durationMs,
    track: toWireTrack(track),
    queueId,
    context,
    shuffle,
    repeat,
    volume: output === Player ? phoneVolume ?? undefined : undefined,
  };
}

/* ------------------------------------------------------------- what other devices get to know */

/** A pause a moment ago is a person between songs, not somebody done here. */
const IDLE_BEFORE_TAKING_OVER_MS = 60_000;
/** While the other device plays on in the same song, this one looks up only now and then. */
const FOLLOW_EVERY_MS = 120_000;
const QUEUE_NOTE_BEHIND = 200;
const QUEUE_NOTE_AHEAD = 800;
/** Enough to show a branch's songs together on another device. */
const BRANCH_IDS_SENT = 500;

/** the note this phone stands on: its own or one it took over */
let activityAt = 0;
/** when somebody last did something here */
let ownActivityAt = 0;
let adoptedAt = 0;
let queueId = "";
let tellSync: ((routine: boolean) => void) | null = null;

/** The sync's ear: `routine` is the tick while a song plays. */
export function onPlaybackActivity(listener: ((routine: boolean) => void) | null): void {
  tellSync = listener;
}

/** Later than the note this phone stands on, whatever the two devices' clocks say: it's what makes it the news. */
const newNote = (): number => Math.max(Date.now(), activityAt + 1);

function activity(): void {
  activityAt = newNote();
  ownActivityAt = Date.now();
  tellSync?.(false);
}
function routineActivity(): void {
  activityAt = newNote();
  ownActivityAt = Date.now();
  tellSync?.(true);
}
function queueChanged(): void {
  queueId = String(Date.now());
  activity();
}

/** Where this phone stands, for the others. Nothing until it has done something itself. */
export function playbackNote(device: PlaybackNote["device"]): { note: PlaybackNote; queue: () => QueueDoc } | null {
  const { queue, index, positionMs, isPlaying, context, remote, lineEnd, branches, homeContext, shuffle, repeat, unshuffled } = usePlayer.getState();
  const track = queue[index];
  // What another device plays is that device's to tell; and where the music just went, that it's paused here is no news that should overwrite its word.
  if (!track || !activityAt || remote || followNext) return null;
  if (!queueId) queueId = String(activityAt);
  const id = queueId;
  return {
    note: { device, at: activityAt, playing: isPlaying, positionMs, track: toWireTrack(track), queueId: id, place: index, context, shuffle, repeat, audio: [usePlayer.getState().audio, rateOff, downloadsLine()].filter(Boolean).join(" · ") },
    queue: () => {
      const from = Math.max(0, index - QUEUE_NOTE_BEHIND);
      return {
        id,
        from,
        context,
        home: homeContext ?? undefined,
        tracks: queue.slice(from, index + QUEUE_NOTE_AHEAD).map(toWireTrack),
        lineEnd: lineInList(lineEnd, from),
        branches: branches.map((b) => ({ ...b, ids: b.ids.slice(0, BRANCH_IDS_SENT) })),
        unshuffled: unshuffled ? listAround(unshuffled, track.id, QUEUE_NOTE_BEHIND, QUEUE_NOTE_AHEAD).map(toWireTrack) : undefined,
      };
    },
  };
}

export function wantsPlayback(note: PlaybackNote): boolean {
  const { playWhenReady, isPlaying, remote, secondStream } = usePlayer.getState();
  if (output !== Player) return false;
  // The device being followed: every new song or queue of it, and nothing else of anybody.
  if (remote) return remote.id === note.device.id && note.queueId !== queueId;
  if (playWhenReady || isPlaying || secondStream || !useLibrary.getState().loaded) return false;
  if (note.playing && inSameSong(note) && Date.now() - adoptedAt < FOLLOW_EVERY_MS) return false;
  return note.at > activityAt && Date.now() - ownActivityAt > IDLE_BEFORE_TAKING_OVER_MS;
}

function inSameSong(note: PlaybackNote): boolean {
  const { queue, index } = usePlayer.getState();
  return note.queueId === queueId && !!queue[index] && findSong(note.track)?.id === queue[index].id;
}

/** Continues from another device: its queue, its song, its position, paused until somebody presses play. */
export function adoptPlayback(given: PlaybackNote, queue: QueueDoc | null, handedOver = false): boolean {
  let note = given;
  let current = findSong(note.track);
  if (!current) {
    if (!handedOver) return true;
    // Sent here, and not here: the next song of its list that is, from its start.
    const after = note.place !== undefined && queue?.from !== undefined ? note.place - queue.from + 1 : 0;
    current = (queue?.tracks ?? []).slice(Math.max(0, after)).map(findSong).find((t): t is Track => !!t);
    const { title } = note.track;
    toast(current ? T("“{title}” isn't on this phone, so the next song plays", { title }) : T("“{title}” isn't on this phone", { title }));
    if (!current) return false;
    note = { ...note, track: toWireTrack(current), positionMs: 0, place: undefined };
  }
  adoptedAt = Date.now();
  const repeatThere = note.repeat;
  // The same song a little further on: no need to load it again.
  if (inSameSong(note)) {
    activityAt = note.at;
    usePlayer.setState({ positionMs: note.positionMs, ...(note.shuffle === undefined ? {} : { shuffle: note.shuffle }), ...(repeatThere ? { repeat: repeatThere } : {}) });
    void output.seekTo(note.positionMs);
    if (repeatThere && !usePlayer.getState().remote) void output.setRepeat(repeatThere);
    save(true);
    return true;
  }
  const { muted } = useLibrary.getState();
  const plays = (t: Track | undefined): t is Track => !!t && (t.id === current.id || !muted.has(t.id));
  const songs = (queue?.tracks ?? []).map(findSong);
  const found = songs.filter(plays);
  const whole = found.some((t) => t.id === current.id);
  const list = whole ? found : [current];
  // On its way to another song, asked for here: that's where the screen stays.
  const { positionMs, durationMs, index: indexHere } = usePlayer.getState();
  const going = steeringTo && Date.now() < steeringTo.until ? placeOf(list, steeringTo.id, indexHere) : -1;
  // In its list twice: where that device says it stands.
  const said = note.place !== undefined && queue?.from !== undefined ? note.place - queue.from : -1;
  const playingAt = songs[said]?.id === current.id ? songs.slice(0, said).filter(plays).length : list.findIndex((t) => t.id === current.id);
  const index = going >= 0 ? going : playingAt;
  activityAt = note.at;
  queueId = note.queueId;
  branchUndo.clear();
  usePlayer.setState({
    queue: list,
    index,
    context: queue?.context ?? note.context ?? "",
    homeContext: whole ? queue?.home ?? null : null,
    lineEnd: whole ? songs.slice(0, queue?.lineEnd ?? 0).filter(plays).length : 0,
    branches: whole ? queue?.branches ?? [] : [],
    positionMs: going >= 0 ? positionMs : note.positionMs,
    durationMs: going >= 0 ? durationMs : current.duration * 1000,
    // It goes on the way it did there; an older device doesn't say. Then, followed, what it shows counts, and picked up, the list is in the order it was.
    shuffle: note.shuffle ?? (usePlayer.getState().remote ? usePlayer.getState().shuffle : false),
    ...(repeatThere ? { repeat: repeatThere } : {}),
    // Shuffled there: back to the list's own order when shuffle goes off here.
    unshuffled: whole && note.shuffle && queue?.unshuffled ? queue.unshuffled.map(findSong).filter((t): t is Track => !!t) : null,
    error: null,
  });
  // A device being followed keeps the sound: this phone only needs to know the list.
  if (!usePlayer.getState().remote) {
    void output.setQueue(list.map(toItem), index, note.positionMs, false);
    if (repeatThere) void output.setRepeat(repeatThere);
    showStream();
  }
  save(true);
  return true;
}

/** A dropped connection: the server may answer at its other address, then the song goes on from there. */
const RETRY_AFTER_MS = 8000;
let lastRetryAt = 0;

function afterDroppedConnection(message: string): void {
  void useConnection.getState().check().then((reach) => {
    if (reach === "offline" || Date.now() - lastRetryAt < RETRY_AFTER_MS) {
      usePlayer.setState({ error: reach === "offline" ? T("Can't reach your server. Only downloaded music plays.") : message });
      return;
    }
    lastRetryAt = Date.now();
    // Paused it stays paused: the next press of play loads it from where the server answers now.
    if (usePlayer.getState().playWhenReady) void output.play();
  });
}

/** Listens for the app's lifetime. */
export function watchPlayer(): void {
  Player.addListener("onState", (s) => {
    if (output === Player) onState(s);
  });
  // A song that just arrived on the phone, or one taken off it, changes what's coming up.
  useDownloads.subscribe((s, prev) => {
    if (s.kept === prev.kept) return;
    const { queue, index } = usePlayer.getState();
    const current = queue[index]?.id;
    // The file under the playing song is gone, and the next seek would miss it: on from the server, where one answers.
    const fileGone = !!current && !!prev.kept[current] && !s.kept[current] && useConnection.getState().reach !== "offline";
    refreshStreams(fileGone);
  });
  useConnection.subscribe((s, prev) => {
    if (s.metered !== prev.metered) refreshStreams(false);
  });
  // Muted just now, here or on another device: it's not coming up any more, and if it's on, it goes.
  useLibrary.subscribe((s, prev) => {
    if (s.muted === prev.muted) return;
    const newly = new Set([...s.muted].filter((id) => !prev.muted.has(id)));
    if (!newly.size) return;
    const { queue, index, remote } = usePlayer.getState();
    if (remote) return;
    const upcoming = queue.slice(index + 1);
    const left = upcoming.filter((t) => !newly.has(t.id));
    if (left.length !== upcoming.length) {
      const end = lineAt(queue, index);
      usePlayer.setState({
        queue: [...queue.slice(0, index + 1), ...left],
        lineEnd: end - upcoming.slice(0, end - index - 1).filter((t) => newly.has(t.id)).length,
        branches: withoutSongs(usePlayer.getState().branches, newly),
      });
      void output.replaceUpcoming(left.map(toItem));
      queueChanged();
      save(true);
    }
    if (queue[index] && newly.has(queue[index].id)) {
      if (left.length) usePlayer.getState().next();
      else void output.pause();
    }
  });
  Player.addListener("onError", ({ message, code }) => {
    if (output !== Player) return;
    // A server that can't make the smaller copy: the file itself, for as long as the app runs.
    // A connection that dropped says nothing about the server.
    const { queue, index, positionMs } = usePlayer.getState();
    const current = queue[index];
    if (/NETWORK|TIMEOUT/.test(code ?? "")) {
      afterDroppedConnection(message);
      return;
    }
    if (current && chosen.get(current.id)?.kind === "transcode") {
      transcodesWork = false;
      void output.replaceCurrent(toItem(current), positionMs);
      // Paused it stays paused: a list only just taken over, or a phone in somebody's pocket.
      if (usePlayer.getState().playWhenReady) void output.play();
      refreshStreams(false);
      showStream();
      return;
    }
    usePlayer.setState({ error: message });
  });
}
