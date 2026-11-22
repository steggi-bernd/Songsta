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
import { songFromPhone } from "./peerSongs";
import { create } from "zustand";
import { songKey, useCatalog } from "../stores/catalog";
import { useLibrary, type LibraryFolder, type Playlist } from "../stores/library";
import { useMuted } from "../stores/muted";
import { setEditAhead, setSteering, usePlayer, type Steering } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { songFinder, toPlaylistDoc, toWireTrack, withSyncedDeletions, type PlaylistDoc, type WireTrack } from "./playlistSync";
import { lineEndOf } from "./queueCore";
import { applyEdits, createEntryBook, editsBetween, editsFromList, randomId, readOps, type EditPlayer, type QueueOp } from "./queueEntries";
import { jumpTarget, lineInList, listAround, placeOf } from "./queueSections";
import { followClock, handOverToCast, takeBackFromCast } from "./audio";
import { useCast } from "./cast";
import { syncFavorites } from "./serverSync";
import { libraryDocHosts, librarySyncReady, onLibrarySyncReady, watchLibraryDocs } from "./libraryDocs";
import { computerListenHost, keepOwnPlaysHere, useListenCursors } from "./listenShare";
import { sharesListens } from "./listenSync";
import { createSyncEngine, DEVICE_ONLINE_MS, keptFrom, type DeviceCommand, type DevicePresence, type KeepAfter, type PlaybackNote, type QueueDoc, type RemoteDevice, type SyncEngine, type SyncStatus } from "./syncEngine";
import { problemKey, serviceProblem, type SyncServiceInfo, type SyncServiceProblem } from "./syncService";
import { T } from "./i18n";

/** A pause a moment ago is a person between songs, not somebody done here. */
const IDLE_BEFORE_TAKING_OVER_MS = 60_000;
/** The service answered within this long: it's listening, and a look at the window needs no new round. */
const LISTENING_FINE_MS = 28_000;
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
/** The order of Liked Songs last agreed on with the sync service: what changed here since goes on top of a newer one. */
const LIKES_BASE_KEY = "songsta.sync.likesBase";
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
  /** the service is this computer's own, for phones at home (Settings → Phones at home) */
  home: boolean;
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
  home: false,
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
/** Songs for another device go with the ids they're to have there, up to this many at once. */
const NAMED_UP_TO = 500;
/** The most of a list another device is sent, and how much of it comes before the song it starts at (as from the phone). */
const LONGEST_LIST = 5000;
const LIST_BEHIND = 200;
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
/** Asks the sync service at once what's new and who's around (Refresh). */
let lookNow: () => void = () => undefined;
export const syncLookNow = (): void => lookNow();

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

/** What came of taking this computer's plays off the sync service. */
export type RemoveListensResult = "removed" | "old-service" | "not-linked" | "failed";
let removeNow: () => Promise<RemoveListensResult> = () => Promise.resolve("not-linked");
/**
 * This computer's plays taken off the sync service's shared history (Settings → Network & privacy): the
 * other devices keep what they already took in, this computer keeps its own history and doesn't send
 * those plays again (lib/listenShare.ts keepOwnPlaysHere).
 */
export const removeSharedListens = (): Promise<RemoveListensResult> => removeNow();

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

/** A song another device plays or sends: this library's, or one only a linked phone has, from there (lib/peerSongs.ts). */
function playableSong(wire: WireTrack): Track | undefined {
  return findSong(wire) ?? songFromPhone(wire);
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

/** The engine's "read the shared listening history now", while one runs (Replay opened). */
let listensNowHook: (() => Promise<void>) | null = null;
export function readListensNow(): Promise<void> {
  return listensNowHook?.() ?? Promise.resolve();
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
  let idleLook: ReturnType<typeof setTimeout> | null = null;
  let queueId = readStored(QUEUE_KEY);
  let adoptedAt = 0;
  let device = { id: "", name: "" };
  /** the device being followed and where it stood when last heard */
  let followed: (FollowedDevice & { playing: boolean; positionMs: number; heardAt: number; pausedSince: number }) | null = null;
  /** the last song of the followed device's queue known here, when only a stretch of it is (QueueDoc.total): an edit keeps what comes after it there */
  let followedTail: KeepAfter | null = null;
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
  /** a volume dragged here and not sent yet, and the device it's for */
  let volumeWanted: { to: string; level: number } | null = null;
  /** which server, and the address the service was last looked for at */
  let serverKey: string | null = null;
  let lookedAt: string | null = null;
  /** a service answered while this ran, for this server: known, whether or not it could be written down */
  let linkedHere = false;
  /** the service is this computer's own: it's there, nothing to look for */
  let homeService = false;
  const linked = (): boolean => homeService || linkedHere || isLinked(serverKey);
  /**
   * The entries of the queue in the player here, by id (lib/queueEntries.ts): this computer's own queue,
   * or its copy of the one it follows. Edits from elsewhere name them, and so do edits made here.
   */
  const book = createEntryBook();
  const keysOf = (queue: readonly Track[]): string[] => queue.map((t) => songKey(t.id));
  /** the list (session) queueId was named in: another one (this app started again) gets another name, so the devices following look again */
  let idSession = "";
  /** the list the followed device's queue is, as it said it; null when it says none (an older app): edits go the old way */
  let followedSession: string | null = null;
  /** the entries of the followed queue as last said to it: an edit made here goes out as what changed since */
  let sentIds: readonly string[] = [];

  function inSameSong(note: PlaybackNote): boolean {
    const { queue, index } = usePlayer.getState();
    return note.queueId === queueId && !!queue[index] && songKey(playableSong(note.track)?.id ?? "") === songKey(queue[index].id);
  }

  /** Later than the note this computer stands on, whatever the two devices' clocks say: it's what makes it the news. */
  const newNote = (): number => Math.max(Date.now(), activityAt + 1);

  const activity = (): void => {
    activityAt = newNote();
    ownActivityAt = Date.now();
    store(AT_KEY, String(activityAt));
    engine?.playbackChanged();
  };

  /**
   * The last song of this queue shown to the others when they saw only a stretch of it: an edit from an
   * older app, which says nothing about how much it knew, keeps what comes after it (Codex, 2026-11-21:
   * with 8f47c10 editing, 799 of 1,199 songs were left). A newer app says so itself (keepAfter).
   */
  let shownUpTo: KeepAfter | null = null;

  function readPlayback(): { note: PlaybackNote; queue: () => QueueDoc } | null {
    const { queue, index, position, playing, shuffle, repeat } = usePlayer.getState();
    const track = queue[index];
    // What another device plays is that device's to tell; and where the music just went, that it's paused here is no news that should overwrite its word.
    if (!track || !activityAt || followed || followNext) return null;
    // Its entries started over since the queue got its name (this app started again): a new name, so the
    // devices following look again and learn them.
    if (idSession !== book.session()) {
      const next = String(Date.now());
      queueId = next === queueId ? `${next}b` : next;
      store(QUEUE_KEY, queueId);
      idSession = book.session();
    }
    if (!queueId) queueId = String(activityAt);
    const id = queueId;
    store(AT_KEY, String(activityAt));
    return {
      note: { device, at: activityAt, playing, positionMs: position * 1000, track: toWireTrack(track), queueId: id, place: index, shuffle, repeat },
      queue: () => {
        const from = Math.max(0, index - QUEUE_NOTE_BEHIND);
        const { lineEnd, branches, unshuffled } = usePlayer.getState();
        book.follow(keysOf(queue), index);
        const end = Math.min(queue.length, index + QUEUE_NOTE_AHEAD);
        shownUpTo = end < queue.length && end > index + 1 ? { track: toWireTrack(queue[end - 1]), ahead: end - 1 - index } : null;
        return {
          id,
          from,
          tracks: queue.slice(from, index + QUEUE_NOTE_AHEAD).map(toWireTrack),
          total: queue.length,
          lineEnd: lineInList(lineEnd, from),
          branches: branches.map((b) => ({ ...b, ids: b.ids.slice(0, BRANCH_IDS_SENT) })),
          unshuffled: unshuffled ? listAround(unshuffled, track.id, QUEUE_NOTE_BEHIND, QUEUE_NOTE_AHEAD).map(toWireTrack) : undefined,
          entries: book.ids().slice(from, index + QUEUE_NOTE_AHEAD),
          session: book.session(),
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
    let current = playableSong(note.track);
    if (!current) {
      if (!handedOver) return true;
      // Sent here, and not here: the next song of its list that is, from its start.
      const after = note.place !== undefined && queue?.from !== undefined ? note.place - queue.from + 1 : 0;
      current = (queue?.tracks ?? []).slice(Math.max(0, after)).map(playableSong).find((t): t is Track => !!t);
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
    const songs = wires.map(playableSong);
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
    // Following a device that showed only a stretch of its queue: the last song of it known here anchors the edits made here.
    const end = (queue?.from ?? 0) + wires.length;
    const more = queue?.total !== undefined ? queue.total > end : said >= 0 && wires.length - said - 1 >= QUEUE_NOTE_AHEAD - 1;
    followedTail = followed && whole && more && note.place !== undefined && wires.length ? { track: wires[wires.length - 1], ahead: end - 1 - note.place } : null;
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
      unshuffled: whole && note.shuffle && queue?.unshuffled ? queue.unshuffled.map(playableSong).filter((t): t is Track => !!t) : null,
      lineEnd: whole ? songs.slice(0, queue?.lineEnd ?? 0).filter(Boolean).length : 0,
      branches: whole ? (queue?.branches ?? []) : [],
      position: going >= 0 ? state.position : note.positionMs / 1000,
      duration: going >= 0 ? state.duration : current.duration,
      playing: followed?.playing ?? false,
      error: null,
      seekNonce: usePlayer.getState().seekNonce + 1,
    });
    applying = false;
    // The entries of that queue as that device said them, for the songs of it here: edits made here name
    // them, and this computer goes on with them when the music comes here.
    const entries = Array.isArray(queue?.entries) && queue.entries.length === wires.length ? queue.entries : null;
    if (entries) {
      const mine = whole ? songs.flatMap((t, i) => (t ? [entries[i]] : [])) : [said >= 0 ? entries[said] : undefined];
      book.seed(keysOf(list), usePlayer.getState().index, mine, queue?.session);
    }
    followedSession = followed && entries && queue?.session ? queue.session : null;
    sentIds = book.ids();
    idSession = book.session();
    // A new song within a queue this one already follows needs no word; a device being followed shows by itself.
    if (newQueue && !followed) useUI.getState().toast(T("Picked up from {name}", { name: note.device.name }), "info");
    return true;
  }

  /** Whether the device followed takes edits by entry, and its queue's entries are known here. */
  function editable(): boolean {
    if (!followed || !followedSession) return false;
    const there = useHomeSync.getState().others.find((d) => d.id === followed?.id);
    return !!there?.presence.abilities?.includes("edits");
  }

  /**
   * Songs for the followed queue, with the ids they're to have there and here alike: the copy here and the
   * queue there know them by the same ids, so an edit made right after finds them there.
   */
  function named(tracks: Track[]): { entries?: string[] } {
    if (!editable() || !tracks.length || tracks.length > NAMED_UP_TO) return {};
    const entries = tracks.map(() => randomId());
    book.expect(tracks.map((t, i) => ({ key: songKey(t.id), id: entries[i] })));
    // The store puts them in here right after: that copy is what the device followed knows then.
    queueMicrotask(() => (sentIds = book.ids()));
    return { entries };
  }

  /** An edit for the device followed, by entry. Some of it found nothing to apply to there, or that list is gone: its queue again. */
  function sendEdit(ops: QueueOp[]): void {
    if (!followed || !followedSession) return;
    const to = followed.id;
    const { index } = usePlayer.getState();
    void engine?.sendEdit(to, { action: "editQueue", session: followedSession, ops, playing: book.ids()[index] }).then((result) => {
      if ((result === "partial" || result === "stale" || result === "unknown") && followed?.id === to) {
        queueId = "";
        void engine?.checkPlayback();
      }
    });
  }

  /** Songs for the device being followed: right in the command if they fit. */
  function sendSongs(tracks: Track[], command: DeviceCommand): void {
    if (!followed) return;
    const wire = tracks.slice(0, LONGEST_LIST).map(toWireTrack);
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
      // The list itself comes back with that device's next word, in the order it plays, with its entries.
      queueId = "";
      followedSession = null;
      followed = { ...followed, playing: true, positionMs: 0, heardAt: Date.now() };
      followClock(0, true);
      // The stretch of the list around the song asked for, so that song is in it, wherever it stands.
      const from = Math.max(0, start - LIST_BEHIND);
      void engine?.sendList(followed.id, tracks.slice(from, from + LONGEST_LIST).map(toWireTrack), undefined, { action: "playList", start: start - from, keepOrder, shuffle: usePlayer.getState().shuffle });
    },
    upcoming(tracks, all = false, line = false) {
      const { lineEnd, index, queue } = usePlayer.getState();
      // That device takes edits by entry: what changed here, applied where those entries stand there.
      if (editable()) {
        const ops: QueueOp[] = all ? [{ op: "clear" }] : line ? [{ op: "clearLine" }] : editsBetween(sentIds, book.ids(), (j) => (queue[j] ? toWireTrack(queue[j]) : undefined));
        sentIds = book.ids();
        if (!ops.length) return;
        const songs = ops.reduce((n, op) => n + (op.op === "insert" ? op.tracks.length : 0), 0);
        if (songs <= SONGS_IN_A_COMMAND) {
          sendEdit(ops);
          return;
        }
      }
      // An older app there, or more songs than a word holds: what comes after the playing song, as a whole.
      // Cleared: nothing comes after these there either, also what this computer never saw.
      if (all) followedTail = null;
      sendSongs(tracks, { action: "setUpcoming", line: Math.max(0, lineEnd - index - 1), ...(followedTail ? { keepAfter: followedTail } : {}) });
      // That queue runs on now: the song playing, these, then what came after the last song known here.
      if (followedTail) {
        const last = tracks[tracks.length - 1] ?? queue[index];
        followedTail = last ? { track: toWireTrack(last), ahead: tracks.length } : null;
      }
    },
    add: (tracks) => sendSongs(tracks, { action: "enqueue", next: true, ...named(tracks) }),
    jump: (track) => steerTo(usePlayer.getState().queue.indexOf(track)),
    branchOff: (tracks, name) => sendSongs(tracks, { action: "branchOff", name, ...named(tracks) }),
    cancelBranch: (name) => void (followed && engine?.sendCommand(followed.id, { action: "cancelBranch", name })),
    shuffle: (on) => void (followed && engine?.sendCommand(followed.id, { action: "shuffle", on })),
    repeat: (mode) => void (followed && engine?.sendCommand(followed.id, { action: "repeat", mode })),
    next() {
      const { queue, index } = usePlayer.getState();
      if (queue[index + 1]) steerTo(index + 1);
      // From the entry playing there, so a word that comes twice doesn't go on twice.
      else if (followed) void engine?.sendCommand(followed.id, { action: "next", ...(followedSession && book.ids()[index] ? { from: book.ids()[index] } : {}) });
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
      if (!followed) return;
      volumeHeldUntil = Date.now() + VOLUME_HELD_MS;
      volumeWanted = { to: followed.id, level };
      if (volumeTimer !== null) return;
      const send = (): void => {
        const wanted = volumeWanted;
        volumeWanted = null;
        if (wanted && followed?.id === wanted.to) void engine?.sendCommand(wanted.to, { action: "volume", level: wanted.level });
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

  /** A volume dragged for one device goes nowhere else: another device keeps its own until it's moved for that one. */
  function dropVolume(): void {
    if (volumeTimer !== null) window.clearTimeout(volumeTimer);
    volumeTimer = null;
    volumeWanted = null;
    volumeHeldUntil = 0;
  }

  /** This computer is by itself again, from the place the other device had reached. */
  function stopFollowing(play: boolean): void {
    if (!followed) return;
    dropVolume();
    followed = null;
    followedTail = null;
    followedSession = null;
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
    if (followed && followed.id !== other.id) dropVolume();
    if (!followed) {
      handOverToCast(steer);
      setSteering(steering);
      followTimer = window.setInterval(tickFollow, FOLLOW_TICK_MS);
      // Not playing any more: the others shouldn't go by what it said before.
      engine?.presenceChanged();
    }
    const song = playableSong(p.track) ?? ({ thumb: "", ...p.track } as Track);
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
        // The queue itself comes with the look below; its entries with it.
        usePlayer.setState({ queue: [song], index: 0, unshuffled: null, lineEnd: 0, branches: [] });
        followedSession = null;
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
    // Somebody plays, and this computer was in use a moment ago: looked at again when that moment is over, not at the next news.
    if (idleLook) clearTimeout(idleLook);
    idleLook = null;
    if (!target && playing && !idleHere) {
      idleLook = setTimeout(() => {
        idleLook = null;
        void engine?.devicesNow();
      }, Math.max(500, ownActivityAt + IDLE_BEFORE_TAKING_OVER_MS + 250 - Date.now()));
    }
    if (target) follow(target);
    else if (followed) stopFollowing(false);
  }

  /** This computer's queue, for edits made on another device (lib/queueEntries.ts). */
  const editPlayer: EditPlayer<Track> = {
    index: () => usePlayer.getState().index,
    lineEnd: () => lineEndOf(usePlayer.getState()),
    songs: (tracks) => tracks.map(playableSong),
    key: (t) => songKey(t.id),
    remove: (at) => usePlayer.getState().removeAt(at),
    move: (from, to) => usePlayer.getState().moveInQueue(from, to),
    insert: (songs, at) => usePlayer.getState().insertInQueue(songs, at),
    clear: () => usePlayer.getState().clearUpcoming(),
    clearLine: () => usePlayer.getState().clearLine(),
  };

  /** Songs sent with the ids they're to have here: the device that sent them knows them by those. */
  function nameSongs(wires: WireTrack[] | undefined, entries: unknown): void {
    if (!Array.isArray(entries) || !wires) return;
    book.expect(
      wires.flatMap((wire, i) => {
        const song = playableSong(wire);
        const id = entries[i];
        return song && typeof id === "string" ? [{ key: songKey(song.id), id }] : [];
      })
    );
  }

  /** An edit of this computer's queue made on another device, by entry: applied where those entries stand now. */
  function editHere(command: Extract<DeviceCommand, { action: "editQueue" }>): string {
    // Not this computer's music any more, or not that list: the device that edited looks again.
    if (followed || command.session !== book.session()) {
      // This app started again since it last said its queue: said now, with its entries.
      if (!followed && idSession !== book.session()) engine?.playbackChanged();
      return "stale";
    }
    return applyEdits(book, readOps(command.ops), editPlayer, typeof command.playing === "string" ? command.playing : undefined);
  }

  function runCommand(command: DeviceCommand): void | string {
    if (command.action === "syncLikes") {
      void syncFavorites().catch(() => undefined);
      return;
    }
    if (command.action === "editQueue") return editHere(command);
    const songsOf = (wire: WireTrack[] | undefined): Track[] => (wire ?? []).map(playableSong).filter((t): t is Track => !!t);
    if (command.action === "enqueue") {
      const songs = songsOf(command.tracks);
      nameSongs(command.tracks, command.entries);
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
        // The very entry asked for (a list can have a song twice), or the next one this computer has.
        const found = (command.tracks ?? []).map(playableSong);
        const songs = found.filter((t): t is Track => !!t);
        if (!songs.length) break;
        const start = Math.min(songs.length - 1, found.slice(0, Math.max(0, command.start)).filter((t) => !!t).length);
        if (command.shuffle !== undefined) usePlayer.setState({ shuffle: command.shuffle });
        // A list started from another device is a new list here, whatever songs it shares with the last one:
        // an edit meant for that one doesn't land on it (Codex, section 17).
        if (command.keepOrder) {
          book.foresee({ start: true });
          usePlayer.setState({ queue: songs, index: start, unshuffled: null, lineEnd: 0, branches: [], playing: true, position: 0, error: null });
        }
        else player.playQueue(songs, start);
        break;
      }
      case "setUpcoming": {
        const songs = songsOf(command.tracks);
        // From an app that sends the whole list: lined up with the queue as it stood when that app saw it,
        // what it changed and nothing else, so another device's edit meanwhile stays (lib/queueEntries.ts).
        const seenTo = command.keepAfter ?? shownUpTo;
        const last = seenTo ? playableSong(seenTo.track) : undefined;
        const reach = { ahead: seenTo?.ahead ?? QUEUE_NOTE_AHEAD - 1, ...(last ? { anchor: songKey(last.id) } : {}) };
        const edits = editsFromList(book, keysOf(songs), reach, (j) => (songs[j] ? toWireTrack(songs[j]) : undefined));
        if (edits) {
          applyEdits(book, edits, editPlayer);
          break;
        }
        // Edited where only a stretch of this queue was known: what comes after the last song known there stays.
        let keepFrom: number | undefined;
        // An older app doesn't say how much it knew: what it was shown, then.
        const keepAfter = command.keepAfter ?? shownUpTo;
        if (keepAfter) {
          const { queue, index } = usePlayer.getState();
          const anchor = playableSong(keepAfter.track);
          const key = (t: Track): string => songKey(t.id);
          keepFrom = keptFrom(queue, index, keepAfter, (t) => !!anchor && key(t) === key(anchor), songs, key);
        }
        player.replaceUpcoming(songs, command.line, keepFrom);
        break;
      }
      case "branchOff":
        nameSongs(command.tracks, command.entries);
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
        // From an entry this computer is past already: done before, not again.
        if (typeof command.from === "string" && book.ids()[player.index] !== command.from) break;
        player.next(true);
        break;
      case "previous":
        if (typeof command.from === "string" && book.ids()[player.index] !== command.from) break;
        player.prev();
        break;
      case "seek":
        player.seek(command.positionMs / 1000);
        break;
      case "jump": {
        // By the song, whichever copy of it that device has in its list.
        const id = (command.track && playableSong(command.track)?.id) ?? command.trackId;
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
    const otherService = (info.serverKey ?? null) !== serverKey;
    if (otherService) linkedHere = false;
    // This computer's own service switched on or off: another service altogether, with its own
    // revisions and devices, so the line to the one before goes and starts afresh.
    if (otherService && engine && (homeService || info.home)) {
      engine.stop();
      engine = null;
      useHomeSync.setState({ status: "off", service: null, serviceProblem: null, others: [] });
    }
    homeService = info.home === true;
    serverKey = info.serverKey ?? null;
    useHomeSync.setState({ address: info.address, customAddress: info.customAddress, needsUser: info.needsUser, linked: linked(), home: homeService });
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
      useListenCursors.persist.hasHydrated() &&
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
    const libraryHosts = libraryDocHosts();
    const listenHost = computerListenHost(() => serverKey, () => device.name);
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
      likesBase() {
        try {
          const kept = JSON.parse(readStored(LIKES_BASE_KEY) || "null") as { server?: unknown; rev?: unknown; ids?: unknown } | null;
          if (!kept || kept.server !== serverKey || typeof kept.rev !== "number" || !Array.isArray(kept.ids)) return null;
          return { rev: kept.rev, ids: kept.ids.filter((id): id is string => typeof id === "string") };
        } catch {
          return null;
        }
      },
      keepLikesBase: (base) => store(LIKES_BASE_KEY, JSON.stringify({ server: serverKey, ...base })),
      // Put together with another computer's order: the songs liked here go by it. One liked here and not in
      // it (taken out there, maybe unliked) stays, after the rest, till the favorites say otherwise.
      adoptLikes(tracks) {
        const { liked } = useLibrary.getState();
        const place = new Map<string, number>();
        tracks.forEach((t, i) => {
          if (!place.has(songKey(t.id))) place.set(songKey(t.id), i);
        });
        const inOrder = liked.filter((t) => place.has(songKey(t.id))).sort((a, b) => (place.get(songKey(a.id)) as number) - (place.get(songKey(b.id)) as number));
        const next = [...inOrder, ...liked.filter((t) => !place.has(songKey(t.id)))];
        if (next.every((t, i) => t === liked[i])) return;
        applying = true;
        useLibrary.setState({ liked: next });
        applying = false;
      },
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
      // How the library is organised, and the listening history all devices share (lib/listenShare.ts):
      // each only while it's shared (Settings → Network & privacy), the history only while plays are kept
      // here at all, since the other devices' come into it. The engine asks for them each time.
      get library() {
        return useSettings.getState().shareLibrary ? libraryHosts : undefined;
      },
      get listens() {
        return sharesListens(useSettings.getState()) ? listenHost : undefined;
      },
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
  lookNow = () => {
    engine?.lookNow(0);
    void engine?.checkPlayback();
  };
  searchNow = () => engine?.searchAgain();
  removeNow = async () => {
    if (!serverKey || !linked() || !device.id) return "not-linked";
    try {
      const res = await bridge.homeSyncRequest("DELETE", `/v1/listens?device=${encodeURIComponent(device.id)}`, undefined, 20_000);
      // A service from before this can't take anything out.
      if (res.status === 404 || res.status === 405) return "old-service";
      if (res.status !== 200) return "failed";
      await keepOwnPlaysHere(serverKey);
      return "removed";
    } catch {
      return "failed";
    }
  };
  // Away from home and back: the address moved, and the service is looked for at the new one.
  const offReach = bridge.onJellyfinReach?.(() => refreshQuietly()) ?? (() => undefined);
  // This computer's own service for phones at home started or stopped.
  const offHomeLink = bridge.onHomeLinkChanged?.(() => refreshQuietly()) ?? (() => undefined);

  // What the stores read from disk at the start isn't anything somebody just did.
  const offLibrary = useLibrary.subscribe((s, prev) => {
    if (!applying && s.liked !== prev.liked && useLibrary.persist.hasHydrated()) engine?.likesChanged();
    if (!applying && useLibrary.persist.hasHydrated() && (s.playlists !== prev.playlists || s.folders !== prev.folders)) engine?.playlistsChanged();
  });
  book.follow(keysOf(usePlayer.getState().queue), usePlayer.getState().index);
  // An edit made here by place: the ids follow it exactly (two copies side by side stay told apart).
  setEditAhead((change) => book.foresee(change));
  const offEntries = usePlayer.subscribe((s, prev) => {
    if (s.queue !== prev.queue || s.index !== prev.index) book.follow(keysOf(s.queue), s.index);
    // A change the sync made itself (what the device followed said) is no edit made here.
    if (applying) sentIds = book.ids();
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
        idSession = book.session();
      }
      activity();
    } else if (s.playing !== prev.playing || s.index !== prev.index || s.seekNonce !== prev.seekNonce) {
      activity();
    } else if (s.playing && s.position !== prev.position) {
      activityAt = newNote();
      ownActivityAt = Date.now();
      engine?.playbackChanged(true);
      // The song over from its start (repeat one): the devices showing it hear of it now, not at the next round.
      if (s.position < prev.position - 2) engine?.presenceChanged();
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
    // Shared again (or not any more): a fresh start says everything once, as at the app's start.
    if (s.shareLibrary !== prev.shareLibrary || s.shareListens !== prev.shareListens || s.recordListening !== prev.recordListening) {
      engine?.stop();
      engine = null;
      refreshQuietly();
    }
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
    useListenCursors.persist.onFinishHydration(refreshQuietly),
    // A song over: a play may have been counted, and it goes out to the shared history in a moment.
    usePlayer.subscribe((s, prev) => {
      if (s.queue[s.index]?.id !== prev.queue[prev.index]?.id || s.playing !== prev.playing) engine?.listensChanged();
    }),
  ];
  listensNowHook = () => engine?.listensNow() ?? Promise.resolve();
  // Looked at again, or the network back (a computer woken up): a wait that died meanwhile is dropped at once.
  const onFocus = (): void => {
    engine?.lookNow(LISTENING_FINE_MS);
    void engine?.checkPlayback();
  };
  const onLeave = (): void => void engine?.flushPlayback();
  window.addEventListener("bytune:remote-library-updated", refreshQuietly);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onFocus);
  window.addEventListener("pagehide", onLeave);
  refreshQuietly();

  return () => {
    closed = true;
    refreshNow = () => undefined;
    lookNow = () => undefined;
    searchNow = () => undefined;
    offReach();
    offHomeLink();
    setSteering(null);
    engine?.stop();
    if (followTimer !== null) window.clearInterval(followTimer);
    offMuted();
    offLibrary();
    offEntries();
    setEditAhead(null);
    offPlayer();
    offCatalog();
    offSettings();
    for (const off of offHydrations) off();
    listensNowHook = null;
    window.removeEventListener("bytune:remote-library-updated", refreshQuietly);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("online", onFocus);
    if (idleLook) clearTimeout(idleLook);
    idleLook = null;
    window.removeEventListener("pagehide", onLeave);
  };
}
