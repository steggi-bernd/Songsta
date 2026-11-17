/**
 * The listening history every device shares through the sync service (sync-server: /v1/listens), the
 * user's idea of 2026-11-15: each device sends the plays it counted, the service keeps them all in
 * order, and each device takes the others' in. Replay and the listening history then count every
 * play on every device, and every device shows the same. Without a sync service each device counts
 * what it played itself, as before. Pure, one copy for the desktop and the phone.
 */

export interface WireListen {
  /** when it began, ms */
  at: number;
  id: string;
  title: string;
  artist: string;
  album?: string;
  /** how long it counts for, ms (the song's length) */
  ms: number;
  /** a picture any device can load (a web address), if there is one */
  thumb?: string;
}

export interface SharedListen extends WireListen {
  /** its place in the service's history, from 1 */
  n: number;
  /** the device that played it */
  device: string;
}

export interface ListenDevice {
  name: string;
  kind?: "computer" | "phone";
}

export interface ListenPage {
  /** how many listens the service keeps in all */
  count: number;
  listens: SharedListen[];
  devices: Record<string, ListenDevice>;
  /** more after these */
  more: boolean;
}

/**
 * Whether this device shares the history (Settings → Network & privacy): while it's shared and plays
 * are kept here at all. The other devices' plays come into this device's history, so with "Keep my
 * plays" off nothing comes in, and nothing goes out either.
 */
export const sharesListens = (s: { shareListens: boolean; recordListening: boolean }): boolean => s.shareListens && s.recordListening;

/** How many listens go out in one request. */
export const LISTEN_BATCH = 500;
/** How many come in at once. */
export const LISTEN_PAGE = 2000;

const EARLIEST = Date.UTC(2000, 0, 1);
const LONGEST_MS = 6 * 3600_000;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max).trim() : "");

/** A listen as it may travel, or null: odd values out, only a web picture along. */
export function wireListen(raw: unknown, now = Date.now()): WireListen | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const at = typeof r.at === "number" && Number.isFinite(r.at) ? Math.round(r.at) : NaN;
  const id = text(r.id, 200);
  const title = text(r.title, 300);
  if (!(at >= EARLIEST && at <= now + 86_400_000) || !id || !title) return null;
  const ms = typeof r.ms === "number" && Number.isFinite(r.ms) ? Math.max(0, Math.min(LONGEST_MS, Math.round(r.ms))) : 0;
  const listen: WireListen = { at, id, title, artist: text(r.artist, 300), ms };
  const album = text(r.album, 300);
  if (album) listen.album = album;
  const thumb = text(r.thumb, 1000);
  if (/^https?:\/\//i.test(thumb)) listen.thumb = thumb;
  return listen;
}

/** One device's listen, known by who played it and when: the same listen sent twice is one. */
export const listenKey = (device: string, l: { at: number; id: string }): string => `${device}|${Math.round(l.at)}|${l.id}`;

/** What the service answers to "since", read safely; null when it isn't such an answer. */
export function readListenPage(body: unknown, now = Date.now()): ListenPage | null {
  const b = body as { count?: unknown; listens?: unknown; devices?: unknown; more?: unknown } | null;
  if (!b || typeof b !== "object" || typeof b.count !== "number" || !Array.isArray(b.listens)) return null;
  const listens: SharedListen[] = [];
  for (const raw of b.listens) {
    const r = raw as Record<string, unknown>;
    const listen = wireListen(raw, now);
    const device = text(r?.device, 80);
    if (!listen || !device || typeof r.n !== "number") continue;
    listens.push({ ...listen, n: r.n, device });
  }
  const devices: Record<string, ListenDevice> = {};
  if (b.devices && typeof b.devices === "object") {
    for (const [id, d] of Object.entries(b.devices as Record<string, unknown>).slice(0, 50)) {
      const entry = d as { name?: unknown; kind?: unknown } | null;
      if (!id || id === "__proto__" || !entry) continue;
      devices[id] = { name: text(entry.name, 80) || "?", ...(entry.kind === "computer" || entry.kind === "phone" ? { kind: entry.kind } : {}) };
    }
  }
  return { count: Math.max(0, Math.round(b.count)), listens, devices, more: b.more === true };
}
