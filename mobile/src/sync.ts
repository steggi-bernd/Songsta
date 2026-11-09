/**
 * This phone's side of the sync service: how it reaches the service and what
 * the conversation (lib/syncEngine.ts) reads and changes here. It listens while
 * the app is in front, and in the background while it plays and for a while
 * after, so another device can steer it; what it plays still goes out either way.
 */
import { AppState, type NativeEventSubscription } from "react-native";
import { create } from "zustand";
import { authHeader } from "./jellyfin";
import { libraryDocHosts, watchLibraryDocs } from "./libraryDocs";
import { createSyncEngine, defaultSyncAddress, problemKey, serviceProblem, toPlaylistDoc, T, type SyncEngine, type SyncServiceInfo, type SyncServiceProblem, type SyncStatus } from "./shared";
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
import Player from "../modules/media3-player";

const FILE = "sync-settings.json";
/** Paused in the background: still within reach for this long. */
const LISTENS_AFTER_PLAYING_MS = 5 * 60_000;

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
  const session = useSession.getState().session;
  return session ? `${session.serverId || session.server}|${useSync.getState().customAddress}` : null;
}

/** a service answered while this ran, for this server: known, whether or not it could be written down */
let linkedHere = false;

const isLinked = (): boolean => {
  const key = serverKey();
  return linkedHere || (!!key && linkedServers.includes(key));
};

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
  const custom = useSync.getState().customAddress;
  if (custom) return /^https?:\/\//i.test(custom) ? custom : `http://${custom}`;
  const session = useSession.getState().session;
  return session ? defaultSyncAddress(session.server) : null;
}

let engine: SyncEngine | null = null;
let appState: NativeEventSubscription | null = null;
let offPlaylists: (() => void) | null = null;
let offReach: (() => void) | null = null;
let offMuted: (() => void) | null = null;
let offPlaying: (() => void) | null = null;
let offLibraryDocs: (() => void) | null = null;
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
  const session = useSession.getState().session;
  if (!session) return;
  const saved = await readJson<{ customAddress?: string; serviceNoted?: string; linked?: unknown }>(FILE);
  if (saved?.customAddress) useSync.setState({ customAddress: saved.customAddress });
  serviceNoted = typeof saved?.serviceNoted === "string" ? saved.serviceNoted : "";
  linkedServers = Array.isArray(saved?.linked) ? saved.linked.filter((k): k is string => typeof k === "string") : [];
  useSync.setState({ linked: isLinked() });
  await Promise.all([usePlaylists.getState().restore(), useAlbumEdits.getState().restore(), useLibrarySync.getState().restore()]);
  if (engine || !useSession.getState().session) return;

  const device = { id: session.deviceId, name: phonePresence().name };
  const created = createSyncEngine({
    deviceId: session.deviceId,
    async request(method, path, body, timeoutMs = 20_000) {
      const current = useSession.getState().session;
      const base = syncAddress();
      if (!current || !base) throw new Error("No server");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: {
            Authorization: authHeader(current.deviceId, current.token),
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
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
    // How the library is organised, the same as on the computer: pins, sort, groups, album edits.
    library: libraryDocHosts(),
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
  onPlaybackActivity((routine) => {
    // In the background timers don't run: what the others should know goes out at once.
    if (!routine && AppState.currentState !== "active") void created.flushPlayback();
    else created.playbackChanged(routine);
  });
  linkDevices({
    self: session.deviceId,
    send: (id, command) => created.sendCommand(id, command),
    sendList: (id, tracks, context, command) => created.sendList(id, tracks, context, command),
    handOver: (id) => created.handOver(id),
    look: () => void created.checkPlayback(),
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
    if (state === "active") created.start();
    else if (state === "background") {
      void created.flushPlayback();
      if (!playingHere() && Date.now() - lastPlayingAt > LISTENS_AFTER_PLAYING_MS) created.rest();
    }
  });
  created.start();
}

export function stopSync(): void {
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
  keysLevel = -1;
  void Player.followVolumeKeys(-1).catch(() => undefined);
  onPlaybackActivity(null);
  linkDevices(null);
  onLikesSent(null);
}

