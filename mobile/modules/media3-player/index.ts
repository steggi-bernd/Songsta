/** The native player (android/): commands in, one state event out. */
import type { ReactNode } from "react";
import type { ViewStyle } from "react-native";
import { NativeModule, requireNativeModule, requireNativeView } from "expo";

export type RepeatMode = "off" | "all" | "one";

export interface QueueItem {
  id: string;
  url: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  /** a loudness gain in dB; only ever lowers the volume */
  gainDb?: number;
}

export interface PlaybackState {
  isPlaying: boolean;
  /** asked to play: also true while it buffers */
  playWhenReady: boolean;
  isBuffering: boolean;
  isEnded: boolean;
  index: number;
  count: number;
  positionMs: number;
  durationMs: number;
  /** how fast the connection delivers while the player wants data; 0 before it has measured anything */
  bandwidthBps: number;
  /** what the sound goes through: decoder, output, speed */
  audio: string;
  repeat: RepeatMode;
}

export interface NetworkState {
  connected: boolean;
  /** it costs by the byte: mobile data, a phone's hotspot */
  metered: boolean;
}

/** Where the sound comes out; `name` only for what isn't the phone itself. */
export interface SoundOutput {
  kind: "phone" | "wired" | "bluetooth" | "tv";
  name: string;
}

/** A file in a picked folder, as the tags say; `unchanged` when it's the one already known. */
export interface LocalFileInfo {
  uri: string;
  unchanged?: boolean;
  name: string;
  /** within the folder */
  path: string;
  modified: number;
  size: number;
  title?: string | null;
  artist?: string | null;
  albumArtist?: string | null;
  album?: string | null;
  genre?: string | null;
  year?: number | null;
  track?: number | null;
  disc?: number | null;
  durationMs: number;
  bitrate?: number | null;
  sampleRate?: number | null;
  bits?: number | null;
  cover?: string | null;
  lyrics?: string | null;
}

/** A file picked in Android's own dialogs (Documents.kt). */
export interface PickedDocument {
  uri: string;
  name: string;
  /** bytes; -1 when the place doesn't say */
  size: number;
}

export interface DownloadJob {
  job: number;
  status: "waiting" | "wifi" | "running" | "done" | "failed";
  /** the server's HTTP status when it refused */
  reason: number;
  /** what went wrong, in words */
  problem: string;
  loaded: number;
  /** -1 when the server doesn't say */
  total: number;
}

/** The download notification's words, counted on the native side so they hold while the app is out of sight. */
export interface DownloadTexts {
  /** the notification channel's name in Android's settings */
  channel: string;
  /** while songs download */
  loading: string;
  /** "{done} of {total}" */
  progress: string;
  /** when a round is through */
  doneOne: string;
  /** "{count} songs downloaded" */
  doneMany: string;
  /** "{count} didn't download" */
  failed: string;
  /** under the count while nothing is fetched and songs wait for Wi-Fi */
  wifi: string;
}

type Events = {
  onState(state: PlaybackState): void;
  onError(error: { message: string; code?: string }): void;
  onNetwork(state: NetworkState): void;
  /** how far a new version of the app has come, and how that ended */
  onAppUpdate(news: { percent?: number; file?: string; problem?: string }): void;
  onOutput(output: SoundOutput): void;
  /** bytes from a connection to a device, or that it's gone */
  onSocket(news: { id: number; data?: string; closed?: boolean }): void;
  /** about once a second while devices on the network play */
  onZoneTick(news: Record<string, never>): void;
  /** a button in the notification of what they play, or the volume keys: "toggle", "next", "previous", "volume:NN" */
  onZoneControl(news: { action: string }): void;
  /** how far a look through a folder has come */
  onLocalScan(news: { folder: string; read: number; total: number }): void;
};

declare class Media3PlayerModule extends NativeModule<Events> {
  setAuth(server: string, headers: Record<string, string>, addresses: string[]): Promise<void>;
  setKeep24Bit(on: boolean, restart: boolean): Promise<void>;
  setGain(gainDb: number): Promise<void>;
  getNetwork(): Promise<NetworkState>;
  getOutput(): Promise<SoundOutput>;
  /** Android's own list of where the sound can go. */
  chooseOutput(): Promise<void>;
  /** One question (base64) to the local network and its answers within the time; null without Wi-Fi or a cable. */
  netAsk(address: string, port: number, question: string, waitMs: number): Promise<{ from: string; data: string }[] | null>;
  /** An encrypted connection to a device on the local network. */
  socketOpen(host: string, port: number, asThisApp: boolean): Promise<number>;
  socketWrite(id: number, data: string): Promise<void>;
  socketClose(id: number): Promise<void>;
  /** The key on the certificate of the device at the other end, in hex. */
  socketPeerKey(id: number): Promise<{ modulus: string; exponent: string } | null>;
  /** This app's own key for a TV's remote control, in hex; made the first time. */
  tvOwnKey(): Promise<{ modulus: string; exponent: string } | null>;
  /** A song from this phone's folders, for a device on the network: the address it fetches it from, on this phone (FileServer.kt). */
  fileShare(uri: string, mime: string, ext: string, deviceHost: string): Promise<string>;
  /** Nothing is handed out from here any more: devices stopped playing from this phone. */
  fileShareStop(): Promise<void>;
  /** `volume` is the lead device's, 0–100; below 0 when it can't be set from here. */
  zonesWatch(ticking: boolean, keepAwake: boolean, title: string, text: string, playing: boolean, volume: number): Promise<void>;
  /** Android's folder picker; null when somebody changed their mind. */
  pickFolder(): Promise<{ uri: string; name: string } | null>;
  /** Android's own picker; the chosen picture as a small data: address, or null. */
  pickImage(): Promise<string | null>;
  /** Android's own "save as": the file made where somebody chose, or null. `size` is -1 when the place doesn't say. */
  pickSaveDocument(name: string, mimeType: string): Promise<PickedDocument | null>;
  /** Android's own picker for a file to open, or null. */
  pickDocument(mimeTypes: string[]): Promise<PickedDocument | null>;
  /** Text into a file from pickSaveDocument, in place of what was in it. */
  writeText(uri: string, text: string): Promise<void>;
  localScan(folder: string, known: Record<string, number>): Promise<LocalFileInfo[]>;
  localForget(folder: string): Promise<void>;
  readText(uri: string): Promise<string | null>;
  setTuning(skipSilence: boolean, speed: number, fadeSeconds: number, seamless: boolean): Promise<void>;
  setEqualizer(on: boolean, bands: number[], gains: number[]): Promise<void>;
  restartApp(): Promise<void>;
  /** What a gesture feels like. */
  haptic(kind: "tick" | "press" | "arm" | "charge" | "charged" | "commit" | "cancel"): Promise<void>;
  /** The volume of music on this phone, 0 to 1. */
  getMediaVolume(): Promise<number>;
  setMediaVolume(level: number): Promise<void>;
  /** While steering another device, in front: the volume keys send "volume:N" to onZoneControl. Below 0: they're this phone's again. */
  followVolumeKeys(level: number): Promise<void>;
  /** Fetches a new version of the app; onAppUpdate says how it goes. */
  appUpdateFetch(url: string, fileName: string, sha256: string, size: number): Promise<void>;
  /** Hands it to Android, which asks before it installs. */
  appUpdateInstall(file: string): Promise<void>;
  appUpdateClear(): Promise<void>;
  /** Whether Android lets this app hand it something to install. */
  appUpdateAllowed(): Promise<boolean>;
  /** Android's page for that. */
  appUpdateAskToAllow(): Promise<void>;
  /** `label`: the song's name, for the notification while it downloads. */
  downloadStart(url: string, headers: Record<string, string>, fileName: string, wifiOnly: boolean, label: string): Promise<number>;
  /** The download notification's words in the app's language (SongDownloads.kt). */
  downloadTexts(texts: DownloadTexts): Promise<void>;
  downloadQuery(jobs: number[]): Promise<DownloadJob[]>;
  downloadFinish(job: number): Promise<{ file: string; bytes: number } | null>;
  downloadCancel(job: number): Promise<void>;
  downloadDelete(path: string): Promise<void>;
  downloadExisting(paths: string[]): Promise<string[]>;
  setQueue(items: QueueItem[], startIndex: number, startMs: number, play: boolean): Promise<void>;
  replaceUpcoming(items: QueueItem[]): Promise<void>;
  replaceCurrent(item: QueueItem, positionMs: number): Promise<void>;
  addItems(items: QueueItem[]): Promise<void>;
  insertItems(at: number, items: QueueItem[]): Promise<void>;
  removeItem(index: number): Promise<void>;
  moveItem(from: number, to: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  skipTo(index: number, play: boolean): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setRepeat(mode: RepeatMode): Promise<void>;
  getState(): Promise<PlaybackState>;
}

export default requireNativeModule<Media3PlayerModule>("Media3Player");

/** A page closed by pulling it down while its list is at the top (PullDownView.kt). */
export const PullDownView = requireNativeView<{ style?: ViewStyle; onClose?: () => void; children?: ReactNode }>("Media3Player", "PullDownView");
