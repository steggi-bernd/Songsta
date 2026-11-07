/**
 * Zones on this computer: a network device playing music of its own, apart from
 * what the app itself plays (lib/zoneEngine.ts, one copy with the phone). Each is
 * a casting session of its own in the main process, which serves the songs.
 *
 * "Play something else here": the next song or list asked for anywhere in the app
 * goes to that device instead of starting here.
 */
import { create } from "zustand";
import type { CastMember, CastStatus } from "../../electron/cast";
import { isMuted } from "../stores/muted";
import { setPlayHook } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { requireBridge } from "./bridge";
import { leaveCast, useCast, type CastDevice } from "./cast";
import { offerFirewall } from "./deviceFirewall";
import { ipcErrorText } from "./ipcError";
import { playableVersions } from "./librarySource";
import { Zone, type ZoneDriver, type ZoneSong, type ZoneState } from "./zoneEngine";
import { T } from "./i18n";

const TICK_MS = 1000;
const CASTABLE = /^(local|jf|ss):/;

export interface ZoneView {
  id: string;
  device: CastDevice;
  state: ZoneState;
  members: CastMember[];
}

interface ZonesState {
  zones: ZoneView[];
  /** the device the next song asked for goes to */
  pickingFor: CastDevice | null;
  /** those that play along with it */
  pickingWith: CastDevice[];
}

export const useZones = create<ZonesState>(() => ({ zones: [], pickingFor: null, pickingWith: [] }));

interface Running {
  id: string;
  device: CastDevice;
  zone: Zone;
  tracks: Map<string, Track>;
  timer: number;
  status: CastStatus | null;
  ended: boolean;
  /** the session's only device never started the song */
  notStarted: boolean;
}

const running = new Map<string, Running>();
let nextId = 1;
let listening = false;

function publish(): void {
  useZones.setState({
    // One still connecting has no zone yet; the session's first word can come before it does.
    zones: [...running.values()].filter((r) => r.zone).map((r) => ({ id: r.id, device: r.device, state: r.zone.state, members: r.status?.members ?? [] })),
  });
}

function listen(): void {
  if (listening) return;
  listening = true;
  requireBridge().onCastStatus((st) => {
    const r = running.get(st.session);
    if (!r) return;
    r.status = st;
    if (st.ended) r.ended = true;
    if (st.unreachable) void offerFirewall(st.unreachable.name);
    if (st.notStarted) {
      // Others left: it just went from the group.
      if (st.members.some((m) => m.id !== st.notStarted?.id)) useUI.getState().toast(T("{name} didn't start. Is it switched on?", { name: st.notStarted.name }), "error");
      else r.notStarted = true;
    }
    publish();
  });
}

const toSong = (t: Track): ZoneSong => ({ id: t.id, title: t.title, artist: t.artist, album: t.album ?? "", duration: t.duration, art: t.thumb });

function driverOf(r: Pick<Running, "id" | "tracks" | "status" | "ended" | "notStarted">): ZoneDriver {
  const bridge = requireBridge();
  const session = r.id;
  return {
    async load(song, position, play) {
      const track = r.tracks.get(song.id);
      let failure: unknown = new Error(`"${song.title}" can't be played there`);
      for (const version of track ? playableVersions(track) : []) {
        if (!CASTABLE.test(version.id)) continue;
        try {
          await bridge.castLoad({ id: version.id, title: song.title, artist: song.artist, album: song.album, duration: song.duration, art: song.art }, position, play, session);
          return;
        } catch (err) {
          failure = err;
        }
      }
      throw failure;
    },
    play: () => bridge.castControl("play", 0, session),
    pause: () => bridge.castControl("pause", 0, session),
    stop: () => bridge.castStop(session),
    seek: (sec) => bridge.castControl("seek", sec, session),
    async status() {
      const st = r.status;
      if (!st || st.message) throw new Error(st?.message ?? "No answer yet");
      const ended = r.ended;
      const notStarted = r.notStarted;
      r.ended = false;
      r.notStarted = false;
      return { state: st.state, position: st.position, duration: st.duration, ended, notStarted };
    },
    setVolume: (level) => bridge.castControl("volume", level, session),
    getVolume: async () => r.status?.volume ?? null,
    close: () => undefined,
  };
}

/** Music of its own on this device; a zone already there just gets the new songs. */
export async function startZone(device: CastDevice, tracks: Track[], start = 0): Promise<string | null> {
  listen();
  const asked = tracks[Math.max(0, Math.min(start, tracks.length - 1))];
  const list = tracks.filter((t) => t === asked || !isMuted(t.id));
  const index = Math.max(0, list.indexOf(asked));
  try {
    const cast = useCast.getState();
    if (cast.active?.id === device.id || cast.members.some((m) => m.id === device.id)) await leaveCast(device.id);
    let r = [...running.values()].find((z) => z.device.id === device.id);
    if (!r) {
      const id = `zone${nextId++}`;
      const fresh: Running = { id, device, zone: null as unknown as Zone, tracks: new Map(), timer: 0, status: null, ended: false, notStarted: false };
      running.set(id, fresh);
      try {
        fresh.status = await requireBridge().castStart(device.id, id);
      } catch (err) {
        running.delete(id);
        throw err;
      }
      fresh.zone = new Zone([{ deviceId: device.id, name: device.name, driver: driverOf(fresh), volume: fresh.status.volume }], publish);
      fresh.timer = window.setInterval(() => void fresh.zone.tick(), TICK_MS);
      r = fresh;
    }
    for (const t of list) r.tracks.set(t.id, t);
    await r.zone.play(list.map(toSong), index);
    publish();
    useUI.getState().toast(T("Playing on {name}", { name: device.name }));
    return r.id;
  } catch (err) {
    useUI.getState().toast(ipcErrorText(err, T("Couldn't start {name}", { name: device.name })), "error");
    return null;
  }
}

/** Music of their own for several: the first device takes it, the others play along with it. */
export async function startZoneOn(devices: CastDevice[], tracks: Track[], start = 0): Promise<void> {
  const [first, ...rest] = devices;
  if (!first || !tracks.length) return;
  const id = await startZone(first, tracks, start);
  if (id) for (const d of rest) await zoneJoin(id, d);
}

export function pickMusicFor(device: CastDevice | null, others: CastDevice[] = []): void {
  useZones.setState({ pickingFor: device, pickingWith: device ? others : [] });
  setPlayHook(
    device
      ? (tracks, start) => {
          useZones.setState({ pickingFor: null, pickingWith: [] });
          setPlayHook(null);
          void startZoneOn([device, ...others], tracks, start);
          return true;
        }
      : null
  );
  if (device) useUI.getState().toast(T("Now choose something to play on {join}", { join: [device, ...others].map((d) => d.name).join(" + ") }));
}

const zoneOf = (id: string): Running | undefined => running.get(id);

export const zoneToggle = (id: string): void => void zoneOf(id)?.zone.toggle();
export const zoneNext = (id: string): void => void zoneOf(id)?.zone.next();
export const zonePrevious = (id: string): void => void zoneOf(id)?.zone.previous();

export async function zoneStop(id: string): Promise<void> {
  const r = zoneOf(id);
  if (!r) return;
  running.delete(id);
  window.clearInterval(r.timer);
  await r.zone.stop();
  // Its device may be gone from the zone already (it stopped answering); the session isn't.
  await requireBridge()
    .castStop(id)
    .catch(() => undefined);
  publish();
}

export function zoneVolume(id: string, deviceId: string, level: number): void {
  const r = zoneOf(id);
  if (!r?.status) return;
  r.status = { ...r.status, members: r.status.members.map((m) => (m.id === deviceId ? { ...m, volume: level } : m)) };
  publish();
  void requireBridge().castControl("volume", level, id, deviceId).catch(() => undefined);
}

/** Another device plays along in this zone. */
export async function zoneJoin(id: string, device: CastDevice): Promise<void> {
  try {
    await requireBridge().castJoin(id, device.id);
  } catch (err) {
    useUI.getState().toast(ipcErrorText(err, T("{name} can't play along", { name: device.name })), "error");
  }
}

export async function zoneLeave(id: string, deviceId: string): Promise<void> {
  const left = await requireBridge().castLeave(id, deviceId).catch(() => true);
  if (!left) await zoneStop(id);
}
