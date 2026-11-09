/**
 * The desktop's side of the sync service: playlists and where playback stopped,
 * the same on all devices, and how the library is organised (lib/libraryDocs.ts:
 * pins, sort, groups, album edits). The conversation itself is lib/syncEngine.ts, one
 * copy with the phone; here is what it reads and changes on this computer. The
 * requests go through the main process, which holds the login.
 *
 * There is one stream: a device that isn't playing shows the one that is, and
 * whatever is asked of it goes there, a new song and the volume too. "This
 * computer" in the devices area brings the music here and stops it there. Only a
 * second stream, asked for there as well, lets both go their own way.
 */
import { create } from "zustand";
import { songKey, useCatalog } from "../stores/catalog";
import { useLibrary, type LibraryFolder, type Playlist } from "../stores/library";
import { useMuted } from "../stores/muted";
import { setSteering, usePlayer, type Steering } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { songFinder, toPlaylistDoc, toWireTrack, withSyncedDeletions, type PlaylistDoc, type WireTrack } from "./playlistSync";
import { jumpTarget, lineInList, listAround, placeOf } from "./queueSections";
import { followClock, handOverToCast, takeBackFromCast } from "./audio";
import { useCast } from "./cast";
import { syncFavorites } from "./serverSync";
import { libraryDocHosts, librarySyncReady, onLibrarySyncReady, watchLibraryDocs } from "./libraryDocs";
import { createSyncEngine, DEVICE_ONLINE_MS, type DeviceCommand, type DevicePresence, type PlaybackNote, type QueueDoc, type RemoteDevice, type SyncEngine, type SyncStatus } from "./syncEngine";
import { problemKey, serviceProblem, type SyncServiceInfo, type SyncServiceProblem } from "./syncService";
import { T } from "./i18n";

/** A pause a moment ago is a person between songs, not somebody done here. */
const IDLE_BEFORE_TAKING_OVER_MS = 60_000;
/** While the other device plays on in the same song, this one looks up only now and then. */
const FOLLOW_EVERY_MS = 120_000;
const QUEUE_NOTE_BEHIND = 200;
const QUEUE_NOTE_AHEAD = 800;
/** Enough to show a branch's songs together on another device. */
const BRANCH_IDS_SENT = 500;
/** A device that was only paused stays on screen for this long; then this computer is by itself again. */
const FOLLOW_PAUSED_MS = 5 * 60_000;
const FOLLOW_TICK_MS = 1000;
/** Reports arrive when they arrive: less than this from the clock running here is no move, and the words on screen stay put. */
const FOLLOW_DRIFT_MS = 1500;
const AT_KEY = "songsta.sync.at";
const QUEUE_KEY = "songsta.sync.queueId";
/** the service's problem last told as a note: told once, again only when it's another */
const NOTED_KEY = "songsta.sync.serviceNoted";
/** the servers a sync service ever answered for (home-sync's serverKey), latest last */
const LINKED_KEY = "songsta.sync.linked";
const LINKED_KEPT = 20;

/** Another device whose music this computer shows and steers, itself silent. */
export interface FollowedDevice {
  id: string;
  name: string;
  kind: DevicePresence["kind"];
}

interface HomeSyncState {
  status: SyncStatus;
  address: string | null;
  customAddress: string;
  needsUser: boolean;
  /** the other Songsta devices of this account */
  others: RemoteDevice[];
  followed: FollowedDevice | null;
  /** this computer plays its own music next to another device's, by request */
  secondStream: boolean;
  /** what the linked service says about itself, and why it's too old for this app (lib/syncService.ts) */
  service: SyncServiceInfo | null;
  serviceProblem: SyncServiceProblem | null;
  /** a sync service ever answered this computer for this server: until one has, it's only looked for now and then */
  linked: boolean;
}

export const useHomeSync = create<HomeSyncState>(() => ({
  status: "off",
  address: null,
  customAddress: "",
  needsUser: false,
  others: [],
  followed: null,
  secondStream: false,
  service: null,
  serviceProblem: null,
  linked: false,
}));

export const isAround = (device: RemoteDevice): boolean => device.ageMs < DEVICE_ONLINE_MS;

/** What the devices area can ask of the other Songsta devices; set while the sync runs. */
export const otherDevices = {
  /** This computer's music goes to that device and plays on there. */
  sendTo: async (_id: string): Promise<boolean> => false,
  /** The music of the device being followed comes here and plays on; with `false`, it waits here, say for a speaker to take it. */
  takeHere: (_play?: boolean): void => undefined,
  /** A word for that device. */
  send: async (_id: string, _command: DeviceCommand): Promise<boolean> => false,
  /** This computer plays its own music from here on; the device being followed goes on with its own. */
  startSecondStream: (): void => undefined,
  /** Back to one stream: the music here stops, and this computer shows what plays elsewhere. */
  endSecondStream: (): void => undefined,
};

/** A list this long goes by the queue document rather than in a command. */
const SONGS_IN_A_COMMAND = 100;
/** A song's volume dragged here: what the other device says for a moment is older than that. */
const VOLUME_HELD_MS = 1500;
const VOLUME_EVERY_MS = 150;
/** A song asked of the device being followed: what it says for this long may be from before it got there. */
const STEER_PATIENCE_MS = 5000;
/** A pause or a seek there: the same, for a moment. */
const STEER_HOLD_MS = 2000;
/** Well into a song Previous starts it over, as on the player itself. */
const RESTART_AFTER_SEC = 3;

/** Looks again at the login and the address: after a change in Settings. */
let refreshNow: () => void = () => undefined;
export const refreshHomeSync = (): void => refreshNow();

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a convenience: without it another device's note just counts as newer */
  }
}

function linkedServers(): string[] {
  try {
    const list = JSON.parse(readStored(LINKED_KEY) || "[]");
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

const isLinked = (serverKey: string | null): boolean => !!serverKey && linkedServers().includes(serverKey);

function markLinked(serverKey: string | null): void {
  if (!serverKey) return;
  store(LINKED_KEY, JSON.stringify([...linkedServers().filter((k) => k !== serverKey), serverKey].slice(-LINKED_KEPT)));
}

/** "Search again" in Settings: no service ever answered this computer, and it's looked for now. */
let searchNow: () => void = () => undefined;
export const searchSyncAgain = (): void => searchNow();

/** What the linked service said about itself: a service too old for this app is said once, and in Settings. */
function hearService(info: SyncServiceInfo | null): void {
  const problem = serviceProblem(info);
  useHomeSync.setState({ service: info, serviceProblem: problem });
  if (!problem) {
    store(NOTED_KEY, "");
    return;
  }
  if (readStored(NOTED_KEY) === problemKey(problem)) return;
  store(NOTED_KEY, problemKey(problem));
  useUI.getState().toast(T("Your sync service is out of date: library order, groups and album edits stay on this device until it's updated. Settings say how."), "warning", 9000);
}

let finder: { byId: Map<string, Track>; find: (wire: WireTrack) => Track | undefined } | null = null;

/** The song of this library a description from another device means. */
function findSong(wire: WireTrack): Track | undefined {
  const { byId } = useCatalog.getState();
  if (finder?.byId !== byId) finder = { byId, find: songFinder([...byId.values()]) };
  return finder.find(wire);
}

/**
 * A playlist's song as this computer keeps it: what it already has, the
 * library's own copy, or the description until a library has it. Its id stays:
 * that is what the playlist's versions know it by.
 */
function ownTrack(wire: WireTrack, own: Map<string, Track>): Track {
  const mine = own.get(wire.id) ?? useCatalog.getState().byId.get(wire.id);
  if (mine) return mine;
  return { ...wire, thumb: findSong(wire)?.thumb ?? "" };
}

function applyPlaylists(doc: PlaylistDoc): void {
  const library = useLibrary.getState();
  const own = new Map<string, Track>();
  for (const p of library.playlists) for (const t of p.tracks) own.set(t.id, t);
  const playlists: Playlist[] = doc.playlists.map((p) => ({ ...p, tracks: p.tracks.map((t) => ownTrack(t, own)) }));
  useLibrary.setState({
    playlists,
    folders: doc.folders as LibraryFolder[],
    deletionSync: withSyncedDeletions(library.deletionSync, doc.deletionSync),
  });
}

export function watchHomeSync(): () => void {
  const bridge = window.bytune;
  if (!bridge?.homeSyncInfo) return () => undefined;

  let engine: SyncEngine | null = null;
  let closed = false;
  /** a change made by the sync itself isn't news for the sync */
  let applying = false;
  /** the note this computer stands on: its own or one it took over */
  let activityAt = Number(readStored(AT_KEY)) || 0;
  /** when somebody last did something here */
  let ownActivityAt = 0;
  let queueId = readStored(QUEUE_KEY);
  let adoptedAt = 0;
  let device = { id: "", name: "" };
  /** the device being followed and where it stood when last heard */
  let followed: (FollowedDevice & { playing: boolean; positionMs: number; heardAt: number; pausedSince: number }) | null = null;
  /** started while the service was away: the others hear of it when it's back */
  let claimWhenBack = false;
  let followTimer: number | null = null;
  /** the device this computer just handed its music to: followed at once */
  let followNext: string | null = null;
  let volumeHeldUntil = 0;
  /** the song asked of the device being followed, until it says it got there */
  let steeringTo: { id: string; until: number } | null = null;
  let heldUntil = 0;
  let volumeTimer: number | null = null;
  let volumeWanted: number | null = null;
  /** which server, and the address the service was last looked for at */
  let serverKey: string | null = null;
  let lookedAt: string | null = null;
  /** a service answered while this ran, for this server: known, whether or not it could be written down */
  let linkedHere = false;
  const linked = (): boolean => linkedHere || isLinked(serverKey);

  function inSameSong(note: PlaybackNote): boolean {
    const { queue, index } = usePlayer.getState();
    return note.queueId === queueId && !!queue[index] && songKey(findSong(note.track)?.id ?? "") === songKey(queue[index].id);
  }

  /** Later than the note this computer stands on, whatever the two devices' clocks say: it's what makes it the news. */
  const newNote = (): number => Math.max(Date.now(), activityAt + 1);

  const activity = (): void => {
    activityAt = newNote();
    ownActivityAt = Date.now();
    store(AT_KEY, String(activityAt));
    engine?.playbackChanged();
  };

  function readPlayback(): { note: PlaybackNote; queue: () => QueueDoc } | null {
    const { queue, index, position, playing, shuffle, repeat } = usePlayer.getState();
    const track = queue[index];
    // What another device plays is that device's to tell; and where the music just went, that it's paused here is no news that should overwrite its word.
    if (!track || !activityAt || followed || followNext) return null;
    if (!queueId) queueId = String(activityAt);
    const id = queueId;
    store(AT_KEY, String(activityAt));
    return {
      note: { device, at: activityAt, playing, positionMs: position * 1000, track: toWireTrack(track), queueId: id, place: index, shuffle, repeat },
      queue: () => {
        const from = Math.max(0, index - QUEUE_NOTE_BEHIND);
        const { lineEnd, branches, unshuffled } = usePlayer.getState();
        return {
          id,
          from,
          tracks: queue.slice(from, index + QUEUE_NOTE_AHEAD).map(toWireTrack),
          lineEnd: lineInList(lineEnd, from),
          branches: branches.map((b) => ({ ...b, ids: b.ids.slice(0, BRANCH_IDS_SENT) })),
          unshuffled: unshuffled ? listAround(unshuffled, track.id, QUEUE_NOTE_BEHIND, QUEUE_NOTE_AHEAD).map(toWireTrack) : undefined,
        };
      },
    };
  }

  function wantsPlayback(note: PlaybackNote): boolean {
    // The device being followed: every new queue of it, and nothing else of anybody.
    if (followed) return followed.id === note.device.id && note.queueId !== queueId;
    if (useCast.getState().active || useHomeSync.getState().secondStream) return false;
    if (usePlayer.getState().playing || !useCatalog.getState().loaded) return false;
    if (note.playing && inSameSong(note) && Date.now() - adoptedAt < FOLLOW_EVERY_MS) return false;
    return note.at > activityAt && Date.now() - ownActivityAt > IDLE_BEFORE_TAKING_OVER_MS;
  }

  /** Continues from another device: its queue, its song, its position, paused until somebody presses play. */
  function adoptPlayback(given: PlaybackNote, queue: QueueDoc | null, handedOver = false): boolean {
    let note = given;
    let current = findSong(note.track);
    if (!current) {
      if (!handedOver) return true;
      // Sent here, and not here: the next song of its list that is, from its start.
      const after = note.place !== undefined && queue?.from !== undefined ? note.place - queue.from + 1 : 0;
      current = (queue?.tracks ?? []).slice(Math.max(0, after)).map(findSong).find((t): t is Track => !!t);
      const { title } = note.track;
      useUI.getState().toast(current ? T("\"{title}\" isn't on this computer, so the next song plays", { title }) : T("\"{title}\" isn't on this computer", { title }), "warning");
      if (!current) return false;
      note = { ...note, track: toWireTrack(current), positionMs: 0, place: undefined };
    }
    adoptedAt = Date.now();
    const goesOn = { ...(note.shuffle === undefined ? {} : { shuffle: note.shuffle }), ...(note.repeat ? { repeat: note.repeat } : {}) };
    // The same song a little further on: no need to load it again, nor to say so.
    if (inSameSong(note)) {
      applying = true;
      activityAt = note.at;
      store(AT_KEY, String(activityAt));
      usePlayer.setState({ position: note.positionMs / 1000, seekNonce: usePlayer.getState().seekNonce + 1, ...goesOn });
      applying = false;
      return true;
    }
    const wires = queue?.tracks ?? [];
    const songs = wires.map(findSong);
    const found = songs.filter((t): t is Track => !!t);
    const whole = found.some((t) => t.id === current.id);
    const list = whole ? found : [current];
    const newQueue = note.queueId !== queueId;
    // On its way to another song, asked for here: that's where the screen stays.
    const state = usePlayer.getState();
    const going = steeringTo && Date.now() < steeringTo.until ? placeOf(list, songKey(steeringTo.id), state.index, undefined, (t) => songKey(t.id)) : -1;
    // In its list twice: where that device says it stands.
    const said = note.place !== undefined && queue?.from !== undefined ? note.place - queue.from : -1;
    const playingAt = songs[said]?.id === current.id ? songs.slice(0, said).filter(Boolean).length : list.findIndex((t) => t.id === current.id);
    applying = true;
    activityAt = note.at;
    queueId = note.queueId;
    store(AT_KEY, String(activityAt));
    store(QUEUE_KEY, queueId);
    usePlayer.setState({
      queue: list,
      index: going >= 0 ? going : playingAt,
      ...goesOn,
      // Shuffled there: back to the list's own order when shuffle goes off here.
      unshuffled: whole && note.shuffle && queue?.unshuffled ? queue.unshuffled.map(findSong).filter((t): t is Track => !!t) : null,
      lineEnd: whole ? songs.slice(0, queue?.lineEnd ?? 0).filter(Boolean).length : 0,
      branches: whole ? (queue?.branches ?? []) : [],
      position: going >= 0 ? state.position : note.positionMs / 1000,
      duration: going >= 0 ? state.duration : current.duration,
      playing: followed?.playing ?? false,
      error: null,
      seekNonce: usePlayer.getState().seekNonce + 1,
    });
    applying = false;
    // A new song within a queue this one already follows needs no word; a device being followed shows by itself.
    if (newQueue && !followed) useUI.getState().toast(T("Picked up from {name}", { name: note.device.name }), "info");
    return true;
  }

  /** Songs for the device being followed: right in the command if they fit. */
  function sendSongs(tracks: Track[], command: DeviceCommand): void {
    if (!followed) return;
    const wire = tracks.slice(0, QUEUE_NOTE_AHEAD).map(toWireTrack);
    if (wire.length <= SONGS_IN_A_COMMAND) void engine?.sendCommand(followed.id, { ...command, tracks: wire } as DeviceCommand);
    else void engine?.sendList(followed.id, wire, undefined, command);
  }

  /** A song asked of the device being followed: on screen at once, and what that device says before it got there doesn't move it back. */
  function steerTo(at: number): void {
    const { queue, index } = usePlayer.getState();
    const song = queue[at];
    if (!followed || !song) return;
    steeringTo = { id: song.id, until: Date.now() + STEER_PATIENCE_MS };
    applying = true;
    usePlayer.setState({ index: at, position: 0, duration: song.duration, playing: true, error: null });
    applying = false;
    followed = { ...followed, playing: true, positionMs: 0, heardAt: Date.now(), pausedSince: 0 };
    followClock(0, true);
    void engine?.sendCommand(followed.id, { action: "jump", trackId: song.id, by: at - index, track: toWireTrack(song) });
  }

  /** What's asked of the player here while a device is followed: for that device, and shown here at once. */
  const steering: Steering = {
    play(tracks, start, keepOrder) {
      if (!followed) return;
      const song = tracks[start];
      applying = true;
      usePlayer.setState({ queue: [song], index: 0, playing: true, position: 0, duration: song.duration, lineEnd: 0, branches: [], error: null, seekNonce: usePlayer.getState().seekNonce + 1 });
      applying = false;
      steeringTo = { id: song.id, until: Date.now() + STEER_PATIENCE_MS };
      // The list itself comes back with that device's next word, in the order it plays.
      queueId = "";
      followed = { ...followed, playing: true, positionMs: 0, heardAt: Date.now() };
      followClock(0, true);
      void engine?.sendList(followed.id, tracks.slice(0, QUEUE_NOTE_AHEAD).map(toWireTrack), undefined, { action: "playList", start, keepOrder, shuffle: usePlayer.getState().shuffle });
    },
    upcoming(tracks) {
      const { lineEnd, index } = usePlayer.getState();
      sendSongs(tracks, { action: "setUpcoming", line: Math.max(0, lineEnd - index - 1) });
    },
    add: (tracks) => sendSongs(tracks, { action: "enqueue", next: true }),
    jump: (track) => steerTo(usePlayer.getState().queue.indexOf(track)),
    branchOff: (tracks, name) => sendSongs(tracks, { action: "branchOff", name }),
    cancelBranch: (name) => void (followed && engine?.sendCommand(followed.id, { action: "cancelBranch", name })),
    shuffle: (on) => void (followed && engine?.sendCommand(followed.id, { action: "shuffle", on })),
    repeat: (mode) => void (followed && engine?.sendCommand(followed.id, { action: "repeat", mode })),
    next() {
      const { queue, index } = usePlayer.getState();
      if (queue[index + 1]) steerTo(index + 1);
      else if (followed) void engine?.sendCommand(followed.id, { action: "next" });
    },
    previous() {
      const { index, position, seekNonce } = usePlayer.getState();
      if (index > 0 && position <= RESTART_AFTER_SEC) {
        steerTo(index - 1);
        return;
      }
      // The same song over: the seek goes out by the store's change, like any other.
      usePlayer.setState({ position: 0, seekNonce: seekNonce + 1 });
    },
    volume(level) {
      volumeHeldUntil = Date.now() + VOLUME_HELD_MS;
      volumeWanted = level;
      if (volumeTimer !== null) return;
      const send = (): void => {
        if (followed && volumeWanted !== null) void engine?.sendCommand(followed.id, { action: "volume", level: volumeWanted });
        volumeWanted = null;
      };
      send();
      volumeTimer = window.setTimeout(() => {
        volumeTimer = null;
        send();
      }, VOLUME_EVERY_MS);
    },
  };

  /** While a device is followed, what happens to the store here is a wish for that device. */
  function steer(state: ReturnType<typeof usePlayer.getState>, prev: ReturnType<typeof usePlayer.getState>): void {
    if (applying || !followed) return;
    const cur = state.queue[state.index];
    const before = prev.queue[prev.index];
    if (cur && cur.id !== before?.id) void engine?.sendCommand(followed.id, { action: "jump", trackId: cur.id, track: toWireTrack(cur) });
    else if (state.seekNonce !== prev.seekNonce) {
      heldUntil = Date.now() + STEER_HOLD_MS;
      followed = { ...followed, positionMs: state.position * 1000, heardAt: Date.now() };
      followClock(state.position, followed.playing);
      void engine?.sendCommand(followed.id, { action: "seek", positionMs: state.position * 1000 });
    }
    if (state.playing !== prev.playing) {
      heldUntil = Date.now() + STEER_HOLD_MS;
      followed = { ...followed, playing: state.playing, positionMs: state.position * 1000, heardAt: Date.now() };
      followClock(state.position, state.playing);
      void engine?.sendCommand(followed.id, { action: state.playing ? "play" : "pause" });
    }
  }

  /** Where the device being followed stands by now: the seek bar and the words on screen go by this. */
  function tickFollow(): void {
    if (!followed) return;
    const { duration } = usePlayer.getState();
    const running = (followed.positionMs + (followed.playing ? Date.now() - followed.heardAt : 0)) / 1000;
    const at = duration > 0 ? Math.min(duration, running) : running;
    followClock(at, followed.playing);
    if (!followed.playing) return;
    applying = true;
    usePlayer.getState()._setTime(at);
    applying = false;
  }

  /** This computer is by itself again, from the place the other device had reached. */
  function stopFollowing(play: boolean): void {
    if (!followed) return;
    followed = null;
    followNext = null;
    setSteering(null);
    if (followTimer !== null) window.clearInterval(followTimer);
    followTimer = null;
    useHomeSync.setState({ followed: null });
    applying = true;
    steeringTo = null;
    heldUntil = 0;
    usePlayer.setState({ remoteVolume: null });
    usePlayer.getState().setPlaying(play);
    applying = false;
    takeBackFromCast();
    activity();
  }

  function follow(other: RemoteDevice): void {
    const p = other.presence;
    if (!p.track) return;
    if (!followed) {
      handOverToCast(steer);
      setSteering(steering);
      followTimer = window.setInterval(tickFollow, FOLLOW_TICK_MS);
      // Not playing any more: the others shouldn't go by what it said before.
      engine?.presenceChanged();
    }
    const song = findSong(p.track) ?? ({ thumb: "", ...p.track } as Track);
    // That device can have a song as another copy than the list here: the same song is the same song.
    const isIt = (t: Track | { id: string } | null | undefined): boolean => !!t && songKey(t.id) === songKey(song.id);
    // What it says from before it got to what was asked of it doesn't move the screen back.
    const waiting = !!steeringTo && Date.now() < steeringTo.until && !isIt(steeringTo);
    if (!waiting) steeringTo = null;
    const held = !!followed && (waiting || Date.now() < heldUntil);
    const positionMs = p.positionMs + (p.playing ? other.ageMs : 0);
    const pausedSince = p.playing ? 0 : followed?.pausedSince || Date.now();
    const { queue, index } = usePlayer.getState();
    const runningMs = followed?.playing && p.playing && isIt(queue[index]) ? followed.positionMs + (Date.now() - followed.heardAt) : null;
    const close = runningMs !== null && Math.abs(runningMs - positionMs) < FOLLOW_DRIFT_MS;
    followed =
      followed && (held || close)
        ? { ...followed, id: other.id, name: p.name, kind: p.kind, pausedSince: held ? followed.pausedSince : pausedSince }
        : { id: other.id, name: p.name, kind: p.kind, playing: p.playing, positionMs, heardAt: Date.now(), pausedSince };
    if (useHomeSync.getState().followed?.id !== other.id || useHomeSync.getState().followed?.name !== p.name) {
      useHomeSync.setState({ followed: { id: other.id, name: p.name, kind: p.kind } });
    }
    applying = true;
    if (!waiting && !isIt(queue[index])) {
      const at = placeOf(queue, songKey(song.id), index, undefined, (t) => songKey(t.id));
      if (at >= 0 && p.queueId === queueId) usePlayer.setState({ index: at });
      else {
        // The queue itself comes with the look below.
        usePlayer.setState({ queue: [song], index: 0, unshuffled: null, lineEnd: 0, branches: [] });
        queueId = "";
        void engine?.checkPlayback();
      }
    } else if (!waiting && p.queueId && p.queueId !== queueId) {
      // The same song, in a list that isn't the one here.
      void engine?.checkPlayback();
    }
    const { shuffle, repeat } = usePlayer.getState();
    usePlayer.setState({
      // A song only just starting there doesn't know its length yet.
      ...(held ? {} : { playing: p.playing, ...(close ? {} : { position: positionMs / 1000 }), duration: p.durationMs > 0 ? p.durationMs / 1000 : song.duration }),
      error: null,
      shuffle: p.shuffle ?? shuffle,
      repeat: p.repeat ?? repeat,
      ...(Date.now() > volumeHeldUntil ? { remoteVolume: p.volume ?? null } : {}),
    });
    applying = false;
    tickFollow();
  }

  /** The other devices said something: who, if anybody, this computer shows. */
  /** Started here: there's one stream, and it's here now. With the service away nobody hears of it, so it's said when it's back. */
  function claimStream(): void {
    claimWhenBack = useHomeSync.getState().status !== "connected";
    for (const other of useHomeSync.getState().others.filter(isAround)) {
      if (other.presence.playing && !other.presence.separate) void engine?.sendCommand(other.id, { action: "yield", to: device.id });
    }
  }

  function hearDevices(others: RemoteDevice[]): void {
    useHomeSync.setState({ others });
    if (claimWhenBack && others.length) {
      claimWhenBack = false;
      if (usePlayer.getState().playing && !followed && !useHomeSync.getState().secondStream) claimStream();
    }
    if (!followed && usePlayer.getState().playing) return;
    // A network player has this computer's music: it isn't idle.
    if (useCast.getState().active) return;
    // Its own stream, by request: whatever the others do.
    if (useHomeSync.getState().secondStream) return;
    const around = others.filter(isAround);
    const current = followed ? around.find((d) => d.id === followed?.id && d.presence.track) : undefined;
    const handedTo = followNext ? around.find((d) => d.id === followNext && d.presence.playing && d.presence.track) : undefined;
    if (handedTo) followNext = null;
    const playing = around.find((d) => d.presence.playing && d.presence.track && !d.presence.separate);
    const stillWanted = current && (current.presence.playing || !followed?.pausedSince || Date.now() - followed.pausedSince < FOLLOW_PAUSED_MS);
    const idleHere = Date.now() - ownActivityAt > IDLE_BEFORE_TAKING_OVER_MS;
    const target = handedTo ?? (stillWanted ? current : undefined) ?? (idleHere ? playing : undefined);
    if (target) follow(target);
    else if (followed) stopFollowing(false);
  }

  function runCommand(command: DeviceCommand): void {
    if (command.action === "syncLikes") {
      void syncFavorites().catch(() => undefined);
      return;
    }
    const songsOf = (wire: WireTrack[] | undefined): Track[] => (wire ?? []).map(findSong).filter((t): t is Track => !!t);
    if (command.action === "enqueue") {
      const songs = songsOf(command.tracks);
      if (songs.length) usePlayer.getState().addToQueue(songs);
      return;
    }
    if (command.action === "yield") {
      // The music started on another device: there is one stream, and it's there now.
      if (useHomeSync.getState().secondStream) return;
      followNext = command.to;
      // Showing a device already, a pause here would go there: the very music that just started.
      if (!followed) usePlayer.getState().setPlaying(false);
      return;
    }
    if (followed) {
      // Anything else is for a device that plays, and this one doesn't any more: it's from before the music moved on.
      if (command.action !== "takeOver" && command.action !== "playList") return;
      // Asked to play here: whatever this computer was showing, it's this computer's music now.
      stopFollowing(false);
    }
    const player = usePlayer.getState();
    switch (command.action) {
      case "takeOver":
        useHomeSync.setState({ secondStream: false });
        player.setPlaying(true);
        break;
      case "play":
        player.setPlaying(true);
        break;
      case "playList": {
        const asked = command.tracks?.[command.start];
        const song = asked && findSong(asked);
        const songs = songsOf(command.tracks);
        if (!songs.length) break;
        const start = song ? Math.max(0, songs.indexOf(song)) : 0;
        if (command.shuffle !== undefined) usePlayer.setState({ shuffle: command.shuffle });
        if (command.keepOrder) usePlayer.setState({ queue: songs, index: start, unshuffled: null, lineEnd: 0, branches: [], playing: true, position: 0, error: null });
        else player.playQueue(songs, start);
        break;
      }
      case "setUpcoming":
        player.replaceUpcoming(songsOf(command.tracks), command.line);
        break;
      case "branchOff":
        player.branchOff(songsOf(command.tracks), command.name);
        break;
      case "cancelBranch":
        player.cancelBranch(command.name);
        break;
      case "shuffle":
        if (player.shuffle !== command.on) player.toggleShuffle();
        break;
      case "repeat":
        usePlayer.setState({ repeat: command.mode });
        break;
      case "volume":
        player.setVolume(command.level);
        break;
      case "pause":
        player.setPlaying(false);
        break;
      case "next":
        player.next(true);
        break;
      case "previous":
        player.prev();
        break;
      case "seek":
        player.seek(command.positionMs / 1000);
        break;
      case "jump": {
        // By the song, whichever copy of it that device has in its list.
        const id = (command.track && findSong(command.track)?.id) ?? command.trackId;
        const at = jumpTarget(player.queue, songKey(id), player.index, command.by, (t) => songKey(t.id));
        if (at >= 0) player.jumpTo(at);
        break;
      }
      default:
        break;
    }
  }

  function readPresence(): DevicePresence {
    const { queue, index, position, duration, playing, shuffle, repeat, volume, muted } = usePlayer.getState();
    const track = queue[index];
    const base = { name: device.name, kind: "computer" as const, separate: useHomeSync.getState().secondStream || undefined };
    if (followed || !track) return { ...base, playing: false, positionMs: 0, durationMs: 0, track: null };
    return { ...base, playing, positionMs: position * 1000, durationMs: duration * 1000, track: toWireTrack(track), queueId, shuffle, repeat, volume: muted ? 0 : volume };
  }

  async function refresh(): Promise<void> {
    const info = await bridge!.homeSyncInfo();
    if (closed) return;
    if ((info.serverKey ?? null) !== serverKey) linkedHere = false;
    serverKey = info.serverKey ?? null;
    useHomeSync.setState({ address: info.address, customAddress: info.customAddress, needsUser: info.needsUser, linked: linked() });
    device = { id: info.deviceId, name: info.deviceName };
    // A new address (another one entered, or away from home and back) is worth a look at once; nothing else is.
    const moved = info.address !== lookedAt;
    lookedAt = info.address;
    const wanted =
      info.ready &&
      useSettings.getState().syncPlaylists &&
      useCatalog.getState().loaded &&
      useLibrary.persist.hasHydrated() &&
      usePlayer.persist.hasHydrated() &&
      librarySyncReady();
    if (!wanted) {
      engine?.stop();
      engine = null;
      // Not linked any more: nothing to say about a service.
      useHomeSync.setState({ status: "off", service: null, serviceProblem: null });
      return;
    }
    if (engine) {
      if (moved) engine.retryNow();
      return;
    }
    engine = createSyncEngine({
      deviceId: info.deviceId,
      request: (method, path, body, timeoutMs) => bridge!.homeSyncRequest(method, path, body, timeoutMs),
      // Most people have no sync service: until one answered for this server, it's looked for once a start and when asked.
      linked,
      onLinked() {
        linkedHere = true;
        markLinked(serverKey);
        useHomeSync.setState({ linked: true });
      },
      readPlaylists: () => toPlaylistDoc(useLibrary.getState()),
      applyPlaylists(doc) {
        applying = true;
        applyPlaylists(doc);
        applying = false;
      },
      readPlayback,
      wantsPlayback,
      adoptPlayback,
      readLikes: () => useLibrary.getState().liked.map(toWireTrack),
      readPresence,
      applyDevices: hearDevices,
      onCommand: runCommand,
      readMuted: () => ({ at: useMuted.getState().at, tracks: useMuted.getState().tracks.map(toWireTrack) }),
      applyMuted(doc) {
        applying = true;
        useMuted.getState().apply(doc.tracks.map((wire) => findSong(wire) ?? ({ thumb: "", ...wire } as Track)), doc.at);
        applying = false;
      },
      onStatus: (status) => useHomeSync.setState({ status }),
      library: libraryDocHosts(),
      onService: hearService,
    });
    otherDevices.send = (id, command) => engine?.sendCommand(id, command) ?? Promise.resolve(false);
    otherDevices.sendTo = async (id) => {
      const sent = (await engine?.handOver(id)) ?? false;
      if (sent) {
        followNext = id;
        useHomeSync.setState({ secondStream: false });
        usePlayer.getState().setPlaying(false);
      }
      return sent;
    };
    otherDevices.takeHere = (play = true) => {
      if (!followed) return;
      // The pause is for a device that doesn't know the second word yet.
      void engine?.sendCommand(followed.id, { action: "pause" });
      void engine?.sendCommand(followed.id, { action: "yield", to: device.id });
      stopFollowing(play);
    };
    otherDevices.startSecondStream = () => {
      if (!followed) return;
      const { name } = followed;
      useHomeSync.setState({ secondStream: true });
      followNext = null;
      stopFollowing(false);
      useUI.getState().toast(T("Second stream: what you start now plays here. {name} goes on by itself.", { name }), "info");
      engine?.presenceChanged();
    };
    otherDevices.endSecondStream = () => {
      const playing = useHomeSync.getState().others.filter(isAround).find((d) => d.presence.playing && d.presence.track);
      useHomeSync.setState({ secondStream: false });
      usePlayer.getState().setPlaying(false);
      followNext = playing?.id ?? null;
      hearDevices(useHomeSync.getState().others);
      engine?.presenceChanged();
    };
    engine.start();
  }

  const refreshQuietly = (): void => void refresh().catch(() => undefined);
  refreshNow = refreshQuietly;
  searchNow = () => engine?.searchAgain();
  // Away from home and back: the address moved, and the service is looked for at the new one.
  const offReach = bridge.onJellyfinReach?.(() => refreshQuietly()) ?? (() => undefined);

  // What the stores read from disk at the start isn't anything somebody just did.
  const offLibrary = useLibrary.subscribe((s, prev) => {
    if (s.liked !== prev.liked && useLibrary.persist.hasHydrated()) engine?.likesChanged();
    if (!applying && useLibrary.persist.hasHydrated() && (s.playlists !== prev.playlists || s.folders !== prev.folders)) engine?.playlistsChanged();
  });
  let playerRead = usePlayer.persist.hasHydrated();
  const offPlayer = usePlayer.subscribe((s, prev) => {
    if (applying || !playerRead) return;
    // Started here, not following anybody: there's one stream, and it's here now.
    if (s.playing && !prev.playing && !followed && !useHomeSync.getState().secondStream) {
      followNext = null;
      claimStream();
    }
    if (s.volume !== prev.volume || s.muted !== prev.muted || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat) engine?.presenceChanged();
    if (s.queue !== prev.queue) {
      // Followed, the device playing says when its list changed.
      if (!followed) {
        queueId = String(Date.now());
        store(QUEUE_KEY, queueId);
      }
      activity();
    } else if (s.playing !== prev.playing || s.index !== prev.index || s.seekNonce !== prev.seekNonce) {
      activity();
    } else if (s.playing && s.position !== prev.position) {
      activityAt = newNote();
      ownActivityAt = Date.now();
      engine?.playbackChanged(true);
    }
  });
  const offMuted = useMuted.subscribe((s, prev) => {
    if (!applying && s.at !== prev.at) engine?.mutedChanged();
  });
  const offCatalog = useCatalog.subscribe((s, prev) => {
    if (s.loaded && !prev.loaded) refreshQuietly();
  });
  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.syncPlaylists !== prev.syncPlaylists) refreshQuietly();
  });
  const offHydrations = [
    useLibrary.persist.onFinishHydration(refreshQuietly),
    usePlayer.persist.onFinishHydration(() => {
      playerRead = true;
      refreshQuietly();
    }),
    onLibrarySyncReady(refreshQuietly),
    // How the library is organised: pins, sort, groups, album edits and pictures (lib/libraryDocs.ts).
    watchLibraryDocs((name) => engine?.libraryChanged(name)),
  ];
  const onFocus = (): void => void engine?.checkPlayback();
  const onLeave = (): void => void engine?.flushPlayback();
  window.addEventListener("bytune:remote-library-updated", refreshQuietly);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pagehide", onLeave);
  refreshQuietly();

  return () => {
    closed = true;
    refreshNow = () => undefined;
    searchNow = () => undefined;
    offReach();
    setSteering(null);
    engine?.stop();
    if (followTimer !== null) window.clearInterval(followTimer);
    offMuted();
    offLibrary();
    offPlayer();
    offCatalog();
    offSettings();
    for (const off of offHydrations) off();
    window.removeEventListener("bytune:remote-library-updated", refreshQuietly);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pagehide", onLeave);
  };
}
