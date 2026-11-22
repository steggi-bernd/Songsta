/**
 * The conversation with the sync service, one copy for the desktop and the
 * phone; each brings how it reaches the service and how to read and change its
 * own state.
 *
 *  - playlists: fetched, merged with what's here, sent back if that differs.
 *    The service refuses a write built on an old revision; then it starts over.
 *  - playback: a device says where it stands when something happens and every
 *    half minute while it plays. A device that isn't playing takes over a
 *    newer note from another one, paused, so it picks up where that stopped.
 *  - changes: a long poll, so other devices hear within moments.
 *  - devices: each device says what it's doing and hears what the others do, so
 *    one shows what plays on another and can steer it; commands go through the
 *    service too, and one that isn't picked up within a minute is forgotten. A
 *    long list goes ahead as the queue document, and its command says to read it.
 *  - muted songs: one list for all devices; the newer list wins.
 *  - finding it: until a service ever answered for this server (most people
 *    have none), it's looked for once a start and when asked, and nothing else
 *    is sent; once one has, it's kept in reach, retried within a minute.
 *  - how the library is organised (lib/librarySync.ts): its order, the groups,
 *    the album edits and their pictures, fetched and merged like the playlists,
 *    each on its own. A service from before them doesn't list them: then they
 *    stay on each device as before.
 *  - the listening history (lib/listenSync.ts): each device sends the plays it counted and takes the
 *    others' in, so Replay counts every play on every device. A service from before it has none:
 *    then each device counts its own.
 */
import { LIBRARY_DOC_KINDS, LIBRARY_DOCS, sameLibraryDoc, type LibraryDocName } from "./librarySync";
import { LISTEN_BATCH, LISTEN_PAGE, readListenPage, type ListenDevice, type SharedListen, type WireListen } from "./listenSync";
import { mergePlaylistDocs, sameDoc, sameLikes, toPlaylistDoc, type PlaylistDoc, type WireTrack } from "./playlistSync";
import { mergeOrder, type QueueOp } from "./queueEntries";
import type { QueueBranch } from "./queueSections";
import { readServiceInfo, type SyncServiceInfo } from "./syncService";

export interface SyncReply {
  status: number;
  body: any;
}

/** A request to the service; rejects when it can't be reached. */
export type SyncRequest = (method: "GET" | "PUT" | "POST", path: string, body?: unknown, timeoutMs?: number) => Promise<SyncReply>;

export interface PlaybackNote {
  device: { id: string; name: string };
  /** when this device last did something worth continuing from (ms) */
  at: number;
  playing: boolean;
  positionMs: number;
  track: WireTrack;
  queueId: string;
  /** the song's place in that device's queue, for when a song is in it twice; the queue document says where its list starts */
  place?: number;
  context?: string;
  /** what the player is doing with the sound, for a look when something sounds off */
  audio?: string;
  /** how it goes on from here: the device continuing goes on the same way */
  shuffle?: boolean;
  repeat?: "off" | "all" | "one";
}

export interface QueueDoc {
  id: string;
  context?: string;
  tracks: WireTrack[];
  /** the place in the device's queue this list starts from */
  from?: number;
  /** where the songs asked for by hand end, in this list */
  lineEnd?: number;
  branches?: QueueBranch[];
  /** what the list is called that comes after the branch playing now */
  home?: string;
  /** shuffled: the list's own order around the playing song, to go back to */
  unshuffled?: WireTrack[];
  /** how long the device's whole queue is: `tracks` may be only a stretch of it */
  total?: number;
  /** the entries of `tracks`, one id for each (lib/queueEntries.ts): edits from elsewhere name them */
  entries?: string[];
  /** the list those entries belong to: a new list, new ids */
  session?: string;
}

/** What a device says about itself to the others. */
export interface DevicePresence {
  name: string;
  kind: "phone" | "computer";
  playing: boolean;
  positionMs: number;
  durationMs: number;
  track: WireTrack | null;
  queueId?: string;
  context?: string;
  shuffle?: boolean;
  repeat?: "off" | "all" | "one";
  /** 0 to 1; without it, it can't be set from elsewhere */
  volume?: number;
  /** a second stream, by request: it goes its own way, nobody follows it or stops it by starting something */
  separate?: boolean;
  /** what this device's app can take (DEVICE_ABILITIES); an older app says nothing, and gets the old ways */
  abilities?: string[];
}

/**
 * What an app from 2026-11-21 on can take, said with its presence: "lists" (a command's songs in the
 * service's list store), "kept" (commands taken with keep=1 and said done, with what came of them),
 * "edits" (its queue edited by entry: editQueue, and the ids of songs it's sent) and "handover" (a
 * hand-over with the state it was made in, from the list store).
 */
export const DEVICE_ABILITIES = ["lists", "kept", "edits", "handover"];

/** Another device as this one knows it. */
export interface RemoteDevice {
  id: string;
  /** since it last said something, by the service's clock */
  ageMs: number;
  presence: DevicePresence;
}

/** Songs with a command: right in it, or with `listId` in the queue document, for lists too long for a command. */
interface WithSongs {
  tracks?: WireTrack[];
  listId?: string;
  /** its songs went to a list of their own (the service's list store), not the queue document */
  listStore?: boolean;
}

export type DeviceCommand =
  | { action: "play" | "pause" | "syncLikes" }
  /**
   * on to the next or back to the song before; `from`: the entry it goes from (lib/queueEntries.ts), so
   * done again it doesn't go on twice: a device that's past that entry already stays where it is
   */
  | { action: "next" | "previous"; from?: string }
  /** the branch into this list taken back */
  | { action: "cancelBranch"; name?: string }
  | { action: "seek"; positionMs: number }
  /** a song of its queue: `track` says which, as devices can know a song by different copies */
  | { action: "jump"; trackId: string; by?: number; track?: WireTrack }
  /** songs for its queue, behind the playing one and what was asked for before; `entries`: the ids they're to have there */
  | ({ action: "enqueue"; next?: boolean; entries?: string[] } & WithSongs)
  /**
   * go on from the position and queue documents, playing; `from`: the device that handed over;
   * `snapshot`: where that device stood when it handed over, in the list store (a note and its queue)
   */
  | { action: "takeOver"; from?: string; snapshot?: string }
  /** another device started the music: pause, and show that one */
  | { action: "yield"; to: string }
  | { action: "shuffle"; on: boolean }
  | { action: "repeat"; mode: "off" | "all" | "one" }
  | { action: "volume"; level: number }
  /** a new list, from this song of it; `keepOrder` when it's in its final order already */
  | ({ action: "playList"; start: number; context?: string; shuffle?: boolean; keepOrder?: boolean } & WithSongs)
  /** what comes after the playing song, edited elsewhere; `line` of them were asked for by hand; `keepAfter`: up to which song */
  | ({ action: "setUpcoming"; line?: number; keepAfter?: KeepAfter } & WithSongs)
  /** the first of these next and the rest after it, what was coming behind them; `entries`: the ids they're to have there */
  | ({ action: "branchOff"; name: string; entries?: string[] } & WithSongs)
  /**
   * its queue edited elsewhere, by entry (lib/queueEntries.ts): applied where those entries stand by
   * then, while it's still that list (`session`); `playing`: the entry playing where it was edited
   */
  | { action: "editQueue"; session: string; ops: QueueOp[]; playing?: string };

/**
 * Sent with an edit by a device that knows only a stretch of another's queue (QueueDoc.total says
 * there's more): the songs sent replace what comes up to and including this one, `ahead` places after
 * the song playing when it was sent, and what comes after it stays. Without it, an edit made where only
 * 800 of 1,200 songs were known cut the queue there to 800 (Codex's review, 2026-11-20).
 */
export interface KeepAfter {
  track: WireTrack;
  ahead: number;
}

/**
 * Where the song an edit was anchored to (KeepAfter) stands in the queue now: at its place, else the
 * nearest copy around it (songs played on since, or added in front), else -1.
 */
export function anchorPlace<T>(queue: readonly T[], index: number, ahead: number, isIt: (t: T) => boolean, reach = ANCHOR_REACH): number {
  const at = index + Math.max(1, ahead);
  if (at < queue.length && isIt(queue[at])) return at;
  for (let d = 1; d <= reach; d++) {
    if (at - d > index && at - d < queue.length && isIt(queue[at - d])) return at - d;
    if (at + d < queue.length && isIt(queue[at + d])) return at + d;
  }
  return -1;
}

/** How far around its place the song an edit was anchored to is looked for. */
export const ANCHOR_REACH = 64;

/**
 * From where a queue stays as it is after an edit anchored to a song (KeepAfter): right after that
 * song. When it isn't there any more (another device took it out meanwhile), what came after it stands
 * at its place now and stays, except songs that are among the last ones just sent (Codex's review of
 * these fixes: the song after a removed anchor went too).
 */
export function keptFrom<T>(queue: readonly T[], index: number, keep: KeepAfter, isAnchor: (t: T) => boolean, sent: readonly T[], keyOf: (t: T) => string): number {
  const at = anchorPlace(queue, index, keep.ahead, isAnchor);
  if (at >= 0) return at + 1;
  const justSent = new Set(sent.slice(-ANCHOR_REACH).map(keyOf));
  let from = Math.min(queue.length, index + Math.max(1, keep.ahead));
  while (from < queue.length && justSent.has(keyOf(queue[from]))) from += 1;
  return from;
}

export interface MutedDoc {
  /** when the list last changed (ms) */
  at: number;
  tracks: WireTrack[];
}

export type SyncStatus = "off" | "connecting" | "connected" | "unreachable" | "rejected";

/** One of the library's documents as this device keeps it (lib/librarySync.ts says what's in each). */
export interface LibraryDocHost {
  /** As it is here; null while that can't be said yet (a picture still being read): it goes another time. */
  read(): object | null;
  /** The merged document, when it differs from what's here. */
  apply(doc: object): void | Promise<void>;
  /** The revision it was last merged at, kept across starts, and whether anything changed here since: unchanged on both sides, nothing to fetch. */
  lastMerge?(): { rev: number; changed: boolean } | null;
  /** Merged at this revision: what was read for it is there now. */
  merged?(rev: number): void;
}

/** One device's side of the shared listening history (lib/listenSync.ts). */
export interface ListenHost {
  /** who this device is in the history */
  device(): ListenDevice;
  /** This device's plays the service doesn't have yet, oldest first, at most `max`. */
  pending(max: number): Promise<WireListen[]>;
  /** The service has them, up to and with this one. */
  sent(last: WireListen): void | Promise<void>;
  /** How far this device has read the shared history (the service's count), kept across starts. */
  readUpTo(): number;
  /** The other devices' plays from there on, and how far that reads. With startOver (another service, or one that started over): read it from the start and send this device's plays again. */
  take(listens: SharedListen[], devices: Record<string, ListenDevice>, upTo: number, startOver?: boolean): void | Promise<void>;
  /** The service keeps no shared history (one from before 1.8): each device's Replay stays its own. */
  missing?(): void;
  /**
   * Which version (generation) of the service's history this device has read all of, and which it's
   * reading afresh right now; null for none. Without these, a device goes by the history's length alone.
   */
  generation?(): { read: string | null; afresh: string | null };
  /**
   * The service holds another version of the history (a device's plays taken out, a backup put back,
   * another service or account): read it from the start; what comes in from now on is noted as in it.
   * This device's plays go again, apart from the ones taken off on asking.
   */
  readAfresh?(generation: string): void | Promise<void>;
  /** All of that version read: the others' plays that aren't in it are gone from it, and go here too. */
  readThrough?(generation: string): void | Promise<void>;
}

export interface SyncHost {
  deviceId: string;
  request: SyncRequest;
  readPlaylists(): PlaylistDoc;
  /** The merged playlists, when they differ from what's here. */
  applyPlaylists(doc: PlaylistDoc): void;
  /** Where this device stands; null with nothing in the queue. */
  readPlayback(): { note: PlaybackNote; queue: () => QueueDoc } | null;
  /** Whether to take over another device's note now: not while playing, not when this one is newer. */
  wantsPlayback(note: PlaybackNote): boolean;
  /**
   * Take it over, paused. `queue` is null when the note's queue is no longer there. `handedOver`: it
   * was sent here, so a song this device doesn't have gives way to the next one it does; false when
   * there's none.
   */
  adoptPlayback(note: PlaybackNote, queue: QueueDoc | null, handedOver?: boolean): boolean | void;
  /** Liked Songs as arranged here, on the device where they are arranged. */
  readLikes?(): WireTrack[];
  /** The order arranged on another device, on a device that follows it. */
  applyLikes?(tracks: WireTrack[]): void;
  /**
   * On a device that arranges Liked Songs too (a computer): the order put together with what another one
   * wrote meanwhile, for the songs liked here (plan section 5: two computers' changes both kept).
   */
  adoptLikes?(tracks: WireTrack[]): void;
  /** The order of Liked Songs last agreed on with this service, and its revision; null for none yet. */
  likesBase?(): { rev: number; ids: string[] } | null;
  keepLikesBase?(base: { rev: number; ids: string[] }): void;
  /** What this device says about itself; without it, it isn't listed among the devices. */
  readPresence?(): DevicePresence | null;
  /** The other devices, whenever one of them says something. */
  applyDevices?(devices: RemoteDevice[]): void;
  /** Another device asks this one to do something; what came of it, when that's more than "done" (an edit that found its list gone: "stale"). */
  onCommand?(command: DeviceCommand): void | string;
  readMuted?(): MutedDoc;
  /** A newer list of muted songs from another device. */
  applyMuted?(doc: MutedDoc): void;
  onStatus?(status: SyncStatus): void;
  /** A round of listening is over: the moment to stop, if there's no reason to go on. */
  onListening?(): void;
  /** How the library is organised, document by document; one this device doesn't keep isn't synced. */
  library?: Partial<Record<LibraryDocName, LibraryDocHost>>;
  /** The shared listening history; a device without it counts only its own plays. */
  listens?: ListenHost;
  /**
   * What the service says about itself (lib/syncService.ts), once per start and only once it has
   * answered: a device that isn't linked to one asks nothing. Null when it says nothing usable.
   */
  onService?(info: SyncServiceInfo | null): void;
  /**
   * Whether a sync service ever answered this device for this server. Until one has, it's looked
   * for once a start, and again only when asked (retryNow: a new address, "Search again"), not
   * every minute; nothing else is sent meanwhile. Without it, the service is looked for as always.
   */
  linked?(): boolean;
  /** A service answered this device for this server: from now on it's kept in reach as always. */
  onLinked?(): void;
}

const LONG_POLL_SEC = 25;
const LONG_POLL_TIMEOUT_MS = (LONG_POLL_SEC + 10) * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const FIRST_RETRY_MS = 5000;
const LAST_RETRY_MS = 60_000;
const REJECTED_RETRY_MS = 5 * 60_000;
const PLAYLISTS_AFTER_CHANGE_MS = 1500;
const PLAYBACK_AFTER_CHANGE_MS = 800;
const PLAYBACK_WHILE_PLAYING_MS = 30_000;
const LIKES_AFTER_CHANGE_MS = 3000;
const MUTED_AFTER_CHANGE_MS = 800;
const PRESENCE_AFTER_CHANGE_MS = 300;
const LIBRARY_AFTER_CHANGE_MS = 1500;
/** A play counted here goes out after this long, together with any that follow. */
const LISTENS_AFTER_CHANGE_MS = 10_000;
/** A device that says nothing for longer than this and a bit counts as gone: see DEVICE_ONLINE_MS. */
/** No word from the service for this long: nobody counts as around, and a device being followed can't be steered anyway. */
const NOBODY_HEARD_AFTER_MS = 30_000;
const PRESENCE_EVERY_MS = 40_000;
const DEVICES_LOOK_MS = 45_000;
/** Words for this device remembered as handled, so one coming again after a lost answer isn't run twice. */
const HANDLED_KEPT = 200;
/** How long a hand-over waits to hear what the other device made of it, and how often it asks. */
const HAND_OVER_ANSWER_MS = 4000;
/**
 * A command that comes out the same however often it's done: a step from a named entry, a state to reach.
 * One started before this device started anew runs again, rather than being lost if it never ran; any
 * other has an unknown outcome if its result was lost in a restart.
 */
function repeatable(command: DeviceCommand): boolean {
  if (command.action === "next" || command.action === "previous") return typeof command.from === "string";
  return command.action === "play" || command.action === "pause" || command.action === "seek" || command.action === "volume" || command.action === "shuffle" || command.action === "repeat";
}

/** How long an edit of another device's queue waits to hear whether all of it applied there. */
const EDIT_ANSWER_MS = 4000;
const RESULT_LOOK_MS = 250;

/** A command taken from the inbox whose step the service let down: tried this often, a growing moment apart. */
const COMMAND_TRIES = 3;
const COMMAND_RETRY_MS = 1000;
const MERGE_ATTEMPTS = 4;

/** Heard of within this long, a device is around. */
export const DEVICE_ONLINE_MS = 100_000;

function readNote(doc: unknown): PlaybackNote | null {
  const n = doc as PlaybackNote | null;
  return n && typeof n === "object" && typeof n.device?.id === "string" && typeof n.at === "number" && typeof n.track?.id === "string" ? n : null;
}

/**
 * Answers that can come back in any order (two questions under way at once): one about an older state
 * of the service than one already used doesn't set the screen back (Codex's review, 2026-11-20). The
 * service's own count for that state decides; a service without one, the order the questions went out in.
 */
export function newestAnswers() {
  let asked = 0;
  /** questions up to this one were asked before a start, maybe of another service: their answers don't count */
  let floor = 0;
  let usedAsk = 0;
  let usedRev = -1;
  return {
    ask: (): number => ++asked,
    /** Whether the answer to question `mine`, about the service's state `rev` (when it says), is the newest yet; it counts from now on. */
    take(mine: number, rev: unknown): boolean {
      const count = typeof rev === "number" ? rev : null;
      if (mine <= floor) return false;
      const older = count !== null && usedRev >= 0 ? count < usedRev || (count === usedRev && mine < usedAsk) : mine < usedAsk;
      if (older) return false;
      usedAsk = Math.max(usedAsk, mine);
      usedRev = count ?? -1;
      return true;
    },
    /** The service's count is lower than the one used (restored from a backup, or another one): compared afresh from now on. */
    seen(rev: unknown): void {
      if (typeof rev === "number" && rev < usedRev) usedRev = -1;
    },
    /** Another start, maybe of another service: what was asked before doesn't count. */
    afresh(): void {
      floor = usedAsk = asked;
      usedRev = -1;
    },
  };
}

export function createSyncEngine(host: SyncHost) {
  /** on at all: what happens here goes out */
  let enabled = false;
  /** listening for what happens elsewhere; not while a phone app is in the background */
  let running = false;
  /** bumped at every stop, so a poll still under way knows it is over */
  let session = 0;
  let status: SyncStatus = "off";
  let seq = -1;
  const known = { playlists: -1, position: -1, likes: -1, muted: -1, devices: -1 };
  /** who's around, and where the music stands: an older answer arriving late changes nothing */
  const devicesAnswers = newestAnswers();
  const playbackAnswers = newestAnswers();
  /** the newest word on where the music stands taken from another device, and whose it was: a hand-over that arrives later than it starts nothing */
  let newestElsewhere: { rev: number; device: string; note: PlaybackNote } | null = null;
  /** What the service can do (its /health), once it's been asked: until then, and for an older one, the old ways. */
  let features = new Set<string>();
  let featuresAsked: Promise<SyncServiceInfo | null> | null = null;
  /** Asked when a word has to know it (once), not only when the service was found: a device sending before its first round knows too. */
  function knowFeatures(): Promise<SyncServiceInfo | null> {
    if (featuresAsked) return featuresAsked;
    const request = call("GET", "/health", undefined, REQUEST_TIMEOUT_MS)
      .then((got) => got.status === 200 ? readServiceInfo(got.body) : null, () => null)
      .then((info) => {
        if (featuresAsked === request) {
          if (info) features = new Set(info.features ?? []);
          else featuresAsked = null;
        }
        return info;
      });
    featuresAsked = request;
    return request;
  }
  /** Words for this device handled lately, by id, and what came of each: taken again after a lost answer, they don't run twice. */
  const handled = new Map<string, string>();
  /** What the other devices' apps can take, from their presence. */
  const abilitiesOf = new Map<string, string[]>();
  const canTake = (deviceId: string, ability: string): boolean => abilitiesOf.get(deviceId)?.includes(ability) ?? false;
  function rememberHandled(id: string, result: string): void {
    handled.set(id, result);
    while (handled.size > HANDLED_KEPT) handled.delete(handled.keys().next().value as string);
  }

  /**
   * What this device tells another goes out in the order it was said, each word once the one before is
   * through: a list (its document, then its word) can't be overtaken by a quick word after it, so a play
   * chosen first never lands after a later one (Codex, 2026-11-21).
   */
  let telling: Promise<unknown> = Promise.resolve();
  let ahead = 0;
  function inTurn<T>(task: () => Promise<T>): Promise<T> {
    const start = (): Promise<T> => {
      try {
        return task();
      } catch (err) {
        return Promise.reject(err);
      }
    };
    // Nothing ahead of it: at once, as before; else behind the last word.
    const run = ahead === 0 ? start() : telling.then(start, start);
    ahead += 1;
    const done = (): void => {
      ahead -= 1;
    };
    telling = run.then(done, done);
    return run;
  }

  /**
   * A word for another device, with an id. On a service that knows ids it's sent again after no answer or
   * a 5xx: there it's taken once however often it comes (Codex, 2026-11-21: a lost answer said "failed"
   * though the word had arrived). On an older one it goes once, as before.
   */
  async function postCommand(deviceId: string, command: DeviceCommand): Promise<{ ok: boolean; id: string }> {
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    await knowFeatures();
    const again = features.has("commands-kept");
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await call("POST", `/v1/devices/${encodeURIComponent(deviceId)}/commands`, { command, id }, REQUEST_TIMEOUT_MS);
        if (res.status === 200) return { ok: true, id };
        if (!again || res.status < 500 || attempt >= COMMAND_TRIES) return { ok: false, id };
      } catch {
        if (!again || attempt >= COMMAND_TRIES) return { ok: false, id };
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * COMMAND_RETRY_MS));
    }
  }

  /** What the other device made of a word, where the service can say: null when it can't, or doesn't know in time. */
  async function resultOf(deviceId: string, id: string, withinMs: number): Promise<string | null> {
    const until = Date.now() + withinMs;
    while (Date.now() < until) {
      try {
        const got = await call("GET", `/v1/devices/${encodeURIComponent(deviceId)}/commands/${encodeURIComponent(id)}`, undefined, REQUEST_TIMEOUT_MS);
        if (got.status === 200 && got.body?.state === "done") return typeof got.body.result === "string" ? got.body.result : "done";
        if (got.status !== 200) return null;
      } catch {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, RESULT_LOOK_MS));
    }
    return null;
  }

  function noteTaken(rev: unknown, note: PlaybackNote | null): void {
    if (typeof rev !== "number" || !note || note.device.id === host.deviceId) return;
    if (!newestElsewhere || rev >= newestElsewhere.rev) newestElsewhere = { rev, device: note.device.id, note };
  }
  let sentQueueId: string | null = null;
  /** the note last sent or taken over: nothing newer, nothing to say */
  let sentAt = 0;
  let playlistsBusy = false;
  let playlistsAgain = false;
  let playlistsTimer: ReturnType<typeof setTimeout> | null = null;
  let playbackTimer: ReturnType<typeof setTimeout> | null = null;
  let likesTimer: ReturnType<typeof setTimeout> | null = null;
  let mutedTimer: ReturnType<typeof setTimeout> | null = null;
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPresenceAt = 0;
  let lastDevicesAt = 0;
  /** an older service has no such thing */
  let hasDevices = false;
  let lastPlaybackAt = 0;
  let wakeSleep: (() => void) | null = null;
  let lastHeardAt = 0;
  let nobodyTimer: ReturnType<typeof setTimeout> | null = null;
  /** told that nobody is around: what the service says next is news, whatever its revision */
  let toldNobody = false;
  /** the library's documents: the revision merged last, one merge at a time each, a change here waiting a moment */
  const libraryKnown: Partial<Record<LibraryDocName, number>> = {};
  const libraryBusy = new Set<LibraryDocName>();
  const libraryAgain = new Set<LibraryDocName>();
  const libraryTimers = new Map<LibraryDocName, ReturnType<typeof setTimeout>>();
  /** not on this service (one from before them): asked again only at the next start */
  const libraryMissing = new Set<LibraryDocName>();
  /** the service's count of listens, as last read; -1 before the first look */
  /**
   * A word on where the music stands that came with another list in the queue document: looked at again
   * when the queue document changes (its revision then, and the word's). Null while nothing waits.
   */
  let queueAwaited: { queueRev: number; positionRev: number } | null = null;
  let listensKnown = -1;
  /** the history's generation as last read, or the summary said it */
  let listensGenerationKnown: string | null = null;
  let listensMissing = false;
  let listensBusy = false;
  let listensAgain = false;
  let listensTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (next: SyncStatus): void => {
    if (next === status) return;
    status = next;
    host.onStatus?.(next);
  };

  /** A reply that isn't what it should be counts like no reply. */
  function refused(reply: SyncReply): Error {
    return Object.assign(new Error(`The sync service answered ${reply.status}`), { status: reply.status });
  }

  /** No service ever answered here, and none does now: nothing is sent but the look for one. */
  const unlinked = (): boolean => status !== "connected" && host.linked?.() === false;

  /** Every request but the look for the service: held back while none was ever found. */
  const call: SyncRequest = (method, path, body, timeoutMs) =>
    unlinked() ? Promise.reject(new Error("No sync service found here yet")) : host.request(method, path, body, timeoutMs);

  async function syncPlaylists(): Promise<void> {
    if (playlistsBusy) {
      playlistsAgain = true;
      return;
    }
    playlistsBusy = true;
    try {
      for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
        const got = await call("GET", "/v1/docs/playlists", undefined, REQUEST_TIMEOUT_MS);
        if (got.status !== 200) throw refused(got);
        const remote = toPlaylistDoc(got.body.doc);
        // No await from reading to applying: an edit can't slip in between.
        const here = host.readPlaylists();
        const merged = mergePlaylistDocs(here, remote);
        if (!sameDoc(merged, here)) host.applyPlaylists(merged);
        known.playlists = got.body.rev;
        const nothingYet = !got.body.doc && !merged.playlists.length && !merged.folders.length;
        if (nothingYet || (got.body.doc && sameDoc(merged, remote))) return;
        const put = await call("PUT", "/v1/docs/playlists", { rev: got.body.rev, doc: merged }, REQUEST_TIMEOUT_MS);
        if (put.status === 200) {
          known.playlists = put.body.rev;
          return;
        }
        if (put.status !== 409) throw refused(put);
      }
    } finally {
      playlistsBusy = false;
      if (playlistsAgain && running) {
        playlistsAgain = false;
        playlistsSoon();
      }
    }
  }

  function playlistsSoon(): void {
    if (playlistsTimer) clearTimeout(playlistsTimer);
    playlistsTimer = setTimeout(() => {
      playlistsTimer = null;
      if (running) void syncPlaylists().catch(() => undefined);
    }, PLAYLISTS_AFTER_CHANGE_MS);
  }

  /** One of the library's documents, the way the playlists go: fetched, merged with what's here, sent back if that differs. */
  async function syncLibraryDoc(name: LibraryDocName): Promise<void> {
    const side = host.library?.[name];
    if (!side || libraryMissing.has(name)) return;
    if (libraryBusy.has(name)) {
      libraryAgain.add(name);
      return;
    }
    libraryBusy.add(name);
    const kind = LIBRARY_DOC_KINDS[name];
    try {
      for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
        const got = await call("GET", `/v1/docs/${name}`, undefined, REQUEST_TIMEOUT_MS);
        // A service from before this document: it stays on this device.
        if (got.status === 404) {
          libraryMissing.add(name);
          return;
        }
        if (got.status !== 200) throw refused(got);
        const remote = kind.read(got.body.doc);
        let merged: object;
        try {
          // Not to be said yet: the next change here, or there, brings it.
          const here = side.read();
          if (!here) return;
          merged = kind.merge(here, remote);
          if (!sameLibraryDoc(merged, here)) await side.apply(merged);
        } catch {
          // Something here couldn't take it: tried again next round, the other documents go on.
          return;
        }
        libraryKnown[name] = got.body.rev;
        if (sameLibraryDoc(merged, remote)) {
          side.merged?.(got.body.rev);
          return;
        }
        const put = await call("PUT", `/v1/docs/${name}`, { rev: got.body.rev, doc: merged }, REQUEST_TIMEOUT_MS);
        if (put.status === 200) {
          libraryKnown[name] = put.body.rev;
          side.merged?.(put.body.rev);
          return;
        }
        if (put.status !== 409) throw refused(put);
      }
    } finally {
      libraryBusy.delete(name);
      if (libraryAgain.delete(name) && running) librarySoon(name);
    }
  }

  function librarySoon(name: LibraryDocName): void {
    const waiting = libraryTimers.get(name);
    if (waiting) clearTimeout(waiting);
    libraryTimers.set(
      name,
      setTimeout(() => {
        libraryTimers.delete(name);
        if (running) void syncLibraryDoc(name).catch(() => undefined);
      }, LIBRARY_AFTER_CHANGE_MS)
    );
  }

  /** The library's documents this round: at the first, all of them unless nothing changed on either side since the last merge. */
  async function syncLibrary(revs: Record<string, number | undefined>, first: boolean): Promise<void> {
    for (const name of LIBRARY_DOCS) {
      const side = host.library?.[name];
      const rev = revs[name];
      // A service from before these documents doesn't list them.
      if (!side || rev === undefined) continue;
      if (first) {
        const last = side.lastMerge?.();
        if (last && last.rev === rev && !last.changed) {
          libraryKnown[name] = rev;
          continue;
        }
      } else if (rev === libraryKnown[name]) continue;
      // One document going wrong (a picture too large for the service, say) doesn't hold up the rest.
      try {
        await syncLibraryDoc(name);
      } catch (err) {
        const code = (err as { status?: number }).status;
        if (code === undefined || code === 401 || code === 403 || code >= 500) throw err;
      }
    }
  }

  /**
   * The shared listening history (lib/listenSync.ts): what was played here goes out first, so it's in
   * the history the others read; then the others' plays come in, a page at a time.
   */
  async function syncListens(): Promise<void> {
    const side = host.listens;
    if (!side || listensMissing) return;
    if (listensBusy) {
      listensAgain = true;
      return;
    }
    listensBusy = true;
    const gone = (): void => {
      listensMissing = true;
      side.missing?.();
    };
    try {
      for (let round = 0; round < 200; round++) {
        const batch = await side.pending(LISTEN_BATCH);
        if (!batch.length) break;
        const put = await call("POST", "/v1/listens", { device: { id: host.deviceId, ...side.device() }, listens: batch }, REQUEST_TIMEOUT_MS);
        if (put.status === 404) return gone();
        if (put.status !== 200) throw refused(put);
        await side.sent(batch[batch.length - 1]);
        if (batch.length < LISTEN_BATCH) break;
      }
      for (let round = 0; round < 500; round++) {
        const from = side.readUpTo();
        const got = await call("GET", `/v1/listens?since=${from}&limit=${LISTEN_PAGE}`, undefined, REQUEST_TIMEOUT_MS);
        if (got.status === 404) return gone();
        if (got.status !== 200) throw refused(got);
        const page = readListenPage(got.body);
        if (!page) return;
        // Another version of the history than the one read here (part 2 of the protocol rework): a device's
        // plays taken out and others added while this one was away (the length alone said nothing changed),
        // a backup put back, another service or account. Read again from the start, and what isn't in it
        // any more goes here too. A place read up to without a version (an older app's) is read again once.
        const read = side.generation?.();
        if (page.generation && read && side.readAfresh && read.read !== page.generation && read.afresh !== page.generation) {
          await side.readAfresh(page.generation);
          // This device's plays go again right after this round, not with the next news.
          listensAgain = true;
          continue;
        }
        // A service holding less than was read from it is another one, or started over: read it from the start.
        if (page.count < from) {
          await side.take([], page.devices, 0, true);
          listensAgain = true;
          continue;
        }
        // The service hands out the stretch right after "since": that far it's read, even where a line was unusable.
        const upTo = from + (got.body.listens as unknown[]).length;
        await side.take(page.listens.filter((l) => l.device !== host.deviceId), page.devices, upTo);
        listensKnown = page.count;
        listensGenerationKnown = page.generation ?? null;
        if (!page.more || upTo === from) {
          // That version read to its end: what isn't in it any more goes.
          if (page.generation && side.generation?.().afresh === page.generation) await side.readThrough?.(page.generation);
          break;
        }
      }
    } finally {
      listensBusy = false;
      if (listensAgain && running) {
        listensAgain = false;
        listensSoon(0);
      }
    }
  }

  function listensSoon(delay = LISTENS_AFTER_CHANGE_MS): void {
    if (listensTimer) clearTimeout(listensTimer);
    listensTimer = setTimeout(() => {
      listensTimer = null;
      if (running && status === "connected") void syncListens().catch(() => undefined);
    }, delay);
  }

  /** Where this device stands, to the service; true once it's there (written now, or there already). */
  async function pushPlayback(evenIfSent = false): Promise<boolean> {
    const state = host.readPlayback();
    if (!state) return false;
    if (!evenIfSent && state.note.at <= sentAt) return true;
    lastPlaybackAt = Date.now();
    if (state.note.queueId !== sentQueueId) {
      const put = await call("PUT", "/v1/docs/queue", { doc: state.queue() }, REQUEST_TIMEOUT_MS);
      if (put.status !== 200) throw refused(put);
      sentQueueId = state.note.queueId;
    }
    const put = await call("PUT", "/v1/docs/position", { doc: state.note }, REQUEST_TIMEOUT_MS);
    if (put.status !== 200) throw refused(put);
    known.position = put.body.rev;
    sentAt = state.note.at;
    // The others should see the same moment; this also runs in the background, where other timers don't.
    await sendPresence().catch(() => undefined);
    return true;
  }

  async function checkPlayback(): Promise<void> {
    const mine = playbackAnswers.ask();
    const got = await call("GET", "/v1/docs/position", undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    known.position = got.body.rev;
    const note = readNote(got.body.doc);
    if (!note || note.device.id === host.deviceId || !host.wantsPlayback(note)) {
      // Seen all the same: an older word arriving after it changes nothing.
      if (playbackAnswers.take(mine, got.body.rev)) noteTaken(got.body.rev, note);
      return;
    }
    const queue = await call("GET", "/v1/docs/queue", undefined, REQUEST_TIMEOUT_MS);
    const doc = queue.status === 200 ? (queue.body.doc as QueueDoc | null) : null;
    // The wait for the queue may have changed things here, and a newer word may have come meanwhile.
    const newest = playbackAnswers.take(mine, got.body.rev);
    if (newest) noteTaken(got.body.rev, note);
    if (!newest || !host.wantsPlayback(note)) return;
    const matching = doc?.id === note.queueId && Array.isArray(doc.tracks) ? doc : null;
    // The queue document is another list than the one this word is about: two devices wrote theirs in
    // between, or a list for an older app went there. Taken without its list, only its song came along
    // (plan section 5): it waits for the queue document to change. When the word moves on and the queue
    // document doesn't, its list isn't coming, and it's taken as before.
    const queueRev = typeof queue.body?.rev === "number" ? queue.body.rev : -1;
    const positionRev = typeof got.body.rev === "number" ? got.body.rev : -1;
    if (!matching && doc && !(queueAwaited && queueAwaited.queueRev === queueRev && queueAwaited.positionRev !== positionRev)) {
      queueAwaited = { queueRev, positionRev };
      return;
    }
    queueAwaited = null;
    sentQueueId = note.queueId;
    sentAt = note.at;
    host.adoptPlayback(note, matching);
  }

  async function pullLikes(): Promise<void> {
    const got = await call("GET", "/v1/docs/likes", undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    known.likes = got.body.rev;
    if (Array.isArray(got.body.doc?.tracks)) host.applyLikes?.(got.body.doc.tracks);
  }

  /**
   * Liked Songs' order from a device that arranges it: only when something changed here, this device just
   * arrived, or (on one that takes others' orders too) another one wrote. What changed here since the order
   * last agreed on goes on top of what's there, written on that revision; written meanwhile, put together
   * again. Two computers liking or taking out songs at once both keep their changes (plan section 5, Codex:
   * of two moves made on one revision only the second stayed). Without an agreed order yet, this one's goes.
   */
  async function pushLikes(): Promise<void> {
    if (!host.readLikes?.()) return;
    for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt++) {
      const got = await call("GET", "/v1/docs/likes", undefined, REQUEST_TIMEOUT_MS);
      if (got.status !== 200) throw refused(got);
      const rev = typeof got.body.rev === "number" ? got.body.rev : 0;
      known.likes = rev;
      const theirs: WireTrack[] = Array.isArray(got.body.doc?.tracks) ? got.body.doc.tracks : [];
      const mine = host.readLikes?.() ?? [];
      const base = host.adoptLikes ? host.likesBase?.() ?? null : null;
      const byId = new Map([...theirs, ...mine].map((t) => [t.id, t]));
      const order = base ? mergeOrder(base.ids, mine.map((t) => t.id), theirs.map((t) => t.id)) : mine.map((t) => t.id);
      const merged = order.map((id) => byId.get(id)).filter((t): t is WireTrack => !!t);
      let agreed = rev;
      if (!sameLikes(merged, theirs)) {
        const put = await call("PUT", "/v1/docs/likes", { rev, doc: { tracks: merged } }, REQUEST_TIMEOUT_MS);
        if (put.status === 409) continue;
        if (put.status !== 200) throw refused(put);
        agreed = put.body.rev;
        known.likes = agreed;
      }
      host.keepLikesBase?.({ rev: agreed, ids: merged.map((t) => t.id) });
      if (host.adoptLikes && !sameLikes(merged, mine)) host.adoptLikes(merged);
      return;
    }
  }

  async function pullMuted(): Promise<void> {
    if (!host.readMuted || !host.applyMuted) return;
    const got = await call("GET", "/v1/docs/muted", undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    known.muted = got.body.rev;
    const remote = got.body.doc as MutedDoc | null;
    const mine = host.readMuted();
    if (remote && Array.isArray(remote.tracks) && remote.at > mine.at) host.applyMuted(remote);
    // Changed here while nobody listened, or the service has none yet.
    else if (mine.at > (remote?.at ?? 0)) await pushMuted();
  }

  async function pushMuted(): Promise<void> {
    if (!host.readMuted) return;
    const put = await call("PUT", "/v1/docs/muted", { doc: host.readMuted() }, REQUEST_TIMEOUT_MS);
    if (put.status !== 200) throw refused(put);
    known.muted = put.body.rev;
  }

  async function sendPresence(): Promise<void> {
    if (!hasDevices || !host.readPresence) return;
    const said = host.readPresence();
    if (!said) return;
    const doc: DevicePresence = { ...said, abilities: DEVICE_ABILITIES };
    lastPresenceAt = Date.now();
    const put = await call("PUT", `/v1/devices/${encodeURIComponent(host.deviceId)}`, { doc }, REQUEST_TIMEOUT_MS);
    if (put.status !== 200) throw refused(put);
  }

  async function pullDevices(): Promise<void> {
    if (!host.applyDevices) return;
    const mine = devicesAnswers.ask();
    const got = await call("GET", "/v1/devices", undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    if (!devicesAnswers.take(mine, got.body.rev)) return;
    const list: { id: string; updatedAt: number; doc: DevicePresence }[] = Array.isArray(got.body.devices) ? got.body.devices : [];
    lastDevicesAt = Date.now();
    for (const d of list) abilitiesOf.set(d.id, Array.isArray(d.doc?.abilities) ? d.doc.abilities.filter((a): a is string => typeof a === "string") : []);
    host.applyDevices(
      list
        .filter((d) => d.id !== host.deviceId && d.doc && typeof d.doc === "object")
        .map((d) => ({ id: d.id, ageMs: Math.max(0, got.body.now - d.updatedAt), presence: d.doc }))
    );
  }

  async function takeCommands(mine: number): Promise<void> {
    if (!host.onCommand) return;
    // On a service that keeps them until this device says it's done, an answer lost on the way loses
    // nothing: they come again, and one already handled isn't run twice (Codex, 2026-11-21). Known first:
    // a device just started took them the old way before the service said what it can.
    const info = await knowFeatures();
    if (!running || mine !== session) return;
    if (!info) throw new Error("Could not determine the sync service's command protocol");
    const kept = features.has("commands-kept");
    const me = encodeURIComponent(host.deviceId);
    // Both ways written out, so the desktop's allow-list test sees each (tests/home-sync-paths).
    const got = kept
      ? await call("GET", `/v1/devices/${me}/commands?keep=1`, undefined, REQUEST_TIMEOUT_MS)
      : await call("GET", `/v1/devices/${me}/commands`, undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    const commands: unknown[] = Array.isArray(got.body.commands) ? got.body.commands : [];
    const ids: unknown[] = kept && Array.isArray(got.body.ids) ? got.body.ids : [];
    // A durable start marker alone cannot distinguish a lost start response from a lost completion.
    const startedBefore = new Set(kept && Array.isArray(got.body.started) ? (got.body.started as unknown[]).filter((x): x is string => typeof x === "string") : []);
    const done: string[] = [];
    const results: Record<string, string> = {};
    // Each one by itself, so one going wrong doesn't take the ones after it along (Codex's review: a
    // hand-over that failed lost the pause behind it as well).
    for (let i = 0; i < commands.length; i++) {
      const id = typeof ids[i] === "string" ? (ids[i] as string) : null;
      if (id && features.has("commands-started") && !handled.has(id) && !startedBefore.has(id)) {
        const mark = await call("POST", `/v1/devices/${me}/commands/start`, { ids: [id] }, REQUEST_TIMEOUT_MS);
        if (mark.status !== 200) throw refused(mark);
      }
      const before = id ? handled.get(id) ?? (startedBefore.has(id) && !repeatable(commands[i] as DeviceCommand) ? "unknown" : undefined) : undefined;
      const result = before ?? (await takeCommand(commands[i] as DeviceCommand & WithSongs).catch(() => "failed"));
      if (!id) continue;
      rememberHandled(id, result);
      done.push(id);
      results[id] = result;
    }
    if (!done.length) return;
    const said = await call("POST", `/v1/devices/${me}/commands/done`, { ids: done, results }, REQUEST_TIMEOUT_MS);
    if (said.status !== 200) throw refused(said);
  }

  /** One word for this device, and what came of it: "done", or "declined" when it couldn't do what was asked. */
  async function takeCommand(command: DeviceCommand & WithSongs): Promise<string> {
    // Going on from where another device stands needs that device's latest word.
    if (command?.action === "takeOver") return stumbleTwice(() => takeOver(command));
    if (typeof command?.listId === "string") return stumbleTwice(() => takeList(command));
    return said(host.onCommand?.(command));
  }

  /** What the app made of a command: "done" unless it says otherwise. */
  function said(result: void | string | undefined): string {
    return typeof result === "string" && result ? result : "done";
  }

  /** A step tried again a moment later while the service stumbles (no answer, or a 5xx): its command can't be asked for again. */
  async function stumbleTwice<T>(step: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (err) {
        const code = (err as { status?: number }).status;
        if (attempt >= COMMAND_TRIES || (code !== undefined && code < 500)) throw err;
        await new Promise((resolve) => setTimeout(resolve, attempt * COMMAND_RETRY_MS));
      }
    }
  }

  /** A command whose songs went ahead as the queue document. A newer list written over it wins. */
  async function takeList(command: DeviceCommand & WithSongs): Promise<string> {
    // In a list of its own (a sender and a service that know them): two lists sent at once each keep
    // their songs (Codex, 2026-11-21: of two 400-song lists only the second arrived).
    if (command.listStore) {
      const own = await call("GET", `/v1/lists/${encodeURIComponent(command.listId ?? "")}`, undefined, REQUEST_TIMEOUT_MS);
      if (own.status >= 500) throw refused(own);
      const list = own.status === 200 ? (own.body.doc as QueueDoc | null) : null;
      if (!list || !Array.isArray(list.tracks)) return "missing";
      const { listStore: _own, ...plain } = command;
      return said(host.onCommand?.({ ...plain, tracks: list.tracks } as DeviceCommand));
    }
    const got = await call("GET", "/v1/docs/queue", undefined, REQUEST_TIMEOUT_MS);
    // The service stumbled: asked again a moment later (stumbleTwice), not taken for "no list" (Codex,
    // 2026-11-21: of an enqueue and a pause after it only the pause arrived).
    if (got.status >= 500) throw refused(got);
    // That document isn't this device's own list now: it goes out again with its next word.
    sentQueueId = null;
    const doc = got.status === 200 ? (got.body.doc as QueueDoc | null) : null;
    if (!doc || doc.id !== command.listId || !Array.isArray(doc.tracks)) return "missing";
    return said(host.onCommand?.({ ...command, tracks: doc.tracks } as DeviceCommand));
  }

  /** The queue document, when it's the queue of that note. */
  async function queueOf(note: PlaybackNote): Promise<QueueDoc | null> {
    const got = await call("GET", "/v1/docs/queue", undefined, REQUEST_TIMEOUT_MS);
    const doc = got.status === 200 ? (got.body.doc as QueueDoc | null) : null;
    return doc?.id === note.queueId && Array.isArray(doc.tracks) ? doc : null;
  }

  async function takeOver(command: { from?: string; snapshot?: string } = {}): Promise<string> {
    // Where the device that handed over stood when it did, kept with the hand-over (the list store): that
    // very queue, whatever was written to the queue document since (part 3 of the protocol rework).
    let bound: { note: PlaybackNote; queue: QueueDoc } | null = null;
    if (typeof command.snapshot === "string") {
      const kept = await call("GET", `/v1/lists/${encodeURIComponent(command.snapshot)}`, undefined, REQUEST_TIMEOUT_MS);
      if (kept.status >= 500) throw refused(kept);
      const doc = kept.status === 200 ? (kept.body.doc as (QueueDoc & { note?: unknown }) | null) : null;
      const said = readNote(doc?.note);
      if (doc && said && Array.isArray(doc.tracks)) {
        const { note: _note, ...queue } = doc;
        bound = { note: said, queue: queue as QueueDoc };
      }
    }
    const mine = playbackAnswers.ask();
    const got = await call("GET", "/v1/docs/position", undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    known.position = got.body.rev;
    const rev = got.body.rev;
    const live = readNote(got.body.doc);
    // An older word arriving after this one changes nothing.
    if (playbackAnswers.take(mine, rev)) noteTaken(rev, live);
    // The word on where the music stands is this device's own, or another device spoke after the one that
    // handed over: that music goes on where it is (Codex's review: the target played that device's song).
    const from = typeof command.from === "string" ? command.from : null;
    if (live && (live.device.id === host.deviceId || (from && live.device.id !== from))) return "done";
    // From the device that handed over: where it stands now if it moved on since (another song, its queue
    // edited), else the state it handed over in. Without either there's nothing to go on from: what this
    // one had before (its own word, the latest there) isn't what was asked for.
    let note = bound && !(live && live.at > bound.note.at) ? bound.note : live;
    if (!note || note.device.id === host.deviceId) return "done";
    let queue = bound && bound.queue.id === note.queueId ? bound.queue : await queueOf(note);
    if (typeof rev === "number" && newestElsewhere && newestElsewhere.rev > rev) {
      // A newer word from yet another device came while this one was on its way: the music went on
      // there, and this hand-over starts nothing (Codex's review of these fixes).
      if (newestElsewhere.device !== note.device.id) return "done";
      // The device that handed over moved on while this one was on its way: where it stands now, not a
      // song it already left (Codex, 2026-11-21: A2 heard, then A1 taken over, then A2 again).
      if (newestElsewhere.note.at > note.at) {
        note = newestElsewhere.note;
        if (queue?.id !== note.queueId) queue = await queueOf(note);
      }
    }
    sentQueueId = note.queueId;
    sentAt = note.at;
    // Nothing of that list on this device: what it had before isn't what was asked for either. The
    // device that handed over hears so, and its music stays there.
    if (host.adoptPlayback(note, queue, true) === false) return "declined";
    host.onCommand?.({ action: "takeOver" });
    return "done";
  }

  /** Where this device stands, kept in the list store for a hand-over to a device that reads it from there: its id, or null. */
  async function keepHandOver(deviceId: string): Promise<string | null> {
    await knowFeatures();
    if (!features.has("lists") || !canTake(deviceId, "handover")) return null;
    const state = host.readPlayback();
    if (!state) return null;
    const id = `hand${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const put = await call("PUT", `/v1/lists/${encodeURIComponent(id)}`, { doc: { ...state.queue(), note: state.note } }, REQUEST_TIMEOUT_MS);
    return put.status === 200 ? id : null;
  }

  /** What the service says about itself, asked once it's linked: whether it's too old for this app. */
  async function checkService(mine: number): Promise<void> {
    try {
      const info = await knowFeatures();
      if (!running || mine !== session) return;
      host.onService?.(info);
    } catch {
      /* asked again at the next start */
    }
  }

  /** With the service away nothing says who's still around: from a while on, nobody is. */
  function nobodyHeardSoon(mine: number): void {
    if (nobodyTimer || toldNobody) return;
    nobodyTimer = setTimeout(() => {
      nobodyTimer = null;
      if (!running || mine !== session || status === "connected") return;
      toldNobody = true;
      known.devices = -1;
      host.applyDevices?.([]);
    }, Math.max(0, lastHeardAt + NOBODY_HEARD_AFTER_MS - Date.now()));
  }

  function heardAgain(): void {
    lastHeardAt = Date.now();
    toldNobody = false;
    if (nobodyTimer) clearTimeout(nobodyTimer);
    nobodyTimer = null;
  }

  /** A wait, cut short by retryNow, rest or stop; `null` waits for one of those alone. */
  function sleep(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === null ? null : setTimeout(done, ms);
      function done(): void {
        if (timer !== null) clearTimeout(timer);
        wakeSleep = null;
        resolve();
      }
      wakeSleep = done;
    });
  }

  /** `again`: a look in between (the app back in front), with everything known kept: only who's around is asked anew. */
  async function run(mine: number, again = false): Promise<void> {
    let retry = FIRST_RETRY_MS;
    let synced = again;
    let atOnce = again;
    if (!again) lastHeardAt = Date.now();
    while (running && mine === session) {
      try {
        // Asked for at once the first time round; from then on it waits for news.
        const wait = seq < 0 || atOnce ? 0 : LONG_POLL_SEC;
        atOnce = false;
        const reply = await host.request("GET", `/v1/changes?since=${seq}&wait=${wait}&device=${encodeURIComponent(host.deviceId)}`, undefined, LONG_POLL_TIMEOUT_MS);
        if (!running || mine !== session) return;
        if (reply.status !== 200) throw refused(reply);
        setStatus("connected");
        // Found: from now on it's kept in reach, also after it was away for a while.
        if (host.linked?.() === false) host.onLinked?.();
        heardAgain();
        retry = FIRST_RETRY_MS;
        seq = reply.body.seq;
        const revs = reply.body.revs ?? {};
        // The history's version: changed also when its length didn't (a play out, another in, while away).
        const listensGeneration = typeof reply.body.listensGeneration === "string" ? reply.body.listensGeneration : null;
        // Who's around and what plays there comes first: it's what somebody opening the app looks at,
        // and no document that takes its time (or fails) may stand in its way.
        hasDevices = revs.devices !== undefined;
        devicesAnswers.seen(revs.devices);
        playbackAnswers.seen(revs.position);
        if (newestElsewhere && typeof revs.position === "number" && revs.position < newestElsewhere.rev) newestElsewhere = null;
        if (hasDevices) {
          if (reply.body.inbox > 0) await takeCommands(mine);
          // Also without news: a device that went away says nothing about it.
          if (!synced || revs.devices !== known.devices || Date.now() - lastDevicesAt > DEVICES_LOOK_MS) {
            known.devices = revs.devices;
            await pullDevices();
          }
          if (!synced || Date.now() - lastPresenceAt > PRESENCE_EVERY_MS) await sendPresence();
        }
        if (!synced || revs.position !== known.position || (queueAwaited && revs.queue !== queueAwaited.queueRev)) await checkPlayback();
        if (!synced || revs.playlists !== known.playlists) {
          // A file the service can't read (423, Codex's review) doesn't hold up the rest, and nothing is sent over it.
          try {
            await syncPlaylists();
          } catch (err) {
            const code = (err as { status?: number }).status;
            if (code === undefined || code === 401 || code === 403 || code >= 500) throw err;
          }
        }
        // A service from before this document doesn't list it.
        if (revs.likes !== undefined) {
          if (host.applyLikes) {
            if (!synced || revs.likes !== known.likes) await pullLikes();
          } else if (!synced || (host.adoptLikes && revs.likes !== known.likes)) await pushLikes();
        }
        if (revs.muted !== undefined && (!synced || revs.muted !== known.muted)) await pullMuted();
        await syncLibrary(revs, !synced);
        // The shared listening history; a service from before it doesn't count listens.
        if (host.listens) {
          if (revs.listens === undefined) {
            if (!listensMissing) {
              listensMissing = true;
              host.listens.missing?.();
            }
          } else if (!synced || revs.listens !== listensKnown || (listensGeneration !== null && listensGeneration !== listensGenerationKnown)) {
            // An extra, and the round's last step: whatever goes wrong with it is tried again with the next
            // news, and never holds up the rest. Only a login the service refused counts for everything.
            try {
              await syncListens();
            } catch (err) {
              const code = (err as { status?: number }).status;
              if (code === 401 || code === 403) throw err;
            }
          }
        }
        // Linked: the service answered. Once per start, what it says about itself.
        if (!synced) void checkService(mine);
        synced = true;
        host.onListening?.();
      } catch (err) {
        if (!running || mine !== session) return;
        const code = (err as { status?: number }).status;
        const rejected = code === 400 || code === 401 || code === 403;
        setStatus(rejected ? "rejected" : "unreachable");
        nobodyHeardSoon(mine);
        // Never found for this server: looked for once. Again at the next start, or when asked (a new address, "Search again").
        if (!rejected && host.linked?.() === false) {
          await sleep(null);
          continue;
        }
        await sleep(rejected ? REJECTED_RETRY_MS : retry);
        retry = Math.min(retry * 2, LAST_RETRY_MS);
      }
    }
  }

  return {
    start(): void {
      enabled = true;
      if (running) return;
      running = true;
      featuresAsked = null;
      features = new Set();
      session += 1;
      seq = -1;
      known.playlists = -1;
      known.position = -1;
      known.likes = -1;
      known.muted = -1;
      known.devices = -1;
      devicesAnswers.afresh();
      playbackAnswers.afresh();
      newestElsewhere = null;
      for (const name of LIBRARY_DOCS) delete libraryKnown[name];
      libraryMissing.clear();
      listensKnown = -1;
      listensGenerationKnown = null;
      listensMissing = false;
      setStatus("connecting");
      void run(session);
    },

    /** Stops listening; what happens here still goes out. Back with start(). */
    rest(): void {
      running = false;
      session += 1;
      wakeSleep?.();
    },

    stop(): void {
      enabled = false;
      running = false;
      session += 1;
      if (playlistsTimer) clearTimeout(playlistsTimer);
      if (playbackTimer) clearTimeout(playbackTimer);
      if (likesTimer) clearTimeout(likesTimer);
      if (mutedTimer) clearTimeout(mutedTimer);
      if (presenceTimer) clearTimeout(presenceTimer);
      playlistsTimer = playbackTimer = likesTimer = mutedTimer = presenceTimer = null;
      for (const timer of libraryTimers.values()) clearTimeout(timer);
      libraryTimers.clear();
      if (listensTimer) clearTimeout(listensTimer);
      listensTimer = null;
      wakeSleep?.();
      setStatus("off");
    },

    /** Something changed in the playlists here. */
    playlistsChanged: playlistsSoon,

    /** A play was counted here: it goes out to the shared listening history in a moment, with any that follow. */
    listensChanged(): void {
      if (!enabled || !host.listens) return;
      listensSoon();
    },

    /** The shared listening history, read now (Replay was opened). */
    listensNow(): Promise<void> {
      return running && status === "connected" && host.listens ? syncListens().catch(() => undefined) : Promise.resolve();
    },

    /** Something changed here in how the library is organised: that document goes out in a moment. */
    libraryChanged(name: LibraryDocName): void {
      if (!enabled || !host.library?.[name]) return;
      librarySoon(name);
    },

    /** Liked Songs changed here: what was added, taken back or arranged anew. */
    likesChanged(): void {
      if (!enabled) return;
      if (likesTimer) clearTimeout(likesTimer);
      likesTimer = setTimeout(() => {
        likesTimer = null;
        void pushLikes().catch(() => undefined);
      }, LIKES_AFTER_CHANGE_MS);
    },

    /**
     * Something happened in playback here. `routine` is the tick while a song
     * plays: it goes out only every half minute.
     */
    playbackChanged(routine = false): void {
      if (!enabled) return;
      if (routine && Date.now() - lastPlaybackAt < PLAYBACK_WHILE_PLAYING_MS) return;
      if (playbackTimer) clearTimeout(playbackTimer);
      playbackTimer = setTimeout(() => {
        playbackTimer = null;
        void pushPlayback().catch(() => undefined);
      }, routine ? 0 : PLAYBACK_AFTER_CHANGE_MS);
    },

    /** The app is about to go quiet: where it stands goes out now. */
    flushPlayback(): Promise<void> {
      if (playbackTimer) clearTimeout(playbackTimer);
      playbackTimer = null;
      return pushPlayback().then(
        () => undefined,
        () => undefined
      );
    },

    /** Look again whether another device has something to continue from, say when this one comes back to the front. */
    checkPlayback(): Promise<void> {
      return running ? checkPlayback().catch(() => undefined) : Promise.resolve();
    },

    /** The list of muted songs changed here. */
    mutedChanged(): void {
      if (!enabled) return;
      if (mutedTimer) clearTimeout(mutedTimer);
      mutedTimer = setTimeout(() => {
        mutedTimer = null;
        void pushMuted().catch(() => undefined);
      }, MUTED_AFTER_CHANGE_MS);
    },

    /** What this device is doing changed: the others hear of it in a moment. */
    presenceChanged(): void {
      if (!enabled || !hasDevices) return;
      if (presenceTimer) clearTimeout(presenceTimer);
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        void sendPresence().catch(() => undefined);
      }, PRESENCE_AFTER_CHANGE_MS);
    },

    /** The same, now: the app is about to go quiet, or a timer wouldn't get to run. */
    presenceNow(): Promise<void> {
      if (!enabled) return Promise.resolve();
      return sendPresence().catch(() => undefined);
    },

    /** A word for another device; false when it couldn't be left for it. */
    sendCommand(deviceId: string, command: DeviceCommand): Promise<boolean> {
      return inTurn(async () => (await postCommand(deviceId, command)).ok);
    },

    /**
     * An edit of another device's queue (editQueue): what came of it there, where the service and that
     * app can say ("done", "partial", "stale"); null when that can't be told, "unsent" when it couldn't
     * be left. Waited for after its turn, so a word after it doesn't wait as well.
     */
    async sendEdit(deviceId: string, command: DeviceCommand): Promise<string | null> {
      const sent = await inTurn(() => postCommand(deviceId, command));
      if (!sent.ok) return "unsent";
      if (!features.has("command-results") || !canTake(deviceId, "kept")) return null;
      return resultOf(deviceId, sent.id, EDIT_ANSWER_MS);
    },

    /** A command with a list of songs of any length: they go ahead as the queue document. */
    sendList(deviceId: string, tracks: WireTrack[], context: string | undefined, command: DeviceCommand): Promise<boolean> {
      return inTurn(async () => {
        // Two lists sent in the same millisecond never share an id (Codex's review: the second one ran twice).
        const listId = `list${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        // A list of its own where the service keeps them; for an app that may not know them (an older one,
        // or one not heard from yet) also the queue document, where it always looked.
        await knowFeatures();
        const own = features.has("lists");
        const doc = { id: listId, context, tracks };
        try {
          if (own) {
            const put = await call("PUT", `/v1/lists/${encodeURIComponent(listId)}`, { doc }, REQUEST_TIMEOUT_MS);
            if (put.status !== 200) return false;
          }
          if (!own || !canTake(deviceId, "lists")) {
            const put = await call("PUT", "/v1/docs/queue", { doc }, REQUEST_TIMEOUT_MS);
            if (put.status !== 200) return false;
            sentQueueId = null;
          }
        } catch {
          return false;
        }
        return (await postCommand(deviceId, { ...command, listId, ...(own ? { listStore: true } : {}) } as DeviceCommand)).ok;
      });
    },

    /** Hands the music to another device: where this one stands goes out first, and it goes on from there. */
    handOver(deviceId: string): Promise<boolean> {
      return inTurn(async () => {
        // Where this one stands has to be there first. Without it, the other device went on from what it
        // knew from before and this one stopped for nothing (Codex's review, 2026-11-20): the music stays.
        const there = await pushPlayback(true).catch(() => false);
        if (!there) return false;
        // And kept with the hand-over, where the service and that app can: the other device goes on from
        // exactly that, whatever another device writes to the shared documents meanwhile.
        const snapshot = await keepHandOver(deviceId).catch(() => null);
        const sent = await postCommand(deviceId, { action: "takeOver", from: host.deviceId, ...(snapshot ? { snapshot } : {}) });
        if (!sent.ok) return false;
        // What the other device made of it, where the service and that app can say: one that has none of
        // the songs declines, and the music stays here (Codex, 2026-11-21: the source heard "fine").
        if (!features.has("command-results") || !canTake(deviceId, "kept")) return true;
        const result = await resultOf(deviceId, sent.id, HAND_OVER_ANSWER_MS);
        return result !== "declined" && result !== "unknown";
      });
    },

    /**
     * The app is looked at again (a phone app back in front, a computer awake again): a wait that may
     * have died meanwhile is dropped, and who's around and what plays there is asked at once.
     * Nothing happens when the service answered within `quietMs`: it's listening fine.
     */
    lookNow(quietMs = 0): void {
      if (!enabled) return;
      if (!running) {
        this.start();
        return;
      }
      if (status === "connected" && Date.now() - lastHeardAt < quietMs) return;
      // Never found for this server: it's looked for once a start, not at every look.
      if (status !== "connected" && host.linked?.() === false) return;
      session += 1;
      lastDevicesAt = 0;
      wakeSleep?.();
      void run(session, seq >= 0);
    },

    /** Who's around, asked now: something here changed what this device makes of them. */
    devicesNow(): Promise<void> {
      return running && hasDevices ? pullDevices().catch(() => undefined) : Promise.resolve();
    },

    /** A retry now instead of at the end of the wait, say after a new address was entered. */
    retryNow(): void {
      // Maybe another service now: its counts are its own, and who's around and what plays is asked again.
      devicesAnswers.afresh();
      playbackAnswers.afresh();
      newestElsewhere = null;
      known.devices = -1;
      known.position = -1;
      lastDevicesAt = 0;
      wakeSleep?.();
    },

    /** "Search again" in the settings: the service is looked for now, and that shows. */
    searchAgain(): void {
      if (!running || status !== "unreachable") return;
      setStatus("connecting");
      wakeSleep?.();
    },

    status: (): SyncStatus => status,
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;

/**
 * Where the service is unless told otherwise. At home on Jellyfin's host, port
 * 8196; behind https (a proxy or tunnel, with one door) under Jellyfin's name.
 */
export function defaultSyncAddress(server: string): string | null {
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/:]+)(:\d+)?/i.exec(server);
  if (!match) return null;
  return match[1].toLowerCase() === "https" ? `https://${match[2]}${match[3] ?? ""}/songsta-sync` : `http://${match[2]}:8196`;
}
