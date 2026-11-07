/**
 * The devices around this phone and the music on them. The queue can play on a
 * device or a group of them instead of here (the player store doesn't care where
 * its commands go), and any other device can play music of its own next to that:
 * each of those is a zone (lib/zoneEngine.ts, one copy with the computer).
 *
 * A device fetches its songs from the server by itself, so the phone may go to
 * sleep; all it does is say what's next, once a second, on a tick from the native
 * side. Devices that only pair over Bluetooth (Echo, Fire TV) are listed for what
 * they are: no app can send them music directly.
 */
import { create } from "zustand";
import Player, { type QueueItem } from "../../modules/media3-player";
import { itemIdOf, streamUrl } from "../jellyfin";
import { ORIGINAL } from "../quality";
import {
  bringToInput,
  inputName,
  isNetworkInput,
  linksToFollow,
  OWN_INPUT,
  receiverInUse,
  sendToReceiver,
  TV_PAIRING_PORT,
  TV_REMOTE_PORT,
  TvCodeRefused,
  TvPairing,
  tvSecret,
  tvState,
  tvSwitchOff,
  wentOffToo,
  type DeviceLink,
  canSwitchOff,
  castPlayer,
  describeRenderer,
  devicesFromMdns,
  EndWatch,
  isLanUrl,
  jellyfinStreamPlan,
  MDNS_ADDRESS,
  MDNS_PORT,
  mdnsQuery,
  mimeOf,
  parseSsdp,
  readMdns,
  readPower,
  SSDP_ADDRESS,
  SSDP_PORT,
  SSDP_SEARCH,
  switchOffAt,
  SwitchOffs,
  upnpPlayer,
  utf8Bytes,
  utf8Text,
  Zone,
  type CastSocket,
  type DevicePlayer,
  type LeavingDevice,
  type MdnsService,
  type NetDevice,
  type Renderer,
  type Track,
  type ZoneDriver,
  type ZoneMember,
  type ZonePlayState,
  type ZoneSong,
} from "../shared";
import { readJson, writeJson } from "../storage";
import { useLibrary } from "./library";
import { outputChanged, setPlayHook, shuffled, switchOutput, toItem, usePlayer, zoneReport, type PlayerOutput } from "./player";
import { dropToast, toast } from "./popups";
import { here, useSession } from "./session";
import { useSettings } from "./settings";
import { T } from "../shared";

const FILE = "devices.json";
const SCAN_WAIT_MS = 2500;
const ASK_ONE_WAIT_MS = 1300;
/** A device that didn't answer this many looks in a row isn't around any more; UDP loses things. */
const FORGET_AFTER_MISSED = 3;
const CAST_PORT = 8009;
/** After a pause the notification stays this long, for going on from the lock screen. */
const PAUSED_KEEP_MS = 10 * 60_000;

export interface FoundDevice extends NetDevice {
  renderer?: Renderer;
  /** looks it didn't answer in a row */
  missed?: number;
  /** added by its address: looked for by that too */
  byHand?: string;
}

export interface ZoneView {
  id: string;
  /** it plays the queue; the others have music of their own */
  main: boolean;
  state: ZonePlayState;
  song: ZoneSong | null;
  error: string | null;
  members: { id: string; name: string; volume: number | null }[];
}

interface ZonesState {
  found: FoundDevice[];
  scanning: boolean;
  /** no Wi-Fi at the last look */
  noWifi: boolean;
  /** the device being connected to */
  connecting: string | null;
  names: Record<string, string>;
  zones: ZoneView[];
  /** the device the next song asked for goes to */
  pickingFor: FoundDevice | null;
  /** receivers the music has left, counting down */
  switchingOff: LeavingDevice[];
}

export const useZones = create<ZonesState>(() => ({ found: [], scanning: false, noWifi: false, connecting: null, names: {}, zones: [], pickingFor: null, switchingOff: [] }));

/** This phone as one of the devices of a group. */
export const THIS_PHONE: FoundDevice = { id: "this-phone", kind: "upnp", name: T("This phone"), model: "", host: "", port: 0 };
const isThisPhone = (d: { id: string }): boolean => d.id === THIS_PHONE.id;

export const canPlay = (d: NetDevice): boolean => d.kind === "upnp" || d.kind === "cast";
export const looksLikeTv = (d: NetDevice): boolean => d.kind === "firetv" || /\btv\b|shield|chromecast/i.test(`${d.model} ${d.name}`);
export const deviceName = (d: { id: string; name: string }, names: Record<string, string> = useZones.getState().names): string => names[d.id] ?? d.name;

function say(text: string): void {
  toast(text);
}

const messageOf = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

function saveDevices(): void {
  const { found, names } = useZones.getState();
  writeJson(FILE, { found, names });
}

/* ------------------------------------------------------------- bytes */

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------- looking around */

const renderedAs = (r: Renderer): FoundDevice => ({ id: r.id, kind: "upnp", name: r.name, model: r.model, host: new URL(r.avTransport.url).hostname, port: 0, location: r.location, renderer: r });

async function renderersIn(answers: { data: string }[]): Promise<FoundDevice[]> {
  const locations = new Set<string>();
  for (const answer of answers) {
    const location = parseSsdp(utf8Text(fromBase64(answer.data))).location;
    if (location && isLanUrl(location)) locations.add(location);
  }
  const found = await Promise.all([...locations].map((l) => describeRenderer(l).catch(() => null)));
  return found.filter((r): r is Renderer => !!r).map(renderedAs);
}

/** What answers at one address: a description's own URL, a Cast device's address and port, or just an address. */
async function lookAt(address: string): Promise<FoundDevice | null> {
  const text = address.trim();
  if (/^https?:\/\//i.test(text)) {
    const r = await describeRenderer(text).catch(() => null);
    return r ? { ...renderedAs(r), byHand: text } : null;
  }
  const [host, port] = text.split(":");
  if (!isLanUrl(`http://${host}/`)) return null;
  if (!port) {
    const answers = await Player.netAsk(host, SSDP_PORT, toBase64(utf8Bytes(SSDP_SEARCH)), ASK_ONE_WAIT_MS).catch(() => null);
    const [first] = await renderersIn(answers ?? []);
    if (first) return { ...first, byHand: text };
  }
  const device: FoundDevice = { id: `cast:${text}`, kind: "cast", name: T("Device at {host}", { host }), model: "Google Cast", host, port: Number(port) || CAST_PORT, byHand: text };
  const player = await castPlayer(device, openCastSocket).catch(() => null);
  if (!player) return null;
  player.close();
  return device;
}

let looking: Promise<void> | null = null;

/** Who's on the network now. What's known shows at once and stays while the answers come. */
export function scanDevices(): Promise<void> {
  looking ??= look().finally(() => {
    looking = null;
  });
  return looking;
}

async function look(): Promise<void> {
  useZones.setState({ scanning: true });
  try {
    const [ssdp, mdns] = await Promise.all([
      Player.netAsk(SSDP_ADDRESS, SSDP_PORT, toBase64(utf8Bytes(SSDP_SEARCH)), SCAN_WAIT_MS),
      Player.netAsk(MDNS_ADDRESS, MDNS_PORT, toBase64(mdnsQuery()), SCAN_WAIT_MS),
    ]);
    if (!ssdp || !mdns) {
      useZones.setState({ noWifi: true });
      return;
    }
    const services = new Map<string, MdnsService>();
    for (const answer of mdns) readMdns(fromBase64(answer.data), answer.from, services);
    const known = useZones.getState().found;
    const [renderers, others, byHand] = await Promise.all([
      renderersIn(ssdp),
      devicesFromMdns(services.values()),
      Promise.all(known.filter((d) => d.byHand).map((d) => lookAt(d.byHand as string).catch(() => null))),
    ]);
    const answered = new Map<string, FoundDevice>();
    for (const d of [...renderers, ...others]) answered.set(d.id, d);
    for (const d of byHand) if (d) answered.set(d.id, { ...answered.get(d.id), ...d });
    const inUse = new Set(useZones.getState().zones.flatMap((z) => z.members.map((m) => m.id)));
    const stillThere = known
      .filter((d) => !answered.has(d.id))
      .map((d) => ({ ...d, missed: (d.missed ?? 0) + 1 }))
      .filter((d) => d.byHand || inUse.has(d.id) || d.missed < FORGET_AFTER_MISSED);
    useZones.setState({ found: [...answered.values(), ...stillThere], noWifi: false });
    saveDevices();
  } catch (err) {
    say(messageOf(err, T("Couldn't look around the network")));
  } finally {
    useZones.setState({ scanning: false });
  }
}

/** A device that doesn't announce itself, say on a network that blocks that. Answers its name, or null when nothing answers there. */
export async function addDeviceByAddress(address: string): Promise<string | null> {
  const device = await lookAt(address).catch(() => null);
  if (!device) return null;
  useZones.setState((s) => ({ found: [device, ...s.found.filter((d) => d.id !== device.id)] }));
  saveDevices();
  return device.name;
}

export function forgetDevice(id: string): void {
  useZones.setState((s) => ({ found: s.found.filter((d) => d.id !== id) }));
  saveDevices();
}

export function renameDevice(d: FoundDevice, name: string): void {
  const names = { ...useZones.getState().names };
  const wanted = name.trim();
  if (wanted && wanted !== d.name) names[d.id] = wanted;
  else delete names[d.id];
  useZones.setState({ names });
  saveDevices();
  publish();
}

/* ------------------------------------------------------------- connections to Cast devices */

interface OpenSocket {
  data: ((bytes: Uint8Array) => void) | null;
  close: (() => void) | null;
  /** what came before anybody listened */
  early: Uint8Array[];
  closed: boolean;
}

const sockets = new Map<number, OpenSocket>();

function socketEntry(id: number): OpenSocket {
  let entry = sockets.get(id);
  if (!entry) {
    entry = { data: null, close: null, early: [], closed: false };
    sockets.set(id, entry);
  }
  return entry;
}

async function openCastSocket(host: string, port: number): Promise<CastSocket> {
  return socketOn(await Player.socketOpen(host, port, false));
}

function socketOn(id: number): CastSocket {
  const entry = socketEntry(id);
  return {
    write: (bytes) => void Player.socketWrite(id, toBase64(bytes)).catch(() => undefined),
    close: () => void Player.socketClose(id).catch(() => undefined),
    onData(listener) {
      entry.data = listener;
      for (const bytes of entry.early.splice(0)) listener(bytes);
    },
    onClose(listener) {
      entry.close = listener;
      if (entry.closed) listener();
    },
  };
}

/* ------------------------------------------------------------- zones */

interface Running {
  id: string;
  zone: Zone;
  main: boolean;
}

const running = new Map<string, Running>();

/** A device set by hand to play further ahead or behind: its group is looked at again. */
let aheadBefore = useSettings.getState().playAhead;
useSettings.subscribe((s) => {
  if (s.playAhead === aheadBefore) return;
  const changed = new Set([...Object.keys(s.playAhead), ...Object.keys(aheadBefore)].filter((id) => s.playAhead[id] !== aheadBefore[id]));
  aheadBefore = s.playAhead;
  for (const r of running.values()) if (r.zone.members.some((m) => changed.has(m.deviceId))) r.zone.retune();
});
let nextZone = 1;
/** songs of the zones with music of their own, which needn't be in the library's list */
const songsKnown = new Map<string, Track>();

const mainZone = (): Running | undefined => [...running.values()].find((r) => r.main);

function trackOf(id: string): Track | undefined {
  return songsKnown.get(id) ?? useLibrary.getState().byId.get(id) ?? usePlayer.getState().queue.find((t) => t.id === id);
}

/** Where a device gets a song: from the server's address at home, by itself. */
function whereToGet(song: ZoneSong): { url: string; mime: string; mark: string } {
  const session = useSession.getState().session;
  const track = trackOf(song.id);
  if (!track || track.localPath) throw new Error(`"${song.title}" is only on this phone, so a device can't fetch it`);
  if (!session) throw new Error(`"${song.title}" can't be played there`);
  const plan = jellyfinStreamPlan(track);
  const ext = plan !== "static" ? plan : (track.container ?? "").split(",")[0].trim().toLowerCase() || "flac";
  return { url: streamUrl({ ...session, server: session.home ?? session.server }, track, ORIGINAL), mime: mimeOf(`.${ext}`), mark: itemIdOf(track) };
}

function driverFor(player: DevicePlayer, deviceId: string): ZoneDriver {
  const watch = new EndWatch();
  let playing: { song: ZoneSong; mark: string } | null = null;
  return {
    async load(song, position, play) {
      const { url, mime, mark } = whereToGet(song);
      playing = { song, mark };
      watch.begin(position);
      await player.load(url, { ...song, mime }, position, play);
    },
    play: async () => void (await player.play()),
    pause: async () => void (await player.pause()),
    stop: async () => void (await player.stop()),
    async seek(sec) {
      watch.moved(sec);
      await player.seek(sec);
    },
    starting: () => player.starting(),
    async status() {
      const at = await player.status();
      if (at.notStarted) return { state: "stopped", position: at.position, duration: at.duration, ended: false, notStarted: true };
      // A report about the song before (players switch over in their own time) says nothing about this one.
      if (playing && at.uri && !at.uri.includes(playing.mark)) return { state: "loading", position: 0, duration: playing.song.duration, ended: false };
      return watch.see(at, playing?.song.duration ?? 0);
    },
    setVolume: async (level) => void (await player.setVolume(level * 100)),
    async getVolume() {
      const v = await player.getVolume();
      return v === null ? null : v / 100;
    },
    async place() {
      const at = await player.status();
      return at.state === "PLAYING" ? at.position : null;
    },
    playAhead: () => (useSettings.getState().playAhead[deviceId] ?? 0) / 1000,
    close: () => player.close(),
  };
}

/** This phone playing along: one song at a time, as a device gets them. */
function phoneMember(): ZoneMember {
  let endTold = false;
  const driver: ZoneDriver = {
    async load(song, position, play) {
      const track = trackOf(song.id);
      if (!track) throw new Error(`"${song.title}" can't be played here`);
      endTold = false;
      await Player.setQueue([toItem(track)], 0, position * 1000, play);
    },
    play: () => Player.play(),
    pause: () => Player.pause(),
    async stop() {
      await Player.pause();
      await Player.setQueue([], 0, 0, false);
    },
    seek: (sec) => Player.seekTo(sec * 1000),
    async status() {
      const s = await Player.getState();
      const ended = s.isEnded && !endTold;
      if (ended) endTold = true;
      return {
        state: s.isEnded || !s.count ? "stopped" : s.isBuffering ? "loading" : s.isPlaying ? "playing" : "paused",
        position: s.positionMs / 1000,
        duration: s.durationMs / 1000,
        ended,
      };
    },
    // Its volume is the phone's own, with its keys.
    setVolume: async () => undefined,
    getVolume: async () => null,
    async place() {
      const s = await Player.getState();
      return s.isPlaying ? s.positionMs / 1000 : null;
    },
    nearby: true,
    playAhead: () => (useSettings.getState().playAhead[THIS_PHONE.id] ?? 0) / 1000,
    close: () => undefined,
  };
  return { deviceId: THIS_PHONE.id, name: THIS_PHONE.name, driver, volume: null };
}

async function memberFor(d: FoundDevice): Promise<ZoneMember> {
  if (isThisPhone(d)) return phoneMember();
  let player: DevicePlayer;
  if (d.kind === "cast") player = await castPlayer(d, openCastSocket);
  else if (d.kind === "upnp" && (d.renderer || d.location)) {
    const renderer = d.renderer ?? (await describeRenderer(d.location as string));
    if (!renderer) throw new Error(T("{name} doesn't answer", { name: deviceName(d) }));
    player = upnpPlayer(renderer);
  } else throw new Error(`${deviceName(d)} can only be reached over Bluetooth`);
  const driver = driverFor(player, d.id);
  // Its volume stays where it is: the slider shows it, and only moving the slider changes it.
  const volume = await driver.getVolume().catch(() => null);
  return { deviceId: d.id, name: deviceName(d), driver, volume };
}

/** With somebody at the door the button shows a wheel; failing, it says why. */
async function connecting<T>(d: FoundDevice, work: () => Promise<T>): Promise<T | null> {
  useZones.setState({ connecting: d.id });
  try {
    return await work();
  } catch (err) {
    say(messageOf(err, T("{name} doesn't answer", { name: deviceName(d) })));
    return null;
  } finally {
    useZones.setState({ connecting: null });
  }
}

function view(r: Running): ZoneView {
  const { state, queue, index, error } = r.zone.state;
  return {
    id: r.id,
    main: r.main,
    state,
    song: queue[index] ?? null,
    error,
    members: r.zone.members.map((m) => ({ id: m.deviceId, name: useZones.getState().names[m.deviceId] ?? m.name, volume: m.volume })),
  };
}

function reportMain(r: Running): void {
  const s = r.zone.state;
  zoneReport({
    isPlaying: s.state === "playing",
    playWhenReady: s.state === "playing" || s.state === "loading",
    isBuffering: s.state === "loading",
    isEnded: !!s.ranOut,
    index: s.index,
    count: s.queue.length,
    positionMs: s.position * 1000,
    durationMs: s.duration * 1000,
    bandwidthBps: 0,
    audio: "",
    repeat: s.repeat,
  });
  if (usePlayer.getState().error !== s.error) usePlayer.setState({ error: s.error });
  const first = r.zone.members[0];
  if (first) {
    const name = useZones.getState().names[first.deviceId] ?? first.name;
    outputChanged({ id: first.deviceId, name: r.zone.members.length > 1 ? `${name} +${r.zone.members.length - 1}` : name, tv: isTv(first.deviceId) });
  }
}

const isTv = (id: string): boolean => {
  const d = useZones.getState().found.find((f) => f.id === id);
  return !!d && looksLikeTv(d);
};

/** A zone whose devices all stopped answering is over. */
function dropEmptyZones(): void {
  for (const r of [...running.values()]) {
    if (r.zone.members.length) continue;
    running.delete(r.id);
    if (r.zone.state.error) say(r.zone.state.error);
    if (r.main) switchOutput(null, false);
  }
}

const hostOf = (id: string): string | undefined => useZones.getState().found.find((d) => d.id === id)?.host;

function devicesWithMusic(): Set<string> {
  const on = new Set<string>();
  for (const r of running.values()) for (const m of r.zone.members) if (!isThisPhone({ id: m.deviceId })) on.add(m.deviceId);
  return on;
}

/** The word that went out about each one that's counting: out of date once it stops. */
const said = new Map<string, string>();

const isPairedTv = (id: string): boolean => useSettings.getState().pairedTvs.includes(id);

const tvRemoteAt = (host: string) => async (): Promise<CastSocket> => socketOn(await Player.socketOpen(host, TV_REMOTE_PORT, true));

const offs = new SwitchOffs({
  readPower: async (id) => {
    const host = hostOf(id);
    if (!host) return null;
    if (!isPairedTv(id)) return readPower(host);
    const state = await tvState(tvRemoteAt(host));
    return state && { on: state.on, input: "", tv: true, busy: state.busy };
  },
  switchOff: async (id) => {
    const host = hostOf(id);
    if (!host) return false;
    return isPairedTv(id) ? tvSwitchOff(tvRemoteAt(host)) : switchOffAt(host);
  },
  afterSwitchedOff: (id) => watchReceiverStaysOn(id),
  inUse: (id) => receiverInUse(id, devicesWithMusic(), useSettings.getState().deviceLinks),
  changed: (switchingOff) => {
    useZones.setState({ switchingOff });
    for (const [id, text] of said) {
      if (switchingOff.some((d) => d.id === id)) continue;
      said.delete(id);
      dropToast(text);
    }
    keepAlive();
  },
  counting: (d) => {
    const text = T("{name} switches off in 30 seconds", { name: d.name });
    said.set(d.id, text);
    toast(text, true, { label: T("Keep on"), run: () => offs.forget(d.id) }, 12_000);
  },
});

export const keepDeviceOn = (id: string): void => offs.forget(id);

/** By hand: its music stops first, if it has any. */
export async function switchDeviceOff(d: FoundDevice): Promise<void> {
  const asked = offs.switchOffNow(d.id);
  const main = mainZone();
  if (main?.zone.members.length === 1 && main.zone.members[0].deviceId === d.id) moveMusicHere();
  else await freeDevice(d.id);
  const name = deviceName(d);
  say((await asked) ? T("{name} is switching off", { name }) : T("{name} didn't take that", { name }));
}

const comingAlong = new Set<string>();

/** Music on a device that hangs on a receiver: the receiver comes along, on and on that input. */
async function bringReceiverAlong(link: DeviceLink): Promise<void> {
  const host = hostOf(link.receiver);
  if (!host || comingAlong.has(link.receiver)) return;
  comingAlong.add(link.receiver);
  const receiver = useZones.getState().found.find((d) => d.id === link.receiver);
  const words = { name: receiver ? deviceName(receiver) : link.receiver, input: inputName(link.input) };
  const wanted = (): boolean => {
    const now = devicesWithMusic();
    return now.has(link.device) && !now.has(link.receiver);
  };
  try {
    const there = await bringToInput({ read: () => readPower(host), send: (word) => sendToReceiver(host, word) }, link.input, wanted, { onSwitching: () => say(T("{name} is switching to {input}", words)) });
    if (!there && wanted()) say(T("{name} didn't switch to {input}", words));
  } finally {
    comingAlong.delete(link.receiver);
  }
}

/** This device hangs on that input from now on. With music on it already, the receiver follows right away. */
export function plugInto(d: FoundDevice, receiver: FoundDevice, input: string): void {
  const link = { device: d.id, receiver: receiver.id, input };
  const { deviceLinks, change } = useSettings.getState();
  change({ deviceLinks: [...deviceLinks.filter((l) => l.device !== d.id), link] });
  say(T("{device} hangs on {name} now: {input}. It switches over with the music.", { device: deviceName(d), name: deviceName(receiver), input: inputName(input) }));
  if (linksToFollow(devicesWithMusic(), new Set(), [link]).length) {
    offs.forget(receiver.id);
    void bringReceiverAlong(link);
  }
}

/** The input the receiver stands on right now: for when nobody knows what it's called. */
export async function plugIntoWhereItIs(d: FoundDevice, receiver: FoundDevice): Promise<void> {
  const power = await readPower(receiver.host);
  if (power?.input) plugInto(d, receiver, power.input);
  else say(T("{name} doesn't say which input it's on", { name: deviceName(receiver) }));
}

export function unplug(id: string): void {
  const { deviceLinks, change } = useSettings.getState();
  change({ deviceLinks: deviceLinks.filter((l) => l.device !== id) });
}

/**
 * A receiver handed a song goes to its own player by itself on the models tried so far: a moment
 * for that, and then it's told, for any where that isn't so.
 */
const OWN_INPUT_AFTER_MS = 3000;

async function backToOwnInput(id: string): Promise<void> {
  const d = useZones.getState().found.find((f) => f.id === id);
  if (!d?.host || !canSwitchOff(d.model) || comingAlong.has(id)) return;
  const host = d.host;
  await new Promise((done) => setTimeout(done, OWN_INPUT_AFTER_MS));
  await bringToInput({ read: () => readPower(host), send: (word) => sendToReceiver(host, word) }, OWN_INPUT, () => devicesWithMusic().has(id), { accept: isNetworkInput, noWaking: true });
}

/** The TV is off and the receiver has music: over HDMI it can go off along with it. */
function watchReceiverStaysOn(tv: string): void {
  const link = useSettings.getState().deviceLinks.find((l) => l.device === tv);
  const host = link && hostOf(link.receiver);
  if (!link || !host || !devicesWithMusic().has(link.receiver)) return;
  const receiver = useZones.getState().found.find((d) => d.id === link.receiver);
  void wentOffToo(() => readPower(host), () => devicesWithMusic().has(link.receiver)).then((went) => {
    if (!went) return;
    void sendToReceiver(host, "PWON");
    toast(T("{name} went off along with the TV. Set \"Pow.Off Control\" to \"Video\" in its HDMI setup, and it stays on with its music.", { name: receiver ? deviceName(receiver) : link.receiver }), true, undefined, 15_000);
  });
}

/** The one pairing that can be under way: the TV shows its code once it has started. */
let pairing: { tv: TvPairing; socketId: number; device: FoundDevice } | null = null;

export function cancelPairing(): void {
  pairing?.tv.close();
  pairing = null;
}

export async function startPairing(d: FoundDevice): Promise<boolean> {
  cancelPairing();
  try {
    const socketId = await Player.socketOpen(d.host, TV_PAIRING_PORT, true);
    const tv = new TvPairing(socketOn(socketId), "Songsta");
    pairing = { tv, socketId, device: d };
    await tv.start();
    return true;
  } catch {
    cancelPairing();
    say(T("{name} doesn't answer to that. It has to be switched on, and be a Google TV or Android TV.", { name: deviceName(d) }));
    return false;
  }
}

/** Answers whether to ask again: the code was mistyped, and the TV still shows it. */
export async function finishPairing(code: string): Promise<boolean> {
  if (!pairing) return false;
  const { tv, socketId, device } = pairing;
  const name = deviceName(device);
  const [own, theirs] = await Promise.all([Player.tvOwnKey().catch(() => null), Player.socketPeerKey(socketId).catch(() => null)]);
  const secret = own && theirs ? tvSecret(own, theirs, code) : null;
  if (!secret) return true;
  try {
    await tv.finish(secret);
    const { pairedTvs, change } = useSettings.getState();
    change({ pairedTvs: [...pairedTvs.filter((id) => id !== device.id), device.id] });
    say(T("{name} can be switched off from here now", { name }));
  } catch (err) {
    say(err instanceof TvCodeRefused ? T("{name} didn't take that code. Start again for a new one.", { name }) : T("{name} doesn't answer to that. It has to be switched on, and be a Google TV or Android TV.", { name }));
  }
  cancelPairing();
  return false;
}

let onDevices = new Set<string>();

function seeDevices(): void {
  const now = devicesWithMusic();
  const { found, names } = useZones.getState();
  const wanted = useSettings.getState().switchOffDevices;
  offs.sawDevices(now, onDevices, (id) => {
    const d = found.find((f) => f.id === id);
    return d ? { name: names[id] ?? d.name, canSwitchOff: wanted && (canSwitchOff(d.model) || isPairedTv(id)) } : null;
  }, useSettings.getState().deviceLinks);
  for (const id of now) if (!onDevices.has(id)) void backToOwnInput(id);
  for (const link of linksToFollow(now, onDevices, useSettings.getState().deviceLinks)) {
    offs.forget(link.receiver);
    void bringReceiverAlong(link);
  }
  onDevices = now;
}

function publish(): void {
  dropEmptyZones();
  useZones.setState({ zones: [...running.values()].map(view) });
  seeDevices();
  const main = mainZone();
  if (main) reportMain(main);
  keepAlive();
}

let pausedSince = 0;
let lastKeep = "";

const isOn = (r: Running): boolean => r.zone.state.state === "playing" || r.zone.state.state === "loading";

/** The phone's volume keys: a group goes up and down together, each from where it is. */
function keysSetVolume(r: Running, level: number): void {
  const first = r.zone.members[0]?.volume;
  if (typeof first !== "number") return;
  const by = level - first;
  for (const m of r.zone.members) if (m.volume !== null) void r.zone.setVolume(m.deviceId, Math.max(0, Math.min(1, m.volume + by)));
}

function keepAlive(): void {
  const all = [...running.values()];
  // Nothing plays any more, but a receiver waits to go off: somebody has to be awake for that.
  const leaving = useZones.getState().switchingOff[0];
  if (!all.length && leaving) {
    const text = T("{name} switches off in 30 seconds", { name: leaving.name });
    if (lastKeep === text) return;
    lastKeep = text;
    void Player.zonesWatch(true, true, "Songsta", text, false, -1).catch(() => undefined);
    return;
  }
  const on = all.filter(isOn);
  if (on.length) pausedSince = 0;
  else if (!pausedSince) pausedSince = Date.now();
  const lead = on.find((r) => r.main) ?? on[0] ?? all.find((r) => r.main) ?? all[0];
  const song = lead?.zone.state.queue[lead.zone.state.index];
  const keepAwake = !!song && (on.length > 0 || Date.now() - pausedSince < PAUSED_KEEP_MS);
  const names = lead?.zone.members.map((m) => m.name).join(" + ") ?? "";
  const title = song?.title ?? "Songsta";
  const waking = lead?.zone.state.state === "loading";
  const text = `${waking ? T("Waiting for") : on.length ? T("Playing on") : T("Paused on")} ${names}${on.length > 1 ? T(" ({count} zones)", { count: on.length }) : ""}`;
  const firstVolume = lead?.zone.members[0]?.volume;
  const volume = typeof firstVolume === "number" ? Math.round(firstVolume * 100) : -1;
  const key = JSON.stringify([all.length > 0, keepAwake, title, text, on.length > 0, volume]);
  if (key === lastKeep) return;
  lastKeep = key;
  void Player.zonesWatch(all.length > 0, keepAwake, title, text, on.length > 0, volume).catch(() => undefined);
}

function newZone(member: ZoneMember, main: boolean): Running {
  const r: Running = { id: `zone${nextZone++}`, main, zone: new Zone([member], publish) };
  running.set(r.id, r);
  return r;
}

/** How the queue's commands reach a zone: the same calls the phone's own player takes. */
function outputOf(zone: Zone): PlayerOutput {
  const songOf = (item: QueueItem): ZoneSong => {
    const t = trackOf(item.id);
    return { id: item.id, title: item.title, artist: item.artist, album: item.album, duration: t?.duration ?? 0, art: t?.thumb ? here(t.thumb) : undefined };
  };
  return {
    setQueue: (items, start, startMs, play) => zone.play(items.map(songOf), start, startMs / 1000, play),
    replaceUpcoming: async (items) => zone.setUpcoming(items.map(songOf)),
    // A device always gets the file itself: there's no other copy to change to.
    replaceCurrent: async () => undefined,
    addItems: async (items) => zone.insert(zone.state.queue.length, items.map(songOf)),
    insertItems: async (at, items) => zone.insert(at, items.map(songOf)),
    removeItem: async (index) => zone.remove(index),
    moveItem: async (from, to) => zone.move(from, to),
    play: async () => {
      if (zone.state.state !== "playing" && zone.state.state !== "loading") await zone.toggle();
    },
    pause: () => zone.pause(),
    seekTo: (ms) => zone.seek(ms / 1000),
    skipTo: (index, play) => zone.play(zone.state.queue, index, 0, play),
    next: () => zone.next(),
    previous: () => zone.previous(),
    setRepeat: async (mode) => zone.setRepeat(mode),
    setGain: async () => undefined,
  };
}

/** The device stops what it's doing for a zone: it's about to do something else. */
async function freeDevice(id: string): Promise<void> {
  for (const r of [...running.values()]) {
    if (!r.zone.members.some((m) => m.deviceId === id)) continue;
    await r.zone.leave(id);
    // Its last device gone, the zone is over: see dropEmptyZones.
  }
  publish();
}

/** One press: the music moves there and goes on from where it is. */
export async function moveMusicTo(d: FoundDevice): Promise<void> {
  const before = mainZone();
  if (before?.zone.members.length === 1 && before.zone.members[0].deviceId === d.id) return;
  await connecting(d, async () => {
    const member = await memberFor(d);
    // Elsewhere in a zone of its own: that ends here.
    await freeDevice(d.id);
    const old = mainZone();
    if (old) {
      running.delete(old.id);
      void old.zone.stop();
    }
    const r = newZone(member, true);
    switchOutput({ output: outputOf(r.zone), device: { id: d.id, name: deviceName(d), tv: isTv(d.id) } });
    publish();
  });
}

/** Back to this phone, where the device stands. */
export function moveMusicHere(): void {
  const main = mainZone();
  if (!main) return;
  running.delete(main.id);
  main.zone.members = main.zone.members.filter((m) => !isThisPhone({ id: m.deviceId }));
  void main.zone.stop();
  switchOutput(null);
  publish();
}

/** Several at once: the music goes to the first and the others play along. This phone is never the one the others go by. */
export async function moveMusicToMany(devices: FoundDevice[]): Promise<void> {
  const others = devices.filter((d) => !isThisPhone(d));
  if (!others.length) {
    moveMusicHere();
    return;
  }
  await moveMusicTo(others[0]);
  const main = mainZone();
  if (!main) return;
  for (const d of [...others.slice(1), ...devices.filter(isThisPhone)]) await playAlong(main.id, d);
}

/** To another device with Songsta on it, which plays on from here. */
export async function sendMusicToDevice(id: string, name: string): Promise<void> {
  const { queue, sendTo } = usePlayer.getState();
  if (!queue.length) {
    say(T("Nothing to send: start a song first"));
    return;
  }
  const sent = await sendTo(id);
  say(sent ? T("Playing on {name}", { name }) : T("{name} can't be reached right now", { name }));
  const main = sent ? mainZone() : undefined;
  if (main) {
    running.delete(main.id);
    switchOutput(null, false);
    void main.zone.stop();
    publish();
  }
}

/** Another device plays along in a zone: the same song, from where the others are. */
export async function playAlong(zoneId: string, d: FoundDevice): Promise<void> {
  const r = running.get(zoneId);
  if (!r) return;
  await connecting(d, async () => {
    const member = await memberFor(d);
    await freeDevice(d.id);
    await r.zone.join(member);
    publish();
  });
}

export async function stopPlayingAlong(zoneId: string, deviceId: string): Promise<void> {
  const r = running.get(zoneId);
  if (!r) return;
  if (r.zone.members.length === 1) {
    if (r.main) moveMusicHere();
    else await zoneStop(zoneId);
    return;
  }
  await r.zone.leave(deviceId);
  publish();
}

export async function zoneStop(zoneId: string): Promise<void> {
  const r = running.get(zoneId);
  if (!r) return;
  if (r.main) {
    moveMusicHere();
    return;
  }
  running.delete(zoneId);
  await r.zone.stop();
  publish();
}

export function zoneToggle(zoneId: string): void {
  const r = running.get(zoneId);
  if (r?.main) usePlayer.getState().toggle();
  else void r?.zone.toggle();
}

export function zoneNext(zoneId: string): void {
  const r = running.get(zoneId);
  if (r?.main) usePlayer.getState().next();
  else void r?.zone.next();
}

export function zonePrevious(zoneId: string): void {
  const r = running.get(zoneId);
  if (r?.main) usePlayer.getState().previous();
  else void r?.zone.previous();
}

export function zoneVolume(zoneId: string, deviceId: string, level: number): void {
  void running.get(zoneId)?.zone.setVolume(deviceId, Math.max(0, Math.min(1, level)));
}

/* ------------------------------------------------------------- music of its own */

/** Music of their own: the first device takes it, the others play along with it. */
export async function startOwnMusicOn(devices: FoundDevice[], tracks: Track[], start = 0, shuffle = false): Promise<void> {
  const [first, ...rest] = devices;
  if (!first || !tracks.length) return;
  await startOwnMusic(first, tracks, start, shuffle);
  const zone = [...running.values()].find((r) => !r.main && r.zone.members.some((m) => m.deviceId === first.id));
  if (zone) for (const d of rest) await playAlong(zone.id, d);
}

async function startOwnMusic(d: FoundDevice, tracks: Track[], start: number, shuffle: boolean): Promise<void> {
  const { muted } = useLibrary.getState();
  const asked = tracks[Math.max(0, Math.min(start, tracks.length - 1))];
  const open = tracks.filter((t) => t === asked || !muted.has(t.id));
  const list = shuffle ? [asked, ...shuffled(open.filter((t) => t !== asked))] : open;
  for (const t of list) songsKnown.set(t.id, t);
  const songs = list.map((t): ZoneSong => ({ id: t.id, title: t.title, artist: t.artist, album: t.album ?? "", duration: t.duration, art: t.thumb ? here(t.thumb) : undefined }));
  await connecting(d, async () => {
    const already = [...running.values()].find((r) => !r.main && r.zone.members.some((m) => m.deviceId === d.id));
    const r = already ?? newZone(await memberForFreed(d), false);
    await r.zone.play(songs, list.indexOf(asked));
    publish();
    say(T("Playing on {deviceName}", { deviceName: deviceName(d) }));
  });
}

async function memberForFreed(d: FoundDevice): Promise<ZoneMember> {
  const member = await memberFor(d);
  await freeDevice(d.id);
  return member;
}

/** The next song or list asked for anywhere in the app goes to this device. */
export function pickMusicFor(d: FoundDevice | null, others: FoundDevice[] = []): void {
  useZones.setState({ pickingFor: d });
  setPlayHook(
    d
      ? (tracks, start, shuffle) => {
          useZones.setState({ pickingFor: null });
          setPlayHook(null);
          void startOwnMusicOn([d, ...others], tracks, start, shuffle);
          return true;
        }
      : null
  );
}

/* ------------------------------------------------------------- for the app's lifetime */

export function watchZones(): void {
  void readJson<{ found?: FoundDevice[]; names?: Record<string, string> }>(FILE).then((saved) => {
    if (saved) useZones.setState({ found: saved.found ?? [], names: saved.names ?? {} });
  });
  Player.addListener("onSocket", ({ id, data, closed }) => {
    const entry = socketEntry(id);
    if (data) {
      const bytes = fromBase64(data);
      if (entry.data) entry.data(bytes);
      else entry.early.push(bytes);
    }
    if (closed) {
      entry.closed = true;
      entry.close?.();
      sockets.delete(id);
    }
  });
  Player.addListener("onZoneTick", () => {
    for (const r of running.values()) void r.zone.tick();
    keepAlive();
  });
  Player.addListener("onZoneControl", ({ action }) => {
    const lead = [...running.values()].find((r) => r.main && isOn(r)) ?? [...running.values()].find(isOn) ?? mainZone() ?? [...running.values()][0];
    // No zones: the volume keys while another device with Songsta on it is followed.
    if (!lead) {
      if (action.startsWith("volume:")) usePlayer.getState().setRemoteVolume(Number(action.slice(7)) / 100);
      return;
    }
    if (action.startsWith("volume:")) keysSetVolume(lead, Number(action.slice(7)) / 100);
    else if (action === "toggle") zoneToggle(lead.id);
    else if (action === "next") zoneNext(lead.id);
    else zonePrevious(lead.id);
  });
  // Signed out: nothing plays on anybody's behalf any more.
  useSession.subscribe((s, prev) => {
    if (s.session || !prev.session) return;
    for (const r of [...running.values()]) void zoneStop(r.id);
  });
}
