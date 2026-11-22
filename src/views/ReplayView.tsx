/**
 * Replay — what Songsta counted (electron/stats.ts), told as a story:
 *
 *  the period, loud, over its top albums · the album of the period · five songs you couldn't stop
 *  (by plays) · your hour, on a clock · the pulse of the period · your day of the week · the faces of
 *  it all · what was new to you · mostly which genre · how it sounded and where it came from · a
 *  ticket, with the songs to play or keep as a playlist · the listening history.
 *
 * No fake numbers: an empty period says so, and a section with nothing to tell stays away. Every
 * section is laid out from the page's own width (useWidth), so each works in a narrow window as in a
 * wide one. Nothing that can be clicked lies over anything else that can, and a hover lifts a thing
 * a little in its place instead of pulling it to the front.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Clock3, FileDown, ListPlus, Pause, Play } from "lucide-react";
import { Artwork, Btn, EmptyState, ErrorState, Pills } from "../components/primitives";
import { genresOfTrack } from "../lib/albumGenres";
import { useLibraryIndex } from "../lib/catalogIndex";
import { plural } from "../lib/format";
import { artistRoute, leadArtist } from "../lib/libraryCore";
import { useCatalog } from "../stores/catalog";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { resolveArtistAbout } from "../lib/artistAbout";
import { useLibrary } from "../stores/library";
import type { Track } from "../types";
import { T, textLocale } from "../lib/i18n";
import { readListensNow } from "../lib/homeSync";
import { LISTENS_UPDATED } from "../lib/listenShare";
import { HistoryList, exportListeningHistory, useListeningHistory } from "../components/ListeningHistory";
import { pageSlides } from "../lib/slidePaging";
import { useSettings } from "../stores/settings";
import { ListeningCalendar } from "../components/ListeningCalendar";

interface Entry {
  id: string;
  title: string;
  artist: string;
  thumb: string;
  ms: number;
  plays: number;
}

interface Summary {
  totalMs: number;
  plays: number;
  tracks: Entry[];
  topPlayed?: Entry[];
  every?: { id: string; ms: number; plays: number }[];
  counts?: { tracks: number; artists: number; albums: number };
  fresh?: Entry[];
  freshCount?: number;
  artists: { name: string; thumb?: string; ms: number; plays: number }[];
  albums: { name: string; artist?: string; thumb?: string; ms: number; plays: number }[];
  hours: number[];
  days: { date: string; ms: number }[];
  period: string;
  months: string[];
}

const PERIODS = [
  { key: "month", label: T("This month") },
  { key: "lastMonth", label: T("Last month") },
  { key: "year", label: T("This year") },
  { key: "all", label: T("All time") },
] as const;

function fmtHours(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return T("{minutes} min", { minutes: Math.round(ms / 60000) });
  const hours = h < 10 ? h.toLocaleString(textLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : Math.round(h).toLocaleString(textLocale());
  return T("{hours} hrs", { hours });
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(textLocale(), { month: "short", day: "numeric" });
}

const fmtClock = (h: number): string => `${String(h).padStart(2, "0")}:00`;

/** Join key for an album row — the same shape the stats buckets use. */
const albumKey = (al: { name: string; artist?: string }): string =>
  `${al.name.toLowerCase()}|${(al.artist || "unknown artist").toLowerCase()}`;

/** The width an element has now, kept up to date. */
function useWidth<E extends HTMLElement>(): [RefObject<E>, number] {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const seen = new ResizeObserver(() => setWidth(el.clientWidth));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return [ref, width];
}

/**
 * A section's title, set as Replay sets them: a plain line, then the accent in italics. Its size comes
 * from the page's width (not the window's, which the panels share); a word longer than a line breaks
 * rather than running off the page.
 */
function Headline({ first, accent, size, room, right = false }: { first: string; accent: string; size: number; room?: number; right?: boolean }) {
  // Its longest word fits the room it has: the type gets smaller rather than a word breaking ("Gleic-her").
  const longest = Math.max(1, ...`${first} ${accent}`.split(/\s+/).map((word) => word.length));
  const fitted = Math.max(24, room ? Math.min(size, Math.floor(room / (longest * 0.6))) : size);
  return (
    <h2 className={`font-display font-black tracking-[-0.06em] leading-[0.92] text-ink-hi break-words ${right ? "text-right" : ""}`} style={{ fontSize: fitted }}>
      {first}
      <br />
      <span className="italic text-accent">{accent}</span>
    </h2>
  );
}

/**
 * One part of Replay: exactly as tall as the panel shows, its content in the middle. Replay pages from
 * one to the next (lib/slidePaging.ts), so one turn of the wheel goes to the next part.
 */
function Slide({ height, pad, className = "", back, children }: { height: number; pad: number; className?: string; back?: ReactNode; children: ReactNode }) {
  return (
    <section data-slide="" className={`relative overflow-hidden ${className}`} style={{ height }}>
      {back}
      <div className="relative h-full page-pad flex flex-col justify-center" style={{ paddingTop: pad, paddingBottom: pad }}>
        {children}
      </div>
    </section>
  );
}

function BigNumber({ value, label, size }: { value: string; label: string; size: number }) {
  return (
    <div className="whitespace-nowrap">
      <span className="font-black tracking-[-0.04em] text-white" style={{ fontSize: size }}>
        {value}
      </span>{" "}
      <span className="text-[13px] font-extrabold tracking-[0.16em] text-zinc-400 uppercase">{label}</span>
    </div>
  );
}

/**
 * A bar of shares with each part's name in it, for formats, sources and genres. A part says its name
 * and share where they fit whole, only the share where that fits, else nothing (the title tells).
 */
function ShareBar({ parts }: { parts: { label: string; share: number; color: string; dark?: boolean }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="flex h-[72px] rounded-2xl overflow-hidden text-[14px] font-black">
      {parts.map((p) => {
        const percent = `${Math.round(p.share * 100)}%`;
        const full = `${p.label} ${percent}`;
        // The part's room inside its padding, at about 8.8 px a character of 14 px black type.
        const room = p.share * width - 28;
        const text = room >= full.length * 8.8 ? full : room >= percent.length * 8.8 ? percent : "";
        return (
          <div
            key={p.label}
            title={full}
            className={`flex items-center px-3.5 min-w-0 ${p.dark ? "text-white" : "text-[#0b0b0d]"}`}
            style={{ width: `${p.share * 100}%`, background: p.color }}
          >
            <span className="truncate">{text}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The days as up to twelve stretches for the pulse: months for a year or all time, else runs of days. */
function pulseOf(days: { date: string; ms: number }[], byMonth: boolean): { label: string; ms: number }[] {
  if (!days.length) return [];
  if (byMonth) {
    const months = new Map<string, number>();
    for (const d of days) months.set(d.date.slice(0, 7), (months.get(d.date.slice(0, 7)) ?? 0) + d.ms);
    return [...months.entries()].slice(-12).map(([month, ms]) => ({ label: new Date(`${month}-01T00:00:00`).toLocaleDateString(textLocale(), { month: "short" }), ms }));
  }
  const size = Math.max(1, Math.ceil(days.length / 12));
  const out: { label: string; ms: number }[] = [];
  for (let i = 0; i < days.length; i += size) {
    const run = days.slice(i, i + size);
    out.push({ label: fmtDate(run[0].date), ms: run.reduce((sum, d) => sum + d.ms, 0) });
  }
  return out;
}

/** Minutes per weekday, Monday first. */
function weekdaysOf(days: { date: string; ms: number }[]): { label: string; long: string; ms: number }[] {
  const out = Array.from({ length: 7 }, (_, i) => {
    // 2024-01-01 was a Monday.
    const d = new Date(2024, 0, 1 + i);
    return { label: d.toLocaleDateString(textLocale(), { weekday: "short" }), long: d.toLocaleDateString(textLocale(), { weekday: "long" }), ms: 0 };
  });
  for (const d of days) out[(new Date(`${d.date}T12:00:00`).getDay() + 6) % 7].ms += d.ms;
  return out;
}

/** The radial clock of the day's hours: each hour a ray, as long as it was listened. */
function HourClock({ hours, size }: { hours: number[]; size: number }) {
  const peak = hours.reduce((best, ms, h) => (ms > hours[best] ? h : best), 0);
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? peak;
  const max = Math.max(1, ...hours);
  const inner = 74;
  const outer = 190;
  // The hour under the pointer by its angle around the middle: anywhere on the clock, so there are no
  // gaps between the rays where it fell back to the peak. Back to the peak only off the clock.
  const point = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - (box.left + box.width / 2);
    const y = e.clientY - (box.top + box.height / 2);
    if (Math.hypot(x, y) < (box.width / 420) * 40) return;
    const turn = (Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    setHover(Math.round((turn / (Math.PI * 2)) * 24) % 24);
  };
  return (
    <div className="relative mx-auto shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 420 420" width={size} height={size} role="img" aria-label={T("Listening by hour of the day")} onPointerMove={point} onPointerLeave={() => setHover(null)}>
        {/* The whole face takes the pointer, between the rays too. */}
        <circle cx={210} cy={210} r={outer + 14} fill="transparent" />
        {hours.map((ms, h) => {
          const angle = (h / 24) * Math.PI * 2 - Math.PI / 2;
          const len = inner + 6 + (ms / max) * (outer - inner);
          const on = h === shown;
          return (
            <line
              key={h}
              x1={210 + Math.cos(angle) * inner}
              y1={210 + Math.sin(angle) * inner}
              x2={210 + Math.cos(angle) * len}
              y2={210 + Math.sin(angle) * len}
              strokeLinecap="round"
              style={{ stroke: on ? "rgb(var(--accent))" : "rgba(255,255,255,0.22)", strokeWidth: on ? 14 : 11, transition: "stroke 260ms ease, stroke-width 260ms ease" }}
            />
          );
        })}
        {/* The quarter hours, only where there's room for them beside the time in the middle. */}
        {size >= 280 &&
          [0, 6, 12, 18].map((h) => {
            const angle = (h / 24) * Math.PI * 2 - Math.PI / 2;
            return (
              <text key={h} x={210 + Math.cos(angle) * 52} y={214 + Math.sin(angle) * 52} textAnchor="middle" fontSize={12} fontWeight={800} fill="rgba(255,255,255,0.4)">
                {h}
              </text>
            );
          })}
      </svg>
      <div className="absolute inset-0 grid place-items-center pointer-events-none">
        <div className="text-center">
          <div className="font-black tracking-[-0.03em] text-white leading-none" style={{ fontSize: Math.round(Math.max(15, Math.min(30, size * 0.072))) }}>
            {fmtClock(shown)}
          </div>
          <div className="font-bold text-zinc-400 mt-1" style={{ fontSize: Math.round(Math.max(10, Math.min(12, size * 0.03))) }}>
            {fmtHours(hours[shown])}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReplayView() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("month");
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [artistThumbs, setArtistThumbs] = useState<Record<string, string>>({});
  const [pulseAt, setPulseAt] = useState<number | null>(null);
  const [dayAt, setDayAt] = useState<number | null>(null);
  const playQueue = usePlayer((s) => s.playQueue);
  const playing = usePlayer((s) => s.playing);
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const toast = useUI((s) => s.toast);
  const navigate = useUI((s) => s.navigate);
  const { history, liked, playlists } = useLibrary();
  const byId = useCatalog((s) => s.byId);
  const { albums: libAlbums, artists: libArtists } = useLibraryIndex();
  const [root, width] = useWidth<HTMLDivElement>();
  // The room a section has inside the page's side margins.
  const w = Math.max(220, width - 48);
  // One slide is as tall as the page's scroller shows; while Replay is open the wheel, a swipe or Page
  // Up/Down goes from slide to slide in one move (lib/slidePaging.ts), and the history after them
  // scrolls freely.
  const [slideH, setSlideH] = useState(() => document.getElementById("view-scroll")?.clientHeight ?? 800);
  useLayoutEffect(() => {
    const scroller = document.getElementById("view-scroll");
    if (!scroller) return;
    const measure = (): void => setSlideH(scroller.clientHeight);
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(scroller);
    return () => seen.disconnect();
  }, []);
  useEffect(() => {
    const scroller = document.getElementById("view-scroll");
    const page = root.current;
    if (!scroller || !page) return;
    return pageSlides(scroller, page, { instant: () => useSettings.getState().reduceAnimation });
  }, [root]);

  // With a sync service, the other devices' plays are asked for at once; when some come, it counts again.
  useEffect(() => {
    void readListensNow();
    const again = (): void => setNonce((n) => n + 1);
    window.addEventListener(LISTENS_UPDATED, again);
    return () => window.removeEventListener(LISTENS_UPDATED, again);
  }, []);

  // The listening calendar shows whole years, whatever the period: every day counted.
  const [allDays, setAllDays] = useState<Summary["days"]>([]);
  useEffect(() => {
    let cancelled = false;
    window.bytune
      ?.statsSummary("all")
      .then((res) => {
        if (!cancelled) setAllDays((res as Summary).days ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.bytune
      ?.statsSummary(period)
      .then((res) => {
        if (!cancelled) setData(res as Summary);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, nonce]);

  // Artist photos come from the identity cache; names it doesn't know yet are resolved once and cached.
  useEffect(() => {
    if (!data) return;
    let alive = true;
    void Promise.all(
      data.artists.slice(0, 10).map(async (a) => {
        if (a.thumb || artistThumbs[a.name]) return;
        const meta = await resolveArtistAbout(a.name);
        if (meta?.thumb && alive && !artistThumbs[a.name]) setArtistThumbs((prev) => ({ ...prev, [a.name]: meta.thumb as string }));
      })
    );
    return () => {
      alive = false;
    };
    // artistThumbs intentionally excluded: re-running on our own writes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Album covers for buckets recorded before Replay stored artwork: the library knows them. A local
  // file's cover (localart://) is used only once it is confirmed present.
  const albumCandidates = useMemo(() => {
    const web = new Map<string, string>();
    const local = new Map<string, string>();
    for (const a of libAlbums) if (a.thumb) web.set(albumKey({ name: a.title, artist: a.artist }), a.thumb);
    for (const t of [...history, ...liked, ...playlists.flatMap((p) => p.tracks)]) {
      if (!t.album || !t.thumb) continue;
      const key = albumKey({ name: t.album, artist: t.artist });
      if (/^(https?:\/\/|data:image\/|blob:)/i.test(t.thumb)) {
        if (!web.has(key)) web.set(key, t.thumb);
      } else if (t.thumb.startsWith("localart:") && !local.has(key)) {
        local.set(key, t.thumb);
      }
    }
    return { web, local };
  }, [history, liked, playlists, libAlbums]);

  const [presentCovers, setPresentCovers] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    let alive = true;
    void Promise.all(
      data.albums.slice(0, 8).map(async (al) => {
        const key = albumKey(al);
        if (al.thumb || albumCandidates.web.has(key) || presentCovers[key]) return;
        const candidate = albumCandidates.local.get(key);
        if (!candidate) return;
        try {
          const art = await window.bytune?.localArtBytes(candidate);
          if (alive && art?.data) setPresentCovers((prev) => ({ ...prev, [key]: candidate }));
        } catch {
          /* the extracted cover is gone — keep the placeholder */
        }
      })
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, albumCandidates]);

  const albumThumb = (al: Summary["albums"][number]): string => {
    const key = albumKey(al);
    return al.thumb || albumCandidates.web.get(key) || presentCovers[key] || "";
  };

  // What the library can tell about the period's songs: genres, formats, sources.
  const facts = useMemo(() => {
    const every = data?.every ?? data?.tracks ?? [];
    const genres = new Map<string, number>();
    const formats = { hires: 0, lossless: 0, lossy: 0 };
    const sources = { local: 0, jf: 0, ss: 0 };
    for (const e of every) {
      const t = byId.get(e.id);
      const source = e.id.startsWith("jf:") ? "jf" : e.id.startsWith("ss:") ? "ss" : e.id.startsWith("local:") ? "local" : null;
      if (source) sources[source] += e.ms;
      if (!t) continue;
      const genre = genresOfTrack(t)[0];
      if (genre) genres.set(genre, (genres.get(genre) ?? 0) + e.ms);
      const name = (t.codec || t.container || "").toUpperCase();
      const lossless = t.lossless || /FLAC|ALAC|WAV|AIFF|APE|WV|DSD/.test(name);
      if (lossless && ((t.bitsPerSample ?? 16) > 16 || (t.sampleRate ?? 44100) > 48000)) formats.hires += e.ms;
      else if (lossless) formats.lossless += e.ms;
      else if (name) formats.lossy += e.ms;
    }
    const genreTotal = [...genres.values()].reduce((a, b) => a + b, 0);
    return { genres: [...genres.entries()].sort((a, b) => b[1] - a[1]), genreTotal, formats, sources };
  }, [data, byId]);

  if (error) {
    return <ErrorState title={T("Replay didn't load")} body={T("Give it another try.")} onRetry={() => setNonce((n) => n + 1)} />;
  }

  const hasData = !!data && data.totalMs > 0;
  const periodName = period === "month" ? T("This month") : period === "lastMonth" ? T("Last month") : period === "year" ? String(new Date().getFullYear()) : T("All of it");
  const minutes = Math.round((data?.totalMs ?? 0) / 60000);
  const topAlbum = data?.albums[0];
  const topAlbumThumb = topAlbum ? albumThumb(topAlbum) : "";
  const flowCovers = (data?.albums ?? []).map(albumThumb).filter(Boolean).slice(0, 7);
  const five = (data?.topPlayed ?? [...(data?.tracks ?? [])].sort((a, b) => b.plays - a.plays || b.ms - a.ms)).slice(0, 5);
  const topSongs = (data?.topPlayed ?? data?.tracks ?? []).slice(0, 20);
  const asTrack = (e: Entry): Track => byId.get(e.id) ?? { id: e.id, title: e.title, artist: e.artist, thumb: e.thumb, duration: 0 };
  const coverOf = (e: Entry): string => e.thumb || byId.get(e.id)?.thumb || "";
  const pulse = pulseOf(data?.days ?? [], period === "year" || period === "all");
  const maxPulse = Math.max(1, ...pulse.map((p) => p.ms));
  const pulseCovers = flowCovers.length ? flowCovers : topSongs.map((e) => coverOf(e)).filter(Boolean);
  const weekdays = weekdaysOf(data?.days ?? []);
  const bestDay = weekdays.reduce((best, d, i) => (d.ms > weekdays[best].ms ? i : best), 0);
  const maxDay = Math.max(1, ...weekdays.map((d) => d.ms));
  const faces = (data?.artists ?? []).slice(0, 5).map((a) => ({ ...a, photo: a.thumb || artistThumbs[a.name] || "" }));
  const hourTotal = (data?.hours ?? []).reduce((a, b) => a + b, 0);
  const peakHour = (data?.hours ?? []).reduce((best, ms, h, all) => (ms > all[best] ? h : best), 0);
  const formatTotal = facts.formats.hires + facts.formats.lossless + facts.formats.lossy;
  const sourceTotal = facts.sources.local + facts.sources.jf + facts.sources.ss;

  const albumOf = (name: string, artist?: string) =>
    libAlbums.find((a) => a.title.toLowerCase() === name.toLowerCase() && (!artist || a.artist.toLowerCase() === artist.toLowerCase())) ??
    libAlbums.find((a) => a.title.toLowerCase() === name.toLowerCase());
  const topAlbumInLibrary = topAlbum ? albumOf(topAlbum.name, topAlbum.artist) : undefined;

  const playSongs = (list: Entry[], start = 0): void => {
    const tracks = list.map((e) => asTrack(e));
    if (!tracks.length) return;
    playQueue(tracks, start);
    toast(T("Playing {title}", { title: tracks[start].title }), "info");
  };
  const keepAsPlaylist = (): void => {
    const tracks = topSongs.map((e) => byId.get(e.id)).filter((t): t is Track => !!t);
    if (!tracks.length) return;
    const lib = useLibrary.getState();
    const p = lib.createPlaylist(T("Replay · {period}", { period: periodName }));
    lib.setPlaylistTracks(p.id, tracks);
    toast(T("Saved as “{name}”", { name: p.name }), "success", undefined, { label: T("Open"), run: () => navigate({ name: "playlist", param: p.id }) });
  };
  const openArtist = (name: string): void => {
    const lead = leadArtist(name);
    const known = libArtists.find((a) => a.name.toLowerCase() === lead.toLowerCase());
    navigate({ name: "artist", param: known?.route ?? artistRoute(lead) });
  };

  // Layout from the room there is: the page's width, and the height of one slide (the panel between
  // the side panels, under the search and over the player). Every part of Replay is one slide, and one
  // turn of the wheel goes on to the next (the page's scroller snaps while Replay shows), so each part
  // is laid out to fit that box whatever its shape: a size takes the smaller of what the width and
  // the height allow.
  const H = Math.max(360, slideH);
  const padY = Math.round(Math.min(64, Math.max(28, H * 0.07)));
  const h = H - padY * 2;
  const wide = w >= 820;
  const roomy = w >= 600;
  const px = (min: number, share: number, max: number, room = w): number => Math.round(Math.min(max, Math.max(min, room * share)));
  // A two-line title takes at most a fifth of a slide.
  const headSize = Math.round(Math.min(px(38, 0.13, 112), Math.max(32, (h * 0.2) / 1.84)));
  const headH = headSize * 1.84;
  const openSize = Math.round(Math.min(px(46, 0.2, 170), Math.max(40, (h * 0.34) / 1.76)));
  const numberSize = Math.round(Math.min(px(28, 0.075, 64), Math.max(24, h * 0.075)));
  const flowBase = Math.round(Math.min(330, w * 0.27, h * 0.3));
  // N°1: the cover beside the name when there's room, above it when not.
  const albumSide = roomy ? Math.round(Math.min(480, w * 0.42, h * 0.8)) : Math.round(Math.max(120, Math.min(360, w - 40, h * 0.42)));
  const albumCol = roomy ? w - albumSide + 20 : w;
  const longestWord = Math.max(4, ...(topAlbum?.name ?? "").split(/\s+/).map((word) => word.length));
  const albumTitleSize = Math.round(Math.max(26, Math.min(124, albumCol * 0.17, albumCol / (longestWord * 0.62), h * (roomy ? 0.14 : 0.08))));
  const numberOneSize = Math.round(Math.min(px(56, 0.3, 180, albumCol), Math.max(40, h * (roomy ? 0.2 : 0.1))));
  const tagSize = px(14, 0.024, 20);
  // Five: five across when there's room, else a row to slide sideways; no taller than the slide holds.
  const cardGap = 16;
  const fiveW = Math.round(Math.max(110, Math.min(roomy ? (w - cardGap * 4) / 5 : 210, h - headH - 48 - 92)));
  const rankSize = px(44, 0.5, 104, fiveW);
  const fiveTitleSize = px(14, 0.09, 19, fiveW);
  // Prime time: the clock beside the title, or under it.
  const clockSize = Math.round(Math.min(420, wide ? w * 0.42 : w, wide ? h * 0.92 : Math.max(160, h - headH - 120)));
  // The pulse.
  const pulseStep = pulse.length > 0 ? w / pulse.length : w;
  const pulseMax = Math.round(Math.max(40, Math.min(190, pulseStep * 1.1, (h - headH - 110) / 2.1)));
  const pulseAreaH = Math.round(pulseMax * 2.1) + 40;
  // The week.
  const barsH = Math.round(Math.min(260, Math.max(120, h - headH - 70)));
  // The faces: one row when they fit, the first the largest; else a row to slide sideways.
  const faceWeights = [1, 0.78, 0.66, 0.56, 0.48].slice(0, faces.length);
  const faceUnit = (w - 20 * Math.max(0, faces.length - 1)) / Math.max(1, faceWeights.reduce((a, b) => a + b, 0));
  const facesNarrow = faceUnit * (faceWeights[faceWeights.length - 1] ?? 1) < 80;
  const faceRoom = Math.max(80, (h - headH - 120) / 1.2);
  const faceSize = (i: number): number =>
    Math.round(
      facesNarrow
        ? Math.min(190, w * 0.62, faceRoom) * (i === 0 ? 1 : 0.8)
        : Math.min([360, 280, 240, 200, 170][i], faceUnit * faceWeights[i], faceRoom * faceWeights[i])
    );
  // New to you: as many rows as the slide holds.
  const freshCols = wide ? 4 : w >= 380 ? 2 : 1;
  const freshRows = Math.max(1, Math.floor((h - headH - 40 + 12) / 84));
  const freshShown = (data?.fresh ?? []).slice(0, freshCols * freshRows);
  // Mostly which genre, and how it sounded: one slide when both fit, two when not.
  const hasGenres = facts.genres.length > 0 && facts.genreTotal > 0;
  const hasSounds = formatTotal > 0 || sourceTotal > 0;
  const barsSideBySide = w >= 760;
  const soundsTogether = hasGenres && hasSounds && h - headH - 40 - 72 - 44 >= (barsSideBySide ? 128 : 268);
  // The ticket: beside the title when there's room.
  const ticketRow = w >= 1000;
  const ticketW = Math.min(530, w);
  const ticketH = Math.round(Math.min(300, ticketRow ? h * 0.75 : Math.max(180, h - headH - 150)));
  const ticketArt = ticketW < 460 ? 0.3 : 0.43;
  const ticketText = ticketW * (1 - ticketArt) - 51;
  const ticketSize = Math.round(Math.max(22, Math.min(56, ticketText / (Math.max(4, periodName.length) * 0.56))));

  // Pointing anywhere along the pulse or the week picks the nearest one: no gaps that fall back.
  const pickPulse = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    setPulseAt(Math.min(pulse.length - 1, Math.max(0, Math.floor((e.clientX - box.left) / pulseStep))));
  };
  const pickDay = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    setDayAt(Math.min(6, Math.max(0, Math.floor(((e.clientX - box.left) / Math.max(1, box.width)) * 7))));
  };

  const genreBar = (
    <ShareBar
      parts={[
        ...facts.genres.slice(0, 4).map(([name, ms], i) => ({ label: name, share: ms / facts.genreTotal, color: ["rgb(var(--accent))", "#7dd3fc", "#fbbf24", "#5eead4"][i] })),
        ...(facts.genres.length > 4 ? [{ label: T("Other"), share: facts.genres.slice(4).reduce((a, [, ms]) => a + ms, 0) / facts.genreTotal, color: "#3f3f46", dark: true }] : []),
      ]}
    />
  );
  const soundBars = (
    <div className={`flex gap-7 ${barsSideBySide ? "" : "flex-col"}`}>
      {formatTotal > 0 && (
        <div className="flex-1 min-w-0">
          <div className="text-[26px] font-black tracking-[-0.03em] text-white mb-3">{T("How it sounded")}</div>
          <ShareBar
            parts={[
              { label: T("Hi-Res"), share: facts.formats.hires / formatTotal, color: "#5eead4" },
              { label: T("Lossless"), share: facts.formats.lossless / formatTotal, color: "#ffffff" },
              { label: T("Lossy"), share: facts.formats.lossy / formatTotal, color: "#3f3f46", dark: true },
            ].filter((p) => p.share > 0)}
          />
        </div>
      )}
      {sourceTotal > 0 && (
        <div className="flex-1 min-w-0">
          <div className="text-[26px] font-black tracking-[-0.03em] text-white mb-3">{T("Where it came from")}</div>
          <ShareBar
            parts={[
              { label: T("Jellyfin"), share: facts.sources.jf / sourceTotal, color: "rgb(var(--accent))" },
              { label: T("Navidrome"), share: facts.sources.ss / sourceTotal, color: "#fbbf24" },
              { label: T("Your folders"), share: facts.sources.local / sourceTotal, color: "#7dd3fc" },
            ].filter((p) => p.share > 0)}
          />
        </div>
      )}
    </div>
  );
  const blurred = (strong: boolean) =>
    topAlbumThumb ? (
      <img
        src={topAlbumThumb}
        alt=""
        aria-hidden
        className={`absolute -inset-20 w-[calc(100%+160px)] h-[calc(100%+160px)] object-cover ${strong ? "blur-[110px] saturate-150 brightness-[0.32]" : "blur-[80px] saturate-[1.7] brightness-50"}`}
      />
    ) : undefined;

  return (
    <div ref={root} className="page-bleed -mt-5 overflow-x-clip">
      {/* The opening: the period, loud, over its top albums fanned out like a record shelf. */}
      <Slide height={H} pad={padY} back={blurred(true)}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="text-[13px] font-black tracking-[0.3em] text-accent">{T("SONGSTA REPLAY")}</div>
          <Pills wrap options={PERIODS.map((p) => ({ key: p.key, label: p.label }))} value={period} onChange={(k) => setPeriod(k as typeof period)} />
        </div>
        <h1 className="font-display font-black tracking-[-0.065em] leading-[0.88] text-ink-hi mt-3 break-words" style={{ fontSize: openSize }}>
          {hasData ? T("{period} was", { period: periodName }) : periodName}
          <br />
          <span className="italic text-accent">{hasData ? T("loud.") : T("still quiet.")}</span>
        </h1>
        {loading && <div className="skeleton rounded-2xl mt-8" style={{ height: Math.round(Math.min(260, h * 0.4)) }} />}
        {!loading && !hasData && (
          <div className="mt-8">
            <EmptyState icon={Clock3} title={T("Nothing here yet")} body={T("Play something first — Replay fills in as Songsta counts what you actually listen to.")} />
          </div>
        )}
        {!loading && hasData && data && (
          <>
            {flowCovers.length >= 3 && (
              <div aria-hidden className="relative flex items-center justify-center mt-4" style={{ perspective: 1400, height: flowBase + 20 }}>
                {flowCovers.map((src, i) => {
                  const off = i - (flowCovers.length - 1) / 2;
                  const size = Math.round(flowBase * (1 - Math.abs(off) * 0.19));
                  return (
                    <img
                      key={`${src}-${i}`}
                      src={src}
                      alt=""
                      className="shrink-0 object-cover rounded-xl relative shadow-[0_50px_100px_-24px_rgba(0,0,0,0.95)]"
                      style={{ width: size, height: size, marginLeft: i === 0 ? 0 : -Math.round(flowBase * 0.1), transform: `rotateY(${Math.round(-off * 19)}deg)`, zIndex: 10 - Math.round(Math.abs(off)), filter: `brightness(${1 - Math.abs(off) * 0.16})` }}
                    />
                  );
                })}
              </div>
            )}
            <div className="flex gap-x-12 gap-y-2 flex-wrap items-baseline pt-6">
              <BigNumber size={numberSize} value={minutes.toLocaleString()} label={T("MINUTES")} />
              <BigNumber size={numberSize} value={data.plays.toLocaleString()} label={T("PLAYS")} />
              <BigNumber size={numberSize} value={(data.counts?.tracks ?? data.tracks.length).toLocaleString()} label={T("SONGS")} />
              <BigNumber size={numberSize} value={(data.counts?.artists ?? data.artists.length).toLocaleString()} label={T("ARTISTS")} />
            </div>
          </>
        )}
      </Slide>

      {!loading && hasData && data && (
        <>
          {/* N°1: the album of the period, in its own colours. */}
          {topAlbum && (
            <Slide height={H} pad={padY} back={blurred(false)}>
              <div className={`flex ${roomy ? "items-center gap-10" : "flex-col gap-6"}`}>
                <div className="shrink-0 rounded-2xl overflow-hidden shadow-[0_60px_140px_-30px_rgba(0,0,0,0.95)]" style={{ width: albumSide, height: albumSide, marginLeft: roomy ? -60 : 0, rotate: "-8deg" }}>
                  <Artwork src={topAlbumThumb} className="w-full h-full" rounded="rounded-none" iconClassName="w-14 h-14" alt="" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-black leading-[0.8] text-transparent" style={{ fontSize: numberOneSize, WebkitTextStroke: "3px rgba(255,255,255,0.4)" }}>
                    N°1
                  </div>
                  <button
                    onClick={() => topAlbumInLibrary && navigate({ name: "album", param: topAlbumInLibrary.route })}
                    disabled={!topAlbumInLibrary}
                    title={topAlbumInLibrary ? T("Open {name}", { name: topAlbum.name }) : undefined}
                    className="block max-w-full text-left font-display font-black tracking-[-0.06em] leading-[0.92] text-white mt-4 break-words disabled:cursor-default"
                    style={{ fontSize: albumTitleSize }}
                  >
                    {topAlbum.name}
                  </button>
                  <div className="flex items-center gap-3 mt-5 flex-wrap">
                    <span className="inline-block px-4 py-2 bg-[#0b0b0d] text-white font-extrabold" style={{ fontSize: tagSize, rotate: "2deg" }}>
                      {[topAlbum.artist, fmtHours(topAlbum.ms), plural(topAlbum.plays, T("play"), T("plays"))].filter(Boolean).join(" — ")}
                    </span>
                    {topAlbumInLibrary && (
                      <button
                        onClick={() => usePlayer.getState().playAll(topAlbumInLibrary.tracks)}
                        aria-label={T("Play {title}", { title: topAlbum.name })}
                        className="w-12 h-12 rounded-full bg-white text-[#0b0b0d] grid place-items-center hover:scale-105 active:scale-95 transition-transform"
                      >
                        <Play className="w-5 h-5 fill-current" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </Slide>
          )}

          {/* Five songs, by how often they played: side by side, never over each other. */}
          {five.length > 0 && (
            <Slide height={H} pad={padY}>
              <Headline room={w} size={headSize} first={T("Five you")} accent={T("couldn't stop.")} />
              <div
                className={roomy ? "grid mt-10 justify-center" : "flex overflow-x-auto snap-x snap-mandatory mt-8 pb-4"}
                style={roomy ? { gap: cardGap, gridTemplateColumns: `repeat(5, ${fiveW}px)` } : { gap: cardGap }}
              >
                {five.map((t, i) => {
                  const on = currentId === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => (on ? usePlayer.getState().toggle() : playSongs(five, i))}
                      title={T("Play {title}", { title: t.title })}
                      className="group relative shrink-0 snap-start rounded-2xl overflow-hidden bg-[#17171b] text-left shadow-[0_30px_70px_-24px_rgba(0,0,0,0.95),inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-transform duration-200 hover:-translate-y-2"
                      style={{ width: fiveW, rotate: `${[-3, 2, -1.5, 2.5, -2][i]}deg` }}
                    >
                      <Artwork src={coverOf(t)} className="w-full aspect-square" rounded="rounded-none" iconClassName="w-10 h-10" alt="" />
                      <span className="absolute left-3 top-1 font-black tracking-[-0.06em] leading-none text-white drop-shadow-[0_6px_30px_rgba(0,0,0,0.8)]" style={{ fontSize: rankSize }}>
                        {i + 1}
                      </span>
                      <span className="absolute right-3 top-3 w-10 h-10 rounded-full bg-accent text-[#0b0b0d] grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
                        {on && playing ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                      </span>
                      <span className="block px-4 pt-3 pb-3.5">
                        <span className="block font-black tracking-[-0.02em] text-white truncate" style={{ fontSize: fiveTitleSize }}>
                          {t.title}
                        </span>
                        <span className="block text-[13px] text-zinc-400 truncate">{t.artist}</span>
                        <span className="block text-[13px] font-extrabold text-accent mt-1.5">{plural(t.plays, T("play"), T("plays"))}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Slide>
          )}

          {/* Prime time, on a clock. */}
          {hourTotal > 0 && (
            <Slide height={H} pad={padY} className="bg-[#101013]">
              <div className={wide ? "flex items-center gap-12" : "flex flex-col gap-8"}>
                <div className="flex-1 min-w-0">
                  <Headline room={wide ? w - clockSize - 48 : w} size={wide ? Math.round(Math.min(px(38, 0.2, 112, w - clockSize - 48), headSize * 1.1)) : headSize} first={T("Your prime time")} accent={T("was at {time}.", { time: fmtClock(peakHour) })} />
                  <p className="text-[16px] text-ink-dim mt-4 max-w-[440px]">{T("Each ray is an hour of the day, as long as you listened then. Point at one.")}</p>
                </div>
                <HourClock hours={data.hours} size={clockSize} />
              </div>
            </Slide>
          )}

          {/* The pulse: the period as records on a wave, the bigger the more played. */}
          {pulse.length > 2 && (
            <Slide height={H} pad={padY}>
              <Headline room={w} size={headSize} first={T("It had a")} accent={T("pulse.")} />
              <p className="text-[16px] text-ink-dim mt-5 min-h-[24px]">
                {pulseAt !== null ? T("{label}: {time}", { label: pulse[pulseAt].label, time: fmtHours(pulse[pulseAt].ms) }) : T("The bigger the record, the more played then.")}
              </p>
              <div className="relative mt-4" style={{ height: pulseAreaH }} onPointerMove={pickPulse} onPointerLeave={() => setPulseAt(null)}>
                {pulse.map((p, i) => {
                  const share = p.ms / maxPulse;
                  const size = Math.round(Math.max(36, pulseMax * (0.35 + share * 0.65)));
                  const peak = p.ms === maxPulse;
                  const on = pulseAt === i;
                  const centerY = Math.round(pulseMax * (1.5 - share) + Math.sin(i * 1.3) * 10);
                  const cover = pulseCovers.length ? pulseCovers[i % pulseCovers.length] : "";
                  return (
                    <div key={p.label + i} className="absolute text-center pointer-events-none" style={{ left: pulseStep * (i + 0.5), top: centerY, width: size, transform: "translate(-50%, -50%)" }}>
                      <div
                        className={`rounded-full overflow-hidden shadow-[0_24px_60px_-10px_rgba(0,0,0,0.9)] transition-[box-shadow,filter,transform] duration-300 ease-out ${on || (pulseAt === null && peak) ? "ring-[5px] ring-accent" : ""} ${on ? "scale-[1.06]" : ""} ${pulseAt !== null && !on ? "brightness-75" : ""}`}
                        style={{ width: size, height: size }}
                      >
                        <Artwork src={cover} className="w-full h-full" rounded="rounded-full" iconClassName="w-5 h-5" alt="" />
                      </div>
                      <div className={`text-[11px] font-black tracking-[0.12em] mt-2 uppercase whitespace-nowrap transition-colors duration-300 ${on || (pulseAt === null && peak) ? "text-accent" : "text-zinc-500"}`}>{p.label}</div>
                    </div>
                  );
                })}
              </div>
            </Slide>
          )}

          {/* Your day of the week. */}
          {weekdays.some((d) => d.ms > 0) && (
            <Slide height={H} pad={padY} className="bg-[#101013]">
              <Headline room={w} size={headSize} first={weekdays[bestDay].long} accent={T("was your day.")} />
              <div className="flex items-end gap-3 mt-8" style={{ height: barsH }} onPointerMove={pickDay} onPointerLeave={() => setDayAt(null)}>
                {weekdays.map((d, i) => {
                  const lit = dayAt === i || (dayAt === null && i === bestDay);
                  return (
                    <div key={d.label} className="flex-1 h-full flex flex-col justify-end items-center gap-2">
                      <div className={`text-[12px] font-extrabold text-white transition-opacity duration-300 ${lit ? "opacity-100" : "opacity-0"}`}>{fmtHours(d.ms)}</div>
                      <div
                        className={`w-full rounded-t-xl transition-colors duration-300 ${i === bestDay ? "bg-accent" : dayAt === i ? "bg-white/40" : "bg-white/[0.14]"}`}
                        style={{ height: `${Math.max(2, (d.ms / maxDay) * 76)}%` }}
                      />
                      <div className={`text-[12px] font-black tracking-[0.1em] uppercase ${i === bestDay ? "text-accent" : "text-zinc-500"}`}>{d.label}</div>
                    </div>
                  );
                })}
              </div>
            </Slide>
          )}

          {/* The listening calendar: the year as days, the brighter the more you listened. */}
          {allDays.some((d) => d.ms > 0) && (
            <Slide
              height={H}
              pad={padY}
              back={<div aria-hidden className="absolute inset-0" style={{ background: "radial-gradient(900px 340px at 50% 0%, rgb(var(--accent) / 0.13), transparent 70%)" }} />}
            >
              <ListeningCalendar days={allDays} width={w} height={h} head={<Headline room={w} size={headSize} first={T("Your year,")} accent={T("day by day.")} />} />
            </Slide>
          )}

          {/* The faces: the top artists side by side, the first the largest. */}
          {faces.length > 0 && (
            <Slide height={H} pad={padY}>
              <Headline right room={w} size={headSize} first={T("The faces")} accent={T("of it all.")} />
              <div className={facesNarrow ? "flex items-end overflow-x-auto snap-x snap-mandatory mt-8 pb-4" : "flex items-end justify-center mt-8"} style={{ gap: 20 }}>
                {faces.map((a, i) => {
                  const size = faceSize(i);
                  return (
                    <button
                      key={a.name}
                      onClick={() => openArtist(a.name)}
                      title={T("Open {name}", { name: a.name })}
                      className="shrink-0 snap-start text-left transition-transform duration-200 hover:-translate-y-2"
                      style={{ width: size, rotate: `${[-3, 2.5, -2, 3, -1.5][i]}deg` }}
                    >
                      <span className="block rounded-2xl overflow-hidden shadow-[0_30px_80px_-20px_rgba(0,0,0,0.95)]" style={{ height: Math.round(size * 1.2) }}>
                        <Artwork src={a.photo} className="w-full h-full" rounded="rounded-none" iconClassName="w-10 h-10" alt="" />
                      </span>
                      <span
                        className={`inline-block mt-3 px-2.5 py-1 font-black text-[#0b0b0d] max-w-full line-clamp-2 break-words align-top ${i === 0 ? "bg-accent" : "bg-white"}`}
                        style={{ fontSize: i === 0 ? px(14, 0.026, 20) : px(11, 0.019, 14) }}
                      >
                        {i + 1} · {a.name}
                      </span>
                      <span className="block text-[12px] text-zinc-400 mt-1">{fmtHours(a.ms)}</span>
                    </button>
                  );
                })}
              </div>
            </Slide>
          )}

          {/* New to you. */}
          {(data.freshCount ?? 0) > 0 && freshShown.length > 0 && (
            <Slide height={H} pad={padY} className="bg-[#101013]">
              <Headline room={w} size={headSize} first={plural(data.freshCount ?? 0, T("song"), T("songs"))} accent={T("were new to you.")} />
              <div className="grid gap-3 mt-8" style={{ gridTemplateColumns: `repeat(${freshCols}, minmax(0, 1fr))` }}>
                {freshShown.map((t, i, list) => (
                  <button key={t.id} onClick={() => playSongs(list, i)} className="flex items-center gap-3 p-2 pr-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] transition-colors text-left min-w-0">
                    <Artwork src={coverOf(t)} className="w-14 h-14 shrink-0" rounded="rounded-lg" iconClassName="w-5 h-5" alt="" />
                    <span className="min-w-0">
                      <span className="block text-[14px] font-bold text-white truncate">{t.title}</span>
                      <span className="block text-[12.5px] text-zinc-400 truncate">{t.artist}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Slide>
          )}

          {/* Mostly which genre, and how it sounded and where it came from. */}
          {hasGenres && (
            <Slide height={H} pad={padY}>
              <Headline room={w} size={headSize} first={T("Mostly")} accent={`${facts.genres[0][0]}.`} />
              <div className="mt-8">{genreBar}</div>
              {soundsTogether && <div className="mt-11">{soundBars}</div>}
            </Slide>
          )}
          {hasSounds && !soundsTogether && (
            <Slide height={H} pad={padY}>
              {soundBars}
            </Slide>
          )}

          {/* The ending: a ticket for the period, and its songs to play or keep. */}
          <Slide height={H} pad={padY} className="bg-[#101013]">
            <div className={ticketRow ? "flex items-center gap-12" : "flex flex-col gap-8"}>
              <div className="flex-1 min-w-0">
                <Headline room={ticketRow ? w - ticketW - 48 : w} size={headSize} first={T("Same seat")} accent={T("next time?")} />
                <div className="flex gap-3 mt-7 flex-wrap">
                  <Btn variant="white" size="md" icon={Play} onClick={() => playSongs(topSongs)}>{T("Play your top songs")}</Btn>
                  <Btn variant="glass" size="md" icon={ListPlus} onClick={keepAsPlaylist}>{T("Keep them as a playlist")}</Btn>
                </div>
              </div>
              <div className="flex shrink-0 rounded-2xl overflow-hidden shadow-[0_50px_120px_-30px_rgba(0,0,0,0.95)] w-full" style={{ maxWidth: ticketW, height: ticketH, rotate: "3deg" }}>
                <div className="h-full shrink-0" style={{ width: `${ticketArt * 100}%` }}>
                  <Artwork src={topAlbumThumb} className="w-full h-full" rounded="rounded-none" iconClassName="w-10 h-10" alt="" />
                </div>
                <div className="flex-1 min-w-0 h-full bg-[#f4f1ea] text-[#0b0b0d] px-6 py-5 flex flex-col border-l-[3px] border-dashed border-[#0b0b0d]">
                  <div className="text-[11px] font-black tracking-[0.24em] leading-[1.5]">{T("ADMIT ONE · SONGSTA REPLAY")}</div>
                  <div className="font-black tracking-[-0.06em] leading-none pb-[0.16em] mt-2 truncate" style={{ fontSize: ticketSize }}>
                    {periodName}
                  </div>
                  <div className="text-[13px] font-bold leading-[1.7] mt-2">
                    <div className="truncate">{T("{minutes} minutes · {plays} plays", { minutes: minutes.toLocaleString(), plays: data.plays.toLocaleString() })}</div>
                    {data.artists[0] && <div className="truncate">{T("Headliner: {name}", { name: data.artists[0].name })}</div>}
                    {topAlbum && <div className="truncate">{T("Album: {name}", { name: topAlbum.name })}</div>}
                  </div>
                  <div className="flex-1" />
                  <div className="h-[34px] shrink-0" style={{ background: "repeating-linear-gradient(90deg, #0b0b0d 0 3px, transparent 3px 6px, #0b0b0d 6px 7px, transparent 7px 12px)" }} />
                </div>
              </div>
            </div>
          </Slide>
        </>
      )}

      {/* The listening history: the last stop, scrolled freely when it's longer than a slide. */}
      <section data-slide-end="" className="page-pad pt-10" style={{ minHeight: H }}>
        <ListeningHistory />
      </section>
    </div>
  );
}



/**
 * Every listen, newest first and by day (components/ListeningHistory.tsx): a song still in the
 * library plays from its row; "Export…" saves the whole history as a spreadsheet.
 */
function ListeningHistory() {
  const { listens, more, total, shared, loadMore } = useListeningHistory();
  if (!listens.length) return null;
  return (
    <section>
      <div className="flex items-end justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2 className="section-title text-[21px]">{T("Listening history")}</h2>
          <p className="text-[13px] text-ink-dim mt-1">
            {shared
              ? T("{count} · shared with your devices through your sync service", { count: plural(total, T("listen"), T("listens")) })
              : T("{count} · kept on this computer only", { count: plural(total, T("listen"), T("listens")) })}
          </p>
        </div>
        <div className="shrink-0 whitespace-nowrap">
          <Btn variant="glass" size="sm" icon={FileDown} onClick={() => void exportListeningHistory()}>{T("Export…")}</Btn>
        </div>
      </div>
      <HistoryList listens={listens} more={more} onMore={loadMore} />
    </section>
  );
}
