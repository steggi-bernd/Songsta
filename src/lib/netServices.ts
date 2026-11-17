/**
 * The services on the internet Songsta talks to, besides your own servers and devices (Settings →
 * Network & privacy): what each is for, what goes to it, and the addresses it answers at. A request
 * goes out only to a service that's switched on: the desktop checks every request of its own and of
 * its pages (electron/net-gate.ts), the phone asks before each of its few (mobile/src/netGate.ts).
 *
 * Your own servers (Jellyfin, Navidrome, the sync service, at home or on the road) and everything in
 * the home network are always reachable: they're yours. Pure, for tests and both apps.
 */

export type NetGroup = "info" | "lyrics" | "covers" | "updates";

export interface NetService {
  id: string;
  group: NetGroup;
  /** its own name, not translated */
  name: string;
  /** what Songsta asks it for (English, shown through T()) */
  purpose: string;
  /** what goes to it (English, shown through T()) */
  sends: string;
  /** the names it answers at; one starting with a dot also covers the names under it */
  hosts: string[];
  /** the phone asks it too */
  phone?: boolean;
}

const LYRICS_SENDS = "Song, artist and album names, the song's length";

export const NET_SERVICES: NetService[] = [
  {
    id: "musicbrainz",
    group: "info",
    name: "MusicBrainz",
    purpose: "Album and artist facts, release years, and the genres its community voted for",
    sends: "Album, artist and song names",
    hosts: ["musicbrainz.org", ".musicbrainz.org"],
    phone: true,
  },
  {
    id: "coverart",
    group: "info",
    name: "Cover Art Archive",
    purpose: "Album covers your files lack",
    sends: "Which album (its MusicBrainz number)",
    hosts: ["coverartarchive.org", ".coverartarchive.org", "archive.org", ".archive.org"],
  },
  {
    id: "itunes",
    group: "info",
    name: "iTunes Search",
    purpose: "Covers and album details where MusicBrainz has none, and the cover in your Discord status",
    sends: "Album and artist names",
    hosts: ["itunes.apple.com", ".mzstatic.com"],
  },
  {
    id: "wikipedia",
    group: "info",
    name: "Wikipedia & Wikidata",
    purpose: "Artist bios and photos, and album genres",
    sends: "Artist and album names, database numbers",
    hosts: [".wikipedia.org", "wikidata.org", ".wikidata.org", ".wikimedia.org"],
    phone: true,
  },
  {
    id: "genius",
    group: "info",
    name: "Genius",
    purpose: "A song's story and credits, artist pictures, and plain lyrics when nothing else has them",
    sends: "Song and artist names",
    hosts: ["genius.com", ".genius.com"],
    phone: true,
  },
  { id: "lrclib", group: "lyrics", name: "LRCLIB", purpose: "Synced lyrics", sends: LYRICS_SENDS, hosts: ["lrclib.net", ".lrclib.net"], phone: true },
  { id: "binilyrics", group: "lyrics", name: "BiniLyrics", purpose: "Word-synced lyrics as Apple Music has them", sends: LYRICS_SENDS, hosts: ["lyrics-api.binimum.org"] },
  {
    id: "boidu",
    group: "lyrics",
    name: "BetterLyrics, Portato & Unison",
    purpose: "Word-synced lyrics as Apple Music and QQ Music have them",
    sends: LYRICS_SENDS,
    hosts: ["boidu.dev", ".boidu.dev"],
  },
  {
    id: "paxsenix",
    group: "lyrics",
    name: "PaxSenix & Apple Music",
    purpose: "Word-synced lyrics from Apple Music",
    sends: LYRICS_SENDS,
    hosts: ["lyrics.paxsenix.org", ".paxsenix.org", "music.apple.com", "amp-api.music.apple.com"],
  },
  {
    id: "lyricsplus",
    group: "lyrics",
    name: "LyricsPlus",
    purpose: "Syllable-synced lyrics",
    sends: LYRICS_SENDS,
    hosts: ["lyricsplus.prjktla.my.id", "lyricsplus.atomix.one", "lyricsplus.binimum.org", "lyricsplus.prjktla.workers.dev", "lyricsplus-seven.vercel.app", "lyrics-plus-backend.vercel.app"],
  },
  { id: "megalobiz", group: "lyrics", name: "Megalobiz", purpose: "Line-synced lyrics", sends: LYRICS_SENDS, hosts: ["megalobiz.com", ".megalobiz.com"] },
  { id: "kugou", group: "lyrics", name: "KuGou", purpose: "Line-synced lyrics", sends: LYRICS_SENDS, hosts: ["kugou.com", ".kugou.com"] },
  { id: "musixmatch", group: "lyrics", name: "Musixmatch", purpose: "Synced lyrics", sends: LYRICS_SENDS, hosts: ["musixmatch.com", ".musixmatch.com"] },
  {
    id: "canvascommunity",
    group: "covers",
    name: "Canvas index",
    purpose: "Looping video covers people collected",
    sends: "Nothing but the request for its list",
    hosts: ["vivimusicanvas.mkmdevilmi.workers.dev"],
  },
  { id: "tidal", group: "covers", name: "Tidal", purpose: "Looping video covers", sends: "Song, artist and album names", hosts: ["tidal.com", ".tidal.com"] },
  {
    id: "github",
    group: "updates",
    name: "GitHub",
    purpose: "Whether a new Songsta is out, the update itself, and AutoEQ's headphone profiles",
    sends: "Nothing about you or your music",
    hosts: ["github.com", ".github.com", ".githubusercontent.com"],
    phone: true,
  },
];

export const NET_GROUPS: NetGroup[] = ["info", "lyrics", "covers", "updates"];

/** What may go out: every internet service switched off at once, or these ones. */
export interface NetPolicy {
  ownOnly: boolean;
  off: string[];
}

const matches = (host: string, pattern: string): boolean => (pattern.startsWith(".") ? host.endsWith(pattern) : host === pattern);

/** A name as it's compared: lower case, an IPv6 address without its brackets, no closing dot ("genius.com." is genius.com). */
const cleanHost = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

/** The service a name belongs to, if it's one of these. */
export function serviceOfHost(host: string): NetService | null {
  const h = cleanHost(host);
  return NET_SERVICES.find((s) => s.hosts.some((p) => matches(h, p))) ?? null;
}

/**
 * This computer or the home network: loopback, the private and shared ranges (a VPN like Tailscale
 * too), link-local, a name without dots or with a home-network ending.
 */
export function isHomeHost(host: string): boolean {
  const h = cleanHost(host);
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.includes(":")) return h === "::1" || /^fe[89ab]/.test(h) || /^f[cd]/.test(h);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!h.includes(".")) return true;
  return /\.(local|lan|home|internal|home\.arpa|fritz\.box)$/.test(h);
}

/** A request judged: to your own servers or the home network (always), to a service (by its switch), or elsewhere. */
export type NetVerdict =
  | { kind: "own"; host: string; allowed: true }
  | { kind: "service"; host: string; service: NetService; allowed: boolean }
  | { kind: "other"; host: string; allowed: boolean };

export function judgeRequest(url: string, policy: NetPolicy, ownHosts: ReadonlySet<string>): NetVerdict {
  let host = "";
  try {
    host = cleanHost(new URL(url).hostname);
  } catch {
    return { kind: "other", host: "", allowed: !policy.ownOnly };
  }
  if (isHomeHost(host) || ownHosts.has(host)) return { kind: "own", host, allowed: true };
  const service = serviceOfHost(host);
  if (service) return { kind: "service", host, service, allowed: !policy.ownOnly && !policy.off.includes(service.id) };
  return { kind: "other", host, allowed: !policy.ownOnly };
}

/** The names of addresses (a server's, the sync service's), for the list of your own. */
export function hostsOf(addresses: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const a of addresses) {
    if (!a) continue;
    try {
      const host = cleanHost(new URL(a).hostname);
      if (host) out.add(host);
    } catch {
      /* not an address */
    }
  }
  return out;
}

/** A policy read from saved settings, with anything odd in it left out. */
export function readPolicy(raw: unknown): NetPolicy {
  const s = (raw && typeof raw === "object" && "state" in raw ? (raw as { state: unknown }).state : raw) as { netOwnOnly?: unknown; netOff?: unknown } | null;
  const known = new Set(NET_SERVICES.map((x) => x.id));
  return {
    ownOnly: s?.netOwnOnly === true,
    off: Array.isArray(s?.netOff) ? s.netOff.filter((id): id is string => typeof id === "string" && known.has(id)) : [],
  };
}
