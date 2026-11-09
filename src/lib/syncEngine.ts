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
 */
import { LIBRARY_DOC_KINDS, LIBRARY_DOCS, sameLibraryDoc, type LibraryDocName } from "./librarySync";
import { mergePlaylistDocs, sameDoc, sameLikes, toPlaylistDoc, type PlaylistDoc, type WireTrack } from "./playlistSync";
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
}

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
}

export type DeviceCommand =
  | { action: "play" | "pause" | "next" | "previous" | "syncLikes" }
  /** the branch into this list taken back */
  | { action: "cancelBranch"; name?: string }
  | { action: "seek"; positionMs: number }
  /** a song of its queue: `track` says which, as devices can know a song by different copies */
  | { action: "jump"; trackId: string; by?: number; track?: WireTrack }
  /** songs for its queue, behind the playing one and what was asked for before */
  | ({ action: "enqueue"; next?: boolean } & WithSongs)
  /** go on from the position and queue documents, playing */
  | { action: "takeOver" }
  /** another device started the music: pause, and show that one */
  | { action: "yield"; to: string }
  | { action: "shuffle"; on: boolean }
  | { action: "repeat"; mode: "off" | "all" | "one" }
  | { action: "volume"; level: number }
  /** a new list, from this song of it; `keepOrder` when it's in its final order already */
  | ({ action: "playList"; start: number; context?: string; shuffle?: boolean; keepOrder?: boolean } & WithSongs)
  /** what comes after the playing song, edited elsewhere; `line` of them were asked for by hand */
  | ({ action: "setUpcoming"; line?: number } & WithSongs)
  /** the first of these next and the rest after it, what was coming behind them */
  | ({ action: "branchOff"; name: string } & WithSongs);

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
  /** What this device says about itself; without it, it isn't listed among the devices. */
  readPresence?(): DevicePresence | null;
  /** The other devices, whenever one of them says something. */
  applyDevices?(devices: RemoteDevice[]): void;
  /** Another device asks this one to do something. */
  onCommand?(command: DeviceCommand): void;
  readMuted?(): MutedDoc;
  /** A newer list of muted songs from another device. */
  applyMuted?(doc: MutedDoc): void;
  onStatus?(status: SyncStatus): void;
  /** A round of listening is over: the moment to stop, if there's no reason to go on. */
  onListening?(): void;
  /** How the library is organised, document by document; one this device doesn't keep isn't synced. */
  library?: Partial<Record<LibraryDocName, LibraryDocHost>>;
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
/** A device that says nothing for longer than this and a bit counts as gone: see DEVICE_ONLINE_MS. */
/** No word from the service for this long: nobody counts as around, and a device being followed can't be steered anyway. */
const NOBODY_HEARD_AFTER_MS = 30_000;
const PRESENCE_EVERY_MS = 40_000;
const DEVICES_LOOK_MS = 45_000;
const MERGE_ATTEMPTS = 4;

/** Heard of within this long, a device is around. */
export const DEVICE_ONLINE_MS = 100_000;

function readNote(doc: unknown): PlaybackNote | null {
  const n = doc as PlaybackNote | null;
  return n && typeof n === "object" && typeof n.device?.id === "string" && typeof n.at === "number" && typeof n.track?.id === "string" ? n : null;
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

  async function pushPlayback(evenIfSent = false): Promise<void> {
    const state = host.readPlayback();
    if (!state || (!evenIfSent && state.note.at <= sentAt)) return;
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
  }

  async function checkPlayback(): Promise<void> {
    const got = await call("GET", "/v1/docs/position", undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    known.position = got.body.rev;
    const note = readNote(got.body.doc);
    if (!note || note.device.id === host.deviceId || !host.wantsPlayback(note)) return;
    const queue = await call("GET", "/v1/docs/queue", undefined, REQUEST_TIMEOUT_MS);
    const doc = queue.status === 200 ? (queue.body.doc as QueueDoc | null) : null;
    // The wait for the queue may have changed things here.
    if (!host.wantsPlayback(note)) return;
    const matching = doc?.id === note.queueId && Array.isArray(doc.tracks) ? doc : null;
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

  /** Only when something changed here or this device just arrived: two computers can't keep answering each other. */
  async function pushLikes(): Promise<void> {
    const mine = host.readLikes?.();
    if (!mine) return;
    const got = await call("GET", "/v1/docs/likes", undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    known.likes = got.body.rev;
    if (sameLikes(mine, Array.isArray(got.body.doc?.tracks) ? got.body.doc.tracks : [])) return;
    const put = await call("PUT", "/v1/docs/likes", { doc: { tracks: mine } }, REQUEST_TIMEOUT_MS);
    if (put.status !== 200) throw refused(put);
    known.likes = put.body.rev;
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
    const doc = host.readPresence();
    if (!doc) return;
    lastPresenceAt = Date.now();
    const put = await call("PUT", `/v1/devices/${encodeURIComponent(host.deviceId)}`, { doc }, REQUEST_TIMEOUT_MS);
    if (put.status !== 200) throw refused(put);
  }

  async function pullDevices(): Promise<void> {
    if (!host.applyDevices) return;
    const got = await call("GET", "/v1/devices", undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    const list: { id: string; updatedAt: number; doc: DevicePresence }[] = Array.isArray(got.body.devices) ? got.body.devices : [];
    lastDevicesAt = Date.now();
    host.applyDevices(
      list
        .filter((d) => d.id !== host.deviceId && d.doc && typeof d.doc === "object")
        .map((d) => ({ id: d.id, ageMs: Math.max(0, got.body.now - d.updatedAt), presence: d.doc }))
    );
  }

  async function takeCommands(): Promise<void> {
    if (!host.onCommand) return;
    const got = await call("GET", `/v1/devices/${encodeURIComponent(host.deviceId)}/commands`, undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    for (const command of Array.isArray(got.body.commands) ? got.body.commands : []) {
      // Going on from where another device stands needs that device's latest word.
      if (command?.action === "takeOver") await takeOver();
      else if (typeof command?.listId === "string") await takeList(command);
      else host.onCommand(command);
    }
  }

  /** A command whose songs went ahead as the queue document. A newer list written over it wins. */
  async function takeList(command: DeviceCommand & WithSongs): Promise<void> {
    const got = await call("GET", "/v1/docs/queue", undefined, REQUEST_TIMEOUT_MS);
    // That document isn't this device's own list now: it goes out again with its next word.
    sentQueueId = null;
    const doc = got.status === 200 ? (got.body.doc as QueueDoc | null) : null;
    if (doc && doc.id === command.listId && Array.isArray(doc.tracks)) host.onCommand?.({ ...command, tracks: doc.tracks } as DeviceCommand);
  }

  async function takeOver(): Promise<void> {
    const got = await call("GET", "/v1/docs/position", undefined, REQUEST_TIMEOUT_MS);
    if (got.status !== 200) throw refused(got);
    known.position = got.body.rev;
    const note = readNote(got.body.doc);
    if (note) {
      const queue = await call("GET", "/v1/docs/queue", undefined, REQUEST_TIMEOUT_MS);
      const doc = queue.status === 200 ? (queue.body.doc as QueueDoc | null) : null;
      sentQueueId = note.queueId;
      sentAt = note.at;
      // Nothing of that list on this device: what it had before isn't what was asked for either.
      if (host.adoptPlayback(note, doc?.id === note.queueId && Array.isArray(doc.tracks) ? doc : null, true) === false) return;
    }
    host.onCommand?.({ action: "takeOver" });
  }

  /** What the service says about itself, asked once it's linked: whether it's too old for this app. */
  async function checkService(mine: number): Promise<void> {
    if (!host.onService) return;
    try {
      const got = await call("GET", "/health", undefined, REQUEST_TIMEOUT_MS);
      if (!running || mine !== session) return;
      host.onService(got.status === 200 ? readServiceInfo(got.body) : null);
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

  async function run(mine: number): Promise<void> {
    let retry = FIRST_RETRY_MS;
    let synced = false;
    lastHeardAt = Date.now();
    while (running && mine === session) {
      try {
        // Asked for at once the first time round; from then on it waits for news.
        const wait = seq < 0 ? 0 : LONG_POLL_SEC;
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
        if (!synced || revs.playlists !== known.playlists) await syncPlaylists();
        if (!synced || revs.position !== known.position) await checkPlayback();
        // A service from before this document doesn't list it.
        if (revs.likes !== undefined) {
          if (host.applyLikes) {
            if (!synced || revs.likes !== known.likes) await pullLikes();
          } else if (!synced) await pushLikes();
        }
        if (revs.muted !== undefined && (!synced || revs.muted !== known.muted)) await pullMuted();
        await syncLibrary(revs, !synced);
        hasDevices = revs.devices !== undefined;
        if (hasDevices) {
          if (reply.body.inbox > 0) await takeCommands();
          // Also without news: a device that went away says nothing about it.
          if (!synced || revs.devices !== known.devices || Date.now() - lastDevicesAt > DEVICES_LOOK_MS) {
            known.devices = revs.devices;
            await pullDevices();
          }
          if (!synced || Date.now() - lastPresenceAt > PRESENCE_EVERY_MS) await sendPresence();
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
      session += 1;
      seq = -1;
      known.playlists = -1;
      known.position = -1;
      known.likes = -1;
      known.muted = -1;
      known.devices = -1;
      for (const name of LIBRARY_DOCS) delete libraryKnown[name];
      libraryMissing.clear();
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
      wakeSleep?.();
      setStatus("off");
    },

    /** Something changed in the playlists here. */
    playlistsChanged: playlistsSoon,

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
      return pushPlayback().catch(() => undefined);
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
    async sendCommand(deviceId: string, command: DeviceCommand): Promise<boolean> {
      try {
        const res = await call("POST", `/v1/devices/${encodeURIComponent(deviceId)}/commands`, { command }, REQUEST_TIMEOUT_MS);
        return res.status === 200;
      } catch {
        return false;
      }
    },

    /** A command with a list of songs of any length: they go ahead as the queue document. */
    async sendList(deviceId: string, tracks: WireTrack[], context: string | undefined, command: DeviceCommand): Promise<boolean> {
      const listId = `list${Date.now()}`;
      try {
        const put = await call("PUT", "/v1/docs/queue", { doc: { id: listId, context, tracks } }, REQUEST_TIMEOUT_MS);
        if (put.status !== 200) return false;
      } catch {
        return false;
      }
      sentQueueId = null;
      return this.sendCommand(deviceId, { ...command, listId } as DeviceCommand);
    },

    /** Hands the music to another device: where this one stands goes out first, and it goes on from there. */
    async handOver(deviceId: string): Promise<boolean> {
      await pushPlayback(true).catch(() => undefined);
      return this.sendCommand(deviceId, { action: "takeOver" });
    },

    /** A retry now instead of at the end of the wait, say after a new address was entered. */
    retryNow(): void {
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
