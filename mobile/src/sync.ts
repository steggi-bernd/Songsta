/**
 * This phone's side of the sync service: how it reaches the service and what
 * the conversation (lib/syncEngine.ts) reads and changes here. It listens while
 * the app is in front, and in the background while it plays and for a while
 * after, so another device can steer it; what it plays still goes out either way.
 * Linked to a computer at home (homeLink.ts), that computer is the service, with
 * or without a Jellyfin login here.
 */
import { AppState, type NativeEventSubscription } from "react-native";
import { create } from "zustand";
import { findAgain, homeAuthorization, homeDeviceId, homeLink, loadHomeLink } from "./homeLink";
import { authHeader } from "./jellyfin";
import { libraryDocHosts, watchLibraryDocs } from "./libraryDocs";
import { createSyncEngine, defaultSyncAddress, problemKey, serviceProblem, sharesListens, toPlaylistDoc, T, type ListenHost, type SyncEngine, type SyncServiceInfo, type SyncServiceProblem, type SyncStatus } from "./shared";
import { useSettings } from "./stores/settings";
import { toast } from "./stores/popups";
import { useAlbumEdits } from "./stores/albumEdits";
import { useLibrarySync } from "./stores/librarySync";
import { readJson, writeJson } from "./storage";
import { useConnection } from "./stores/connection";
import { onLikesSent, useLibrary } from "./stores/library";
import { adoptPlayback, hearDevices, linkDevices, onPlaybackActivity, phonePresence, playbackNote, runCommand, usePlayer, wantsPlayback } from "./stores/player";
import { usePlaylists } from "./stores/playlists";
import { useDevices } from "./stores/devices";
import { useSession } from "./stores/session";
import { onListenNoted, useListens } from "./stores/listens";
import Player from "../modules/media3-player";

const FILE = "sync-settings.json";
/** Paused in the background: still within reach for this long. */
const LISTENS_AFTER_PLAYING_MS = 5 * 60_000;
/** The service answered within this long: it's listening, and coming to the front needs no new round. */
const LISTENING_FINE_MS = 1500;

interface SyncState {
  status: SyncStatus;
  /** an address entered by hand; otherwise the service is looked for on Jellyfin's host */
  customAddress: string;
  setCustomAddress(address: string): void;
  /** what the linked service says about itself, and why it's too old for this app (lib/syncService.ts) */
  service: SyncServiceInfo | null;
  serviceProblem: SyncServiceProblem | null;
  /** a sync service ever answered this phone for this server: until one has, it's only looked for now and then */
  linked: boolean;
}

/** the service's problem last told as a note: told once, again only when it's another */
let serviceNoted = "";
/** the servers a sync service ever answered for (serverKey), latest last */
let linkedServers: string[] = [];
const LINKED_KEPT = 20;

const saveSettings = (): void => writeJson(FILE, { customAddress: useSync.getState().customAddress, serviceNoted, linked: linkedServers });

/** Which server this is, whatever address it's reached at: another one is looked for afresh. */
function serverKey(): string | null {
  const home = homeLink();
  if (home) return `home|${home.id}`;
  const session = useSession.getState().session;
  return session ? `${session.serverId || session.server}|${useSync.getState().customAddress}` : null;
}

/** a service answered while this ran, for this server: known, whether or not it could be written down */
let linkedHere = false;

// A linked computer is known to be there: nothing to look for.
const isLinked = (): boolean => {
  if (homeLink()) return true;
  const key = serverKey();
  return linkedHere || (!!key && linkedServers.includes(key));
};

/** Where the sync goes and as whom: the computer at home when linked to one, else the Jellyfin server's service. */
function syncLine(): { base: string; headers: Record<string, string>; deviceId: string } | null {
  const home = homeLink();
  if (home) return { base: home.address, headers: { Authorization: homeAuthorization(home.token) }, deviceId: homeDeviceId() };
  const session = useSession.getState().session;
  const base = syncAddress();
  if (!session || !base) return null;
  return { base, headers: { Authorization: authHeader(session.deviceId, session.token) }, deviceId: session.deviceId };
}

/**
 * The linked computer doesn't answer at its address: it may have another one from the router, so the
 * network is asked once more, with the app in front and every five minutes at most (it may just be off).
 */
const LOOK_AGAIN_MS = 5 * 60_000;
let lookedAgainAt = 0;
function lookForComputer(): void {
  if (!homeLink() || AppState.currentState !== "active" || Date.now() - lookedAgainAt < LOOK_AGAIN_MS) return;
  lookedAgainAt = Date.now();
  void findAgain().then((moved) => {
    if (moved) engine?.retryNow();
  });
}

export const useSync = create<SyncState>((set) => ({
  status: "off",
  customAddress: "",
  service: null,
  serviceProblem: null,
  linked: false,
  setCustomAddress(address) {
    const customAddress = address.trim().replace(/\/+$/, "");
    // Another service: looked for afresh.
    if (customAddress !== useSync.getState().customAddress) linkedHere = false;
    set({ customAddress });
    set({ linked: isLinked() });
    saveSettings();
    engine?.retryNow();
  },
}));

/** Pulling Home down: the service is asked at once what's new and who's around. */
export function syncLookNow(): void {
  engine?.lookNow(0);
  void engine?.checkPlayback();
}

/** "Search again" in Settings: no service ever answered this phone, and it's looked for now. */
export function searchSyncAgain(): void {
  engine?.searchAgain();
}

/** What the linked service said about itself: a service too old for this app is said once, and in Settings. */
function hearService(info: SyncServiceInfo | null): void {
  const problem = serviceProblem(info);
  useSync.setState({ service: info, serviceProblem: problem });
  const key = problem ? problemKey(problem) : "";
  if (key === serviceNoted) return;
  serviceNoted = key;
  saveSettings();
  if (problem) toast(T("Your sync service is out of date: library order, groups and album edits stay on this phone until it's updated. Settings say how."), true);
}

/** Where the service is looked for right now. */
export function syncAddress(): string | null {
  const home = homeLink();
  if (home) return home.address;
  const custom = useSync.getState().customAddress;
  if (custom) return /^https?:\/\//i.test(custom) ? custom : `http://${custom}`;
  const session = useSession.getState().session;
  return session ? defaultSyncAddress(session.server) : null;
}

/**
 * This phone's plays taken off the sync service's shared history (Settings → Network & privacy): the
 * other devices keep what they already took in, this phone keeps its own and doesn't send those again.
 */
export async function removeSharedListens(): Promise<"removed" | "old-service" | "not-linked" | "failed"> {
  const line = syncLine();
  if (!line || !isLinked()) return "not-linked";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${line.base}/v1/listens?device=${encodeURIComponent(line.deviceId)}`, {
      method: "DELETE",
      headers: { ...line.headers, Accept: "application/json" },
      signal: ctrl.signal,
    });
    // A service from before this can't take anything out.
    if (res.status === 404 || res.status === 405) return "old-service";
    if (!res.ok) return "failed";
    useListens.getState().keepOwnHere();
    return "removed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

let engine: SyncEngine | null = null;
let appState: NativeEventSubscription | null = null;
let offPlaylists: (() => void) | null = null;
let offReach: (() => void) | null = null;
let offMuted: (() => void) | null = null;
let offPlaying: (() => void) | null = null;
let offLibraryDocs: (() => void) | null = null;
let offListens: (() => void) | null = null;

/** The shared listening history read now (Replay opened): with a sync service, the other devices' plays. */
export function readListensNow(): Promise<void> {
  return engine?.listensNow() ?? Promise.resolve();
}
let offAddress: (() => void) | null = null;
let applying = false;
let lastPlayingAt = 0;
let keysLevel = -1;

const playingHere = (): boolean => {
  const { playWhenReady, remote } = usePlayer.getState();
  return playWhenReady && !remote;
};

/** Following another device with the app in front: the volume keys are for that device. */
function tellVolumeKeys(): void {
  const { remote, remoteVolume } = usePlayer.getState();
  const level = AppState.currentState === "active" && remote && remoteVolume !== null ? Math.round(remoteVolume * 100) : -1;
  if (level === keysLevel) return;
  keysLevel = level;
  void Player.followVolumeKeys(level).catch(() => undefined);
}

export async function startSync(): Promise<void> {
  if (engine) return;
  await loadHomeLink();
  if (!syncLine()) return;
  const saved = await readJson<{ customAddress?: string; serviceNoted?: string; linked?: unknown }>(FILE);
  if (saved?.customAddress) useSync.setState({ customAddress: saved.customAddress });
  serviceNoted = typeof saved?.serviceNoted === "string" ? saved.serviceNoted : "";
  linkedServers = Array.isArray(saved?.linked) ? saved.linked.filter((k): k is string => typeof k === "string") : [];
  useSync.setState({ linked: isLinked() });
  await Promise.all([usePlaylists.getState().restore(), useAlbumEdits.getState().restore(), useLibrarySync.getState().restore()]);
  const line = syncLine();
  if (engine || !line) return;

  const device = { id: line.deviceId, name: phonePresence().name };
  await useListens.getState().load();
  // Plays read from another sync service don't carry on in this one.
  useListens.getState().useServer(serverKey() ?? "");
  const libraryHosts = libraryDocHosts();
  const listenHost: ListenHost = {
    device: () => ({ name: phonePresence().name, kind: "phone" }),
    pending: async (max) => useListens.getState().pending(max),
    sent: (last) => useListens.getState().markSent(last),
    readUpTo: () => useListens.getState().readUpTo,
    take: (listens, devices, upTo, startOver) => useListens.getState().take(listens, devices, upTo, startOver),
    missing: () => useListens.getState().setMissing(true),
    generation: () => useListens.getState().versionRead(),
    readAfresh: (generation) => useListens.getState().readAfresh(generation),
    readThrough: (generation) => useListens.getState().readThrough(generation),
  };
  const created = createSyncEngine({
    deviceId: line.deviceId,
    async request(method, path, body, timeoutMs = 20_000) {
      const now = syncLine();
      if (!now) throw new Error("No server");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${now.base}${path}`, {
          method,
          headers: {
            ...now.headers,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
      } catch (err) {
        lookForComputer();
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    readPlaylists: () => toPlaylistDoc(usePlaylists.getState()),
    applyPlaylists(doc) {
      applying = true;
      usePlaylists.getState().applyDoc(doc);
      applying = false;
    },
    readPlayback: () => playbackNote(device),
    wantsPlayback,
    adoptPlayback,
    applyLikes: (tracks) => useLibrary.getState().setLikedOrder(tracks),
    readPresence: phonePresence,
    applyDevices: hearDevices,
    onCommand: runCommand,
    readMuted: () => ({ at: useLibrary.getState().mutedAt, tracks: useLibrary.getState().mutedTracks }),
    applyMuted(doc) {
      applying = true;
      useLibrary.getState().applyMuted(doc.tracks, doc.at);
      applying = false;
    },
    onStatus: (status) => useSync.setState({ status }),
    // Most people have no sync service: until one answered for this server, it's looked for once a start and when asked.
    linked: isLinked,
    onLinked() {
      linkedHere = true;
      useSync.setState({ linked: true });
      const key = serverKey();
      if (!key) return;
      linkedServers = [...linkedServers.filter((k) => k !== key), key].slice(-LINKED_KEPT);
      saveSettings();
    },
    // How the library is organised, the same as on the computer: pins, sort, groups, album edits; and the
    // listening history all devices share (lib/listenSync.ts, stores/listens.ts): each only while it's
    // shared (Settings → Network & privacy), the history only while plays are kept here at all, since
    // the other devices' come into it. The engine asks for them each time.
    get library() {
      return useSettings.getState().shareLibrary ? libraryHosts : undefined;
    },
    get listens() {
      return sharesListens(useSettings.getState()) ? listenHost : undefined;
    },
    onService: hearService,
    onListening() {
      // Nothing played here for a while, and nobody looks: it can rest.
      if (AppState.currentState !== "active" && !playingHere() && Date.now() - lastPlayingAt > LISTENS_AFTER_PLAYING_MS) created.rest();
    },
  });
  engine = created;

  offPlaylists = usePlaylists.subscribe((s, prev) => {
    if (!applying && (s.playlists !== prev.playlists || s.folders !== prev.folders)) created.playlistsChanged();
  });
  offLibraryDocs = watchLibraryDocs((name) => created.libraryChanged(name));
  offListens = onListenNoted(() => created.listensChanged());
  onPlaybackActivity((routine) => {
    // In the background timers don't run: what the others should know goes out at once.
    if (!routine && AppState.currentState !== "active") void created.flushPlayback();
    else created.playbackChanged(routine);
  });
  linkDevices({
    self: line.deviceId,
    send: (id, command) => created.sendCommand(id, command),
    sendEdit: (id, command) => created.sendEdit(id, command),
    sendList: (id, tracks, context, command) => created.sendList(id, tracks, context, command),
    handOver: (id) => created.handOver(id),
    look: () => void created.checkPlayback(),
    lookAround: () => void created.devicesNow(),
    connected: () => created.status() === "connected",
    presence: () => {
      if (AppState.currentState === "active") created.presenceChanged();
      else void created.presenceNow();
    },
  });
  offPlaying = usePlayer.subscribe((s, prev) => {
    if (s.remote !== prev.remote || s.remoteVolume !== prev.remoteVolume) tellVolumeKeys();
    if (s.playWhenReady !== prev.playWhenReady || s.remote !== prev.remote) {
      if (playingHere() || prev.playWhenReady) lastPlayingAt = Date.now();
      // Started in the background, by a headset say: within reach from now on.
      if (playingHere() && AppState.currentState !== "active") created.start();
    }
  });
  offMuted = useLibrary.subscribe((s, prev) => {
    if (!applying && s.mutedAt !== prev.mutedAt) created.mutedChanged();
  });
  // The computer hears of a like at once, not at its next round.
  onLikesSent(() => {
    for (const other of useDevices.getState().others) {
      if (other.presence.kind === "computer") void created.sendCommand(other.id, { action: "syncLikes" });
    }
  });
  // The server moved or came back: the service is worth looking for at once.
  offReach = useConnection.subscribe((s, prev) => {
    if (s.reach !== prev.reach) created.retryNow();
  });
  // Another address entered, or the session moved home or away: the service is looked for there.
  offAddress = useSession.subscribe((s, prev) => {
    if (s.session?.server === prev.session?.server && s.session?.serverId === prev.session?.serverId) return;
    // Another server altogether is looked for afresh; the same one at another address stays known.
    if (s.session?.serverId !== prev.session?.serverId) linkedHere = false;
    useSync.setState({ linked: isLinked() });
    created.retryNow();
  });
  appState = AppState.addEventListener("change", (state) => {
    tellVolumeKeys();
    // Back in front: a wait that died while the phone slept is dropped, and what plays elsewhere is asked at once.
    if (state === "active") created.lookNow(LISTENING_FINE_MS);
    else if (state === "background") {
      void created.flushPlayback();
      if (!playingHere() && Date.now() - lastPlayingAt > LISTENS_AFTER_PLAYING_MS) created.rest();
    }
  });
  // Shared again (or not any more): a fresh start says everything once, as at the app's start.
  offShares = useSettings.subscribe((s, prev) => {
    if (s.shareLibrary === prev.shareLibrary && s.shareListens === prev.shareListens && s.recordListening === prev.recordListening) return;
    stopSync();
    void startSync();
  });
  created.start();
}

let offShares: (() => void) | null = null;

/** Linked to a computer at home, or not any more: the sync starts afresh with the service there is now. */
export function restartSync(): void {
  stopSync();
  void startSync();
}

export function stopSync(): void {
  offShares?.();
  offShares = null;
  offReach?.();
  offReach = null;
  offAddress?.();
  offAddress = null;
  linkedHere = false;
  engine?.stop();
  engine = null;
  // Not linked any more: nothing to say about a service.
  useSync.setState({ service: null, serviceProblem: null });
  appState?.remove();
  appState = null;
  offPlaylists?.();
  offPlaylists = null;
  offMuted?.();
  offMuted = null;
  offPlaying?.();
  offPlaying = null;
  offLibraryDocs?.();
  offLibraryDocs = null;
  offListens?.();
  offListens = null;
  keysLevel = -1;
  void Player.followVolumeKeys(-1).catch(() => undefined);
  onPlaybackActivity(null);
  linkDevices(null);
  onLikesSent(null);
}

