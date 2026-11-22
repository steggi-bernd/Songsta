/**
 * Home, which holds what the Your Library page had (views/LibraryHomeView.tsx puts it together), after
 * the user's mockup B2 of 2026-11-21:
 *
 *  - HomeHead: a wall of the library's covers behind the greeting and the library's numbers; under
 *    them, at the head's foot, what plays now (or the song to go back to) as a cover with Play/Pause,
 *    and the albums and mixes played last, with the way to everything heard.
 *  - LibraryTiles: Liked Songs with its newest covers, what played this week, and small boxes for
 *    Downloads and Local Music.
 *  - NewOnTheWall, ByGenre: the albums that joined last, and the library by genre.
 *
 * Everything on it is the library's own: no number is made up, and a tile with nothing to show stays
 * away. Nothing that can be clicked lies over anything else that can, and nothing jumps to the front
 * when the pointer is over it: a hover lifts a thing a little, in its place.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronRight, Download, FolderOpen, Pause, Play, Plus, RefreshCw } from "lucide-react";
import { artistTracks, byPlays, useLibraryGenres, useLibraryIndex, type LibAlbum } from "../lib/catalogIndex";
import { fmtBytes, plural } from "../lib/format";
import { T, textLocale } from "../lib/i18n";
import { albumKeyOf } from "../lib/libraryTracks";
import { useCatalog } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { useLibraryOrder } from "../stores/libraryOrder";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import { CoverCollage, QuickTile, playCollection, useArtistPhoto } from "./LibraryCards";
import { LikedCover } from "./LikedCover";
import { useLibraryMixes } from "./MixGallery";
import { Artwork } from "./primitives";

const DAY = 86_400_000;

/** "9 d 4 h", "3 h 20 min": how long everything would play. */
export function fmtLong(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return T("{days} d {hours} h", { days, hours });
  if (hours > 0) return T("{hours} h {minutes} min", { hours, minutes: minutes % 60 });
  return T("{minutes} min", { minutes });
}

/** A week's listening: "53 hrs", "45 min". */
function fmtWeek(ms: number): string {
  const hours = ms / 3_600_000;
  return hours >= 1 ? T("{hours} hrs", { hours: Math.round(hours) }) : T("{minutes} min", { minutes: Math.max(1, Math.round(ms / 60_000)) });
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return T("Good morning");
  if (h >= 12 && h < 18) return T("Good afternoon");
  return T("Good evening");
}

function Count({ value, label }: { value: string; label: string }) {
  return (
    <div>
      {/* Sized by the head's own width (cqi), not the window's: the panels beside it take their share. */}
      <div className="font-black tracking-[-0.03em] text-white whitespace-nowrap" style={{ fontSize: "clamp(18px, 2.6cqi, 26px)" }}>
        {value}
      </div>
      <div className="text-[10.5px] font-extrabold tracking-[0.18em] text-zinc-400 uppercase whitespace-nowrap">{label}</div>
    </div>
  );
}

/**
 * One line of text as large as its box allows, up to `max` px: a long word in another language makes it
 * smaller instead of breaking it or cutting it off. The class goes on the text itself, so a tracking in
 * em follows the size it ends up with.
 */
export function FitLine({ text, max, min = 16, className = "", children }: { text: string; max: number; min?: number; className?: string; children?: React.ReactNode }) {
  const box = useRef<HTMLSpanElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const outer = box.current;
    const inner = line.current;
    if (!outer || !inner) return;
    const fit = (): void => {
      // Measured at the largest size: the width grows with the size.
      inner.style.fontSize = `${max}px`;
      const natural = inner.getBoundingClientRect().width;
      const room = outer.clientWidth;
      if (natural > room && room > 0) inner.style.fontSize = `${Math.max(min, Math.floor((max * room) / natural))}px`;
    };
    fit();
    const seen = new ResizeObserver(fit);
    seen.observe(outer);
    void document.fonts?.ready.then(fit);
    return () => seen.disconnect();
  }, [text, max, min]);
  return (
    // Clipped sideways only: a "g" or "y" reaching below the line stays whole (overflow hidden cut it off).
    <span ref={box} className="block overflow-x-clip whitespace-nowrap">
      <span ref={line} className={`inline-block ${className}`}>
        {children ?? text}
      </span>
    </span>
  );
}

/** A cover wall: the library's covers in a tilted, receding grid. Nothing when there are too few. */
export function CoverWall({ covers, tilt, columns = 7 }: { covers: string[]; tilt: number; columns?: number }) {
  if (covers.length < 6) return null;
  const count = columns * 4;
  return (
    <div
      aria-hidden
      className="absolute left-1/2 -top-[250px] w-[1700px] -ml-[850px] grid gap-3"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, transform: `perspective(1300px) rotateX(40deg) rotateZ(${tilt}deg)`, transformOrigin: "50% 40%" }}
    >
      {Array.from({ length: count }, (_, i) => (
        <img key={i} src={covers[(i * 5 + Math.floor(i / columns) * 3) % covers.length]} alt="" loading="lazy" className="w-full aspect-square object-cover rounded-[10px] block" />
      ))}
    </div>
  );
}

/** One cover per album: a server gives every song of an album its own picture address. */
function albumCovers(tracks: { album?: string; title: string; thumb: string }[], count: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tracks) {
    const album = (t.album || t.title).toLowerCase();
    if (!t.thumb || seen.has(album)) continue;
    seen.add(album);
    out.push(t.thumb);
    if (out.length === count) break;
  }
  return out;
}

interface WeekAlbum {
  key: string;
  name: string;
  artist: string;
  plays: number;
}

/**
 * This week's listening: the time from Replay's days, and the albums by how often their songs were
 * played, from the listening history. Nothing when nothing played.
 */
function useThisWeek(): { ms: number; albums: WeekAlbum[]; loaded: boolean } {
  const [state, setState] = useState<{ ms: number; albums: WeekAlbum[]; loaded: boolean }>({ ms: 0, albums: [], loaded: false });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const since = new Date(Date.now() - 6 * DAY);
      since.setHours(0, 0, 0, 0);
      const sinceDay = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
      let ms = 0;
      for (const period of since.getMonth() === new Date().getMonth() ? ["month"] : ["month", "lastMonth"]) {
        const res = (await window.bytune?.statsSummary(period).catch(() => null)) as { days?: { date: string; ms: number }[] } | null;
        for (const d of res?.days ?? []) if (d.date >= sinceDay) ms += d.ms;
      }
      const byAlbum = new Map<string, WeekAlbum>();
      let before: number | undefined;
      for (let page = 0; page < 6; page++) {
        const res = await window.bytune?.listensPage(before, 200).catch(() => null);
        if (!res?.listens.length) break;
        for (const l of res.listens) {
          if (l.at < since.getTime() || !l.album) continue;
          const key = `${l.album.toLowerCase()}|${l.artist.toLowerCase()}`;
          const row = byAlbum.get(key) ?? { key, name: l.album, artist: l.artist, plays: 0 };
          row.plays += 1;
          byAlbum.set(key, row);
        }
        const last = res.listens[res.listens.length - 1];
        if (!res.more || last.at < since.getTime()) break;
        before = last.at;
      }
      if (alive) setState({ ms, albums: [...byAlbum.values()].sort((a, b) => b.plays - a.plays).slice(0, 3), loaded: true });
    })();
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** The albums by title and artist, and by title alone, for names that come from the listening history. */
function useAlbumFinder(albums: LibAlbum[]): Map<string, LibAlbum> {
  return useMemo(() => {
    const map = new Map<string, LibAlbum>();
    for (const a of albums) {
      map.set(`${a.title.toLowerCase()}|${a.artist.toLowerCase()}`, a);
      if (!map.has(a.title.toLowerCase())) map.set(a.title.toLowerCase(), a);
    }
    return map;
  }, [albums]);
}

/** Over the cover wall the tiles need a ground of their own, or the covers behind show through their names. */
const HEAD_TILE = "bg-[#18181c]/[0.82] hover:bg-[#26262c]/[0.92] backdrop-blur-sm shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]";

/**
 * Quick tiles under the greeting: three full rows, three lanes wide when there's room, else two or one;
 * the way to everything heard is the last cell. A narrower head loses its rightmost lane, and the tiles
 * still come in their order (the first five of eight, not all but the third and the sixth).
 */
const QUICK_ROWS = 3;
const QUICK_LANES = 3;
const QUICK_TILES = QUICK_ROWS * QUICK_LANES - 1;
/** A tile narrower than this cuts its name. */
const QUICK_MIN_WIDTH = 200;
const QUICK_GAP = 10;

interface QuickItem {
  id: string;
  title: string;
  thumb?: string;
  art?: React.ReactNode;
  open: () => void;
  play: () => void;
}

/** An artist's tile picture: their photo, round, inside the tile's square (as Spotify draws artists). */
function ArtistQuickArt({ name, fallback }: { name: string; fallback: string }) {
  const photo = useArtistPhoto(name, fallback);
  return (
    <span className="block w-16 h-16 p-1.5">
      <Artwork src={photo} rounded="rounded-full" className="w-full h-full" iconClassName="w-5 h-5" alt="" />
    </span>
  );
}

export function HomeHead() {
  const { albums, tracks, artists } = useLibraryIndex();
  const playlists = useLibrary((s) => s.playlists);
  const liked = useLibrary((s) => s.liked);
  const history = useLibrary((s) => s.history);
  const played = useLibraryOrder((s) => s.played);
  // Only what was played from since Home counts that way (stores/libraryOrder.ts homeSince): the times
  // guessed once from the history named the albums of single songs heard from a playlist.
  const homeSince = useLibraryOrder((s) => s.homeSince ?? Number.MAX_SAFE_INTEGER);
  const navigate = useUI((s) => s.navigate);
  const current = usePlayer((s) => s.queue[s.index] ?? null);
  const playing = usePlayer((s) => s.playing);
  const mixes = useLibraryMixes();

  const wall = useMemo(() => [...new Set(albums.map((a) => a.thumb).filter(Boolean))], [albums]);
  const seconds = useMemo(() => tracks.reduce((sum, t) => sum + (t.duration || 0), 0), [tracks]);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const albumByKey = useMemo(() => new Map(albums.map((a) => [a.key, a])), [albums]);
  const albumByRoute = useMemo(() => new Map(albums.map((a) => [a.route, a])), [albums]);
  const artistByRoute = useMemo(() => new Map(artists.map((a) => [a.route, a])), [artists]);

  const back = current ?? history[0] ?? null;
  const backAlbum = back ? albumByKey.get(albumKeyOf(byId.get(back.id) ?? back) ?? "") : undefined;

  // Quick access, as on Spotify: what was played last, by where it was started from (an album, a
  // playlist, Liked Songs, an artist: lib/recentlyPlayed.ts), not the albums of single songs; topped up
  // with mixes, playlists and the albums that joined last, so the rows are full whenever the library has
  // that much. The album the cover beside them shows isn't repeated.
  const quick = useMemo(() => {
    const albumTile = (a: LibAlbum): QuickItem => ({
      id: `album:${a.key}`,
      title: a.title,
      thumb: a.thumb,
      open: () => navigate({ name: "album", param: a.route }),
      play: () => usePlayer.getState().playAll(a.tracks),
    });
    const playlistTile = (p: (typeof playlists)[number]): QuickItem => ({
      id: `playlist:${p.id}`,
      title: p.name,
      thumb: p.cover ?? p.tracks[0]?.thumb,
      art: p.cover ? undefined : <CoverCollage tracks={p.tracks} className="w-16 h-16" />,
      open: () => navigate({ name: "playlist", param: p.id }),
      play: () => usePlayer.getState().playAll(p.tracks),
    });
    const recent: QuickItem[] = [];
    for (const id of Object.keys(played).filter((k) => played[k] >= homeSince).sort((a, b) => played[b] - played[a])) {
      if (recent.length >= QUICK_TILES) break;
      if (id === "__liked__") {
        if (liked.length)
          recent.push({
            id: "liked",
            title: T("Liked Songs"),
            art: <LikedCover className="w-16 h-16" heartClassName="w-6 h-6" />,
            open: () => navigate({ name: "library", param: "liked" }),
            play: () => usePlayer.getState().playAll(liked),
          });
        continue;
      }
      const album = albumByRoute.get(id);
      if (album) {
        if (album.key !== backAlbum?.key) recent.push(albumTile(album));
        continue;
      }
      const artist = artistByRoute.get(id);
      if (artist) {
        recent.push({
          id: `artist:${artist.route}`,
          title: artist.name,
          thumb: artist.thumb,
          art: <ArtistQuickArt name={artist.name} fallback={artist.thumb} />,
          open: () => navigate({ name: "artist", param: artist.route }),
          // As the artist's page plays them: their songs, the most played first.
          play: () => playCollection(byPlays(artistTracks(tracks, artist.name), useCatalog.getState().playCounts)),
        });
        continue;
      }
      const playlist = playlists.find((p) => p.id === id);
      if (playlist?.tracks.length) recent.push(playlistTile(playlist));
    }
    const all: QuickItem[] = [
      ...recent,
      ...mixes.map((m) => ({
        id: `mix:${m.id}`,
        title: m.title,
        thumb: m.tracks[0]?.thumb,
        art: <CoverCollage tracks={m.tracks} className="w-16 h-16" />,
        open: () => navigate({ name: "mix", param: m.id }),
        play: () => usePlayer.getState().playAll(m.tracks),
      })),
      ...playlists.filter((p) => p.tracks.length).map(playlistTile),
      ...[...albums]
        .filter((a) => a.key !== backAlbum?.key)
        .sort((a, b) => b.addedAt - a.addedAt)
        .slice(0, QUICK_TILES)
        .map(albumTile),
    ];
    const seen = new Set<string>();
    return all.filter((q) => !seen.has(q.id) && !!seen.add(q.id)).slice(0, QUICK_TILES);
  }, [played, homeSince, liked, albumByRoute, artistByRoute, tracks, mixes, playlists, albums, backAlbum, navigate]);

  // How many lanes the tiles' own width holds; three rows of them, whatever the width.
  const grid = useRef<HTMLDivElement>(null);
  const [lanes, setLanes] = useState(QUICK_LANES);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const fit = (): void => setLanes(Math.max(1, Math.min(QUICK_LANES, Math.floor((el.clientWidth + QUICK_GAP) / (QUICK_MIN_WIDTH + QUICK_GAP)))));
    fit();
    const seen = new ResizeObserver(fit);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const shown = quick.slice(0, QUICK_ROWS * lanes - 1);

  const playBack = (): void => {
    if (!back) return;
    if (current) usePlayer.getState().toggle();
    else usePlayer.getState().playTrack(back);
  };

  // "Good evening" → "Good " and "evening.", the last word in the accent.
  const words = greeting();
  const cut = words.lastIndexOf(" ");
  const lead = cut > 0 ? words.slice(0, cut + 1) : "";
  const last = `${cut > 0 ? words.slice(cut + 1) : words}.`;

  return (
    <div className="page-bleed -mt-5 relative overflow-hidden bg-[#08080a]" style={{ containerType: "inline-size" }}>
      {/* The wall is gone before the head's foot: where the head's layers meet the page below, no cover can show through. */}
      <div aria-hidden className="absolute inset-0" style={{ maskImage: "linear-gradient(180deg, #000 78%, transparent 97%)", WebkitMaskImage: "linear-gradient(180deg, #000 78%, transparent 97%)" }}>
        <CoverWall covers={wall} tilt={12} />
      </div>
      <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgb(var(--page-bg) / 0.94) 0%, rgb(var(--page-bg) / 0.6) 50%, rgb(var(--page-bg) / 0.25) 100%), linear-gradient(180deg, transparent 35%, rgb(var(--page-bg)) 100%)" }} />
      <div className="relative page-pad w-full pt-9 pb-8 min-h-[460px] flex flex-col gap-10">
        {/* The greeting and the numbers share the head's first line; the block below sits at its foot. */}
        <div className="flex items-end gap-x-8 gap-y-4 flex-wrap">
          {/* Room on the right: the italic word leans out of its box, and the numbers mustn't touch it. */}
          <h1 className="flex-[1_1_260px] min-w-0 pr-5 font-display font-black tracking-[-0.05em] leading-[1.05] text-white">
            <FitLine text={words} max={64} min={30}>
              {lead}
              <span className="italic text-accent">{last}</span>
            </FitLine>
          </h1>
          <div className="flex gap-x-7 gap-y-2 flex-wrap pb-1">
            <Count value={albums.length.toLocaleString()} label={T("ALBUMS")} />
            <Count value={tracks.length.toLocaleString()} label={T("SONGS")} />
            <Count value={playlists.length.toLocaleString()} label={T("PLAYLISTS")} />
            {seconds > 0 && <Count value={fmtLong(seconds)} label={T("OF MUSIC")} />}
          </div>
        </div>

        {/* Too narrow for the cover and the tiles side by side, the tiles go under it: squeezed, their names would be cut. */}
        <div className="mt-auto flex flex-wrap gap-3.5 items-start">
          {/* What plays: its cover, what it is and from which album, Play/Pause. Nothing else, and nothing
              clickable but the button: the words get the cover's whole width under it. */}
          {back && (
            <div
              className="relative shrink-0 aspect-square rounded-2xl overflow-hidden shadow-[0_18px_40px_-16px_rgba(0,0,0,0.9),inset_0_0_0_1px_rgba(255,255,255,0.08)]"
              style={{ width: "clamp(160px, 24cqi, 212px)", containerType: "inline-size" }}
            >
              <Artwork src={back.thumb} className="w-full h-full" rounded="rounded-none" alt="" />
              <span aria-hidden className="absolute inset-0 bg-gradient-to-b from-transparent from-[30%] to-black/[0.9]" />
              <span className="absolute left-3.5 right-3.5 bottom-3 min-w-0">
                <span className="block text-[10px] font-extrabold tracking-[0.2em] text-zinc-300 truncate">{current ? T("NOW PLAYING") : T("JUMP BACK IN")}</span>
                <span className="block mt-1 font-black tracking-[-0.02em] text-white truncate" style={{ fontSize: "clamp(14px, 8.6cqi, 18px)" }}>
                  {back.title}
                </span>
                {(back.album || backAlbum?.title) && <span className="block text-[12.5px] text-zinc-300 truncate">{back.album || backAlbum?.title}</span>}
              </span>
              <button
                onClick={playBack}
                title={current && playing ? T("Pause") : T("Play")}
                aria-label={current && playing ? T("Pause") : T("Play {title}", { title: back.title })}
                className="absolute right-3 top-3 w-12 h-12 rounded-full bg-accent text-[#0b0b0d] grid place-items-center shadow-[0_8px_20px_rgba(0,0,0,0.45)] hover:brightness-110 active:scale-95 transition-all"
              >
                {current && playing ? <Pause className="w-[18px] h-[18px] fill-current" /> : <Play className="w-[18px] h-[18px] fill-current ml-0.5" />}
              </button>
            </div>
          )}
          {/* Three rows, as many lanes as there's room for (QUICK_LANES at most); the way to everything heard last. */}
          <div ref={grid} className="flex-[1_1_270px] min-w-0 grid gap-2.5" style={{ gridTemplateColumns: `repeat(${lanes}, minmax(0, 1fr))` }}>
            {shown.map((q) => (
              <QuickTile key={q.id} title={q.title} thumb={q.thumb} art={q.art} onOpen={q.open} onPlay={q.play} className={HEAD_TILE} />
            ))}
            {/* The listening history as a page of its own (HeardView): every song heard, newest first. */}
            <button
              onClick={() => navigate({ name: "heard" })}
              className="h-16 rounded-md bg-[#18181c]/[0.55] hover:bg-[#232329]/[0.8] backdrop-blur-sm shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] flex items-center justify-center gap-2 text-[14px] font-bold text-ink transition-colors"
            >
              {T("Everything you heard")}
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** `classic`: as on the Your Library page before 2026-11-21, with big boxes for Downloads and Local Music. */
export function LibraryTiles({ downloaded, classic = false }: { downloaded: number; classic?: boolean }) {
  const { albums } = useLibraryIndex();
  const liked = useLibrary((s) => s.liked);
  const navigate = useUI((s) => s.navigate);
  const week = useThisWeek();
  const albumByKey = useAlbumFinder(albums);
  const likedCovers = useMemo(() => albumCovers(liked, 3), [liked]);
  const maxPlays = Math.max(1, ...week.albums.map((a) => a.plays));

  // The Liked Songs tile scales its title and covers with its own width: one line, whatever the language.
  const likedTile: CSSProperties = {
    containerType: "inline-size",
    background: "linear-gradient(135deg, rgb(var(--accent)) 0%, rgb(var(--accent) / 0.55) 55%, rgb(var(--accent) / 0.2) 100%), #17121f",
  };
  const coverSize = (px: number, share: number): string => `min(${px}px, ${share}cqi)`;

  return (
    <div className="flex gap-[18px] flex-wrap mt-5">
      {/* Liked Songs: the accent, with its newest covers thrown on — the tile opens it, its round button plays it. */}
      <div className={`relative ${classic ? "flex-[5_1_340px]" : "flex-[5_1_280px]"} min-w-0 h-[280px] rounded-[20px] overflow-hidden`} style={likedTile}>
        <button onClick={() => navigate({ name: "library", param: "liked" })} aria-label={T("Liked Songs")} className="absolute inset-0 text-left hover:brightness-105 transition-[filter]">
          {/* The newest covers as a small fan in the upper right: never behind the words. */}
          {likedCovers[1] && (
            <img src={likedCovers[1]} alt="" className="absolute rounded-[10px] object-cover shadow-[0_18px_40px_rgba(0,0,0,0.45)]" style={{ width: coverSize(118, 21), height: coverSize(118, 21), right: "31cqi", top: "9%", transform: "rotate(-12deg)" }} />
          )}
          {likedCovers[2] && (
            <img src={likedCovers[2]} alt="" className="absolute rounded-[10px] object-cover shadow-[0_18px_40px_rgba(0,0,0,0.45)]" style={{ width: coverSize(118, 21), height: coverSize(118, 21), right: "4cqi", top: "5%", transform: "rotate(10deg)" }} />
          )}
          {likedCovers[0] && (
            <img src={likedCovers[0]} alt="" className="absolute rounded-[12px] object-cover shadow-[0_24px_50px_rgba(0,0,0,0.55)]" style={{ width: coverSize(146, 26), height: coverSize(146, 26), right: "16cqi", top: "13%", transform: "rotate(-3deg)" }} />
          )}
          <span className="absolute left-[24px] right-[100px] bottom-[22px]">
            {/* The count on a dark pill: readable on any accent and over any cover. */}
            <span className="inline-flex max-w-full rounded-full bg-[#0b0b0d]/75 backdrop-blur-sm px-3 py-[5px] mb-2 text-[12.5px] font-semibold text-white/90 shadow-[0_4px_14px_rgba(0,0,0,0.25)]">
              <span className="truncate">
                {liked.length ? T("{count} · newest: {title}", { count: plural(liked.length, T("song"), T("songs")), title: liked[0].title }) : T("Nothing liked yet")}
              </span>
            </span>
            <FitLine text={T("Liked Songs")} max={62} min={22} className="font-black tracking-[-0.05em] leading-[1.1] text-[#0b0b0d]" />
          </span>
        </button>
        {liked.length > 0 && (
          <button
            onClick={() => usePlayer.getState().playAll(liked)}
            title={T("Play Liked Songs")}
            aria-label={T("Play Liked Songs")}
            className="absolute right-[22px] bottom-[22px] w-[60px] h-[60px] rounded-full bg-[#0b0b0d] text-white grid place-items-center hover:scale-105 active:scale-95 transition-transform"
          >
            <Play className="w-[22px] h-[22px] fill-current" />
          </button>
        )}
      </div>

      {/* This week: the three albums played most, each row filled as far as its plays reach. */}
      <div className={`${classic ? "flex-[4_1_300px]" : "flex-[4_1_240px]"} min-w-0 h-[280px] rounded-[20px] bg-[#141418] px-5 pt-5 pb-4 flex flex-col`}>
        <div className="flex items-baseline gap-3 px-1">
          <span className="text-[22px] font-black tracking-[-0.02em] text-white flex-1 truncate">{T("This week")}</span>
          {week.ms > 0 && <span className="text-[13px] font-semibold text-zinc-400 whitespace-nowrap">{fmtWeek(week.ms)}</span>}
        </div>
        <div className="flex flex-col gap-2 mt-3.5">
          {week.albums.map((a, i) => {
            // The album's own page when the library has it, else Replay, where the listening is.
            const album = albumByKey.get(a.key) ?? albumByKey.get(a.name.toLowerCase());
            return (
              <button
                key={a.key}
                onClick={() => navigate(album ? { name: "album", param: album.route } : { name: "replay" })}
                title={`${a.name} · ${a.artist}`}
                className="group relative flex items-center gap-3 text-left rounded-xl p-1.5 pr-3 overflow-hidden bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
              >
                <span aria-hidden className="absolute inset-y-0 left-0 bg-accent/[0.14] transition-[width] duration-500" style={{ width: `${Math.max(12, (a.plays / maxPlays) * 100)}%` }} />
                <Artwork src={album?.thumb ?? ""} className="relative w-[46px] h-[46px] shrink-0" rounded="rounded-lg" alt="" />
                <span className="relative flex-1 min-w-0">
                  <span className="block text-[14px] font-bold text-white truncate">{a.name}</span>
                  <span className="block text-[12px] text-zinc-400 truncate mt-0.5">{[a.artist, plural(a.plays, T("play"), T("plays"))].filter(Boolean).join(" · ")}</span>
                </span>
                <span className={`relative text-[13px] font-black tabular-nums ${i === 0 ? "text-accent" : "text-zinc-500"}`}>{i + 1}</span>
              </button>
            );
          })}
        </div>
        {week.loaded && week.albums.length === 0 && (
          <p className="text-[13.5px] text-zinc-400 mt-3 px-1">
            {/* Time counted but no songs: the listening history was cleared since. */}
            {week.ms > 0 ? T("This week's songs aren't in your listening history.") : T("Nothing played this week yet. What you play shows up here.")}
          </p>
        )}
      </div>

      {/* Downloads and Local Music, big as on the Your Library page before. */}
      {classic ? (
        <div className="flex-[3_1_220px] min-w-0 flex flex-col gap-[18px]">
          <button onClick={() => navigate({ name: "library", param: "downloaded" })} className="flex-1 min-h-[131px] rounded-[20px] px-5 py-[18px] flex flex-col justify-between text-left hover:brightness-110 transition-[filter]" style={{ background: "linear-gradient(140deg, #0f766e, #134e4a)" }}>
            <Download className="w-[26px] h-[26px] text-white" />
            <span>
              <span className="block text-[24px] font-black tracking-[-0.03em] text-white">{T("Downloads")}</span>
              <span className="block text-[12px] font-semibold text-white/75">{downloaded ? T("{count} ready offline", { count: plural(downloaded, T("song"), T("songs")) }) : T("Nothing downloaded yet")}</span>
            </span>
          </button>
          <button onClick={() => navigate({ name: "local" })} className="flex-1 min-h-[131px] rounded-[20px] px-5 py-[18px] flex flex-col justify-between text-left hover:brightness-110 transition-[filter]" style={{ background: "linear-gradient(140deg, #b45309, #7c2d12)" }}>
            <FolderOpen className="w-[26px] h-[26px] text-white" />
            <span>
              <span className="block text-[24px] font-black tracking-[-0.03em] text-white">{T("Local Music")}</span>
              <span className="block text-[12px] font-semibold text-white/75">{T("On this device")}</span>
            </span>
          </button>
        </div>
      ) : (
        /* Downloads and Local Music beside this week, telling what they hold and what's going on (the user's pick "B", 2026-11-22). */
        <div className="flex-[2.8_1_190px] min-w-0 flex flex-col gap-[18px]">
          <DownloadsBox />
          <LocalMusicBox />
        </div>
      )}
    </div>
  );
}

/** A small rounded label on Home's boxes ("All here", "+5 new since yesterday"). */
function BoxTag({ tone, children }: { tone: "green" | "amber" | "red"; children: React.ReactNode }) {
  const look = tone === "green" ? "bg-[#4ade80]/[0.14] text-[#86efac]" : tone === "amber" ? "bg-[#fbbf24]/[0.16] text-[#fde68a]" : "bg-[#f87171]/[0.16] text-[#fca5a5]";
  return <span className={`inline-flex self-start max-w-full items-center gap-1 h-[22px] px-2 rounded-full text-[11px] font-extrabold whitespace-nowrap ${look}`}>{children}</span>;
}

/**
 * Downloads: the song on its way with its progress and how many more follow; else how many songs are
 * here and how much room they take, with a mark when all of them are (or how many failed); empty, how to
 * get some. The whole box opens the Downloads list.
 */
function DownloadsBox() {
  const downloads = useLibrary((s) => s.downloads);
  const navigate = useUI((s) => s.navigate);
  const { done, failed, current, waiting, bytes } = useMemo(() => {
    const items = Object.values(downloads).filter((d) => d.status !== "removed");
    const doneItems = items.filter((d) => d.status === "done");
    return {
      done: doneItems.length,
      failed: items.filter((d) => d.status === "failed").length,
      current: items.find((d) => d.status === "downloading") ?? null,
      waiting: items.filter((d) => d.status === "downloading" || d.status === "queued").length,
      bytes: doneItems.reduce((sum, d) => sum + (d.total || 0), 0),
    };
  }, [downloads]);
  const percent = current ? Math.round(Math.max(0, Math.min(1, current.progress)) * 100) : 0;
  return (
    <button
      onClick={() => navigate({ name: "library", param: "downloaded" })}
      className="flex-1 min-h-[120px] min-w-0 rounded-[20px] px-4 py-3.5 flex flex-col gap-2 text-left overflow-hidden hover:brightness-110 transition-[filter]"
      style={{ background: "linear-gradient(150deg, #0f3d38, #102624 60%, #121417)", boxShadow: "inset 0 0 0 1px rgba(45,212,191,0.18)" }}
    >
      <span className="flex items-center gap-2.5 min-w-0">
        <span className="w-[30px] h-[30px] shrink-0 rounded-full grid place-items-center bg-[#2dd4bf]/[0.18] text-[#5eead4]">
          <Download className="w-4 h-4" />
        </span>
        <FitLine text={T("Downloads")} max={17} min={13} className="flex-1 min-w-0 font-black tracking-[-0.02em] text-white" />
        <ChevronRight className="w-4 h-4 shrink-0 text-white/50" />
      </span>
      {current ? (
        <>
          <span className="flex items-center gap-2 min-w-0 text-[12px] font-semibold text-white/80">
            <Artwork src={current.track.thumb} className="w-[26px] h-[26px] shrink-0" rounded="rounded" alt="" />
            <span className="flex-1 min-w-0 truncate">{current.track.title}</span>
            <span className="shrink-0 font-bold tabular-nums text-[#5eead4]">{percent} %</span>
          </span>
          <span className="block h-[5px] rounded-full bg-white/[0.14] overflow-hidden">
            <span className="block h-full rounded-full bg-gradient-to-r from-[#2dd4bf] to-[#5eead4] transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </span>
          {waiting > 1 && <span className="text-[11.5px] font-semibold text-white/65 truncate">{T("{count} more on the way", { count: waiting - 1 })}</span>}
        </>
      ) : done > 0 ? (
        <>
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="text-[30px] leading-none font-black tracking-[-0.04em] tabular-nums text-white">{done.toLocaleString(textLocale())}</span>
            <span className="min-w-0 truncate text-[12px] font-semibold text-white/70">{[done === 1 ? T("song") : T("songs"), bytes > 0 ? fmtBytes(bytes) : ""].filter(Boolean).join(" · ")}</span>
          </span>
          {failed > 0 ? (
            <BoxTag tone="red">{T("{count} failed", { count: failed })}</BoxTag>
          ) : (
            <BoxTag tone="green">
              <Check className="w-3 h-3" />
              {T("All here")}
            </BoxTag>
          )}
        </>
      ) : (
        <span className="text-[12.5px] leading-snug font-semibold text-white/75">{T("Right-click → Download")}</span>
      )}
    </button>
  );
}

/** What the local folders hold, from the main process's scan: songs, folders and what joined in the last day. */
function useLocalSummary(): [{ songs: number; folders: number; fresh: number; loaded: boolean }, (lib: unknown) => void] {
  const [summary, setSummary] = useState({ songs: 0, folders: 0, fresh: 0, loaded: false });
  const take = (lib: unknown): void => {
    const l = lib as { folders?: unknown[]; tracks?: { addedAt?: number }[] } | null | undefined;
    if (!l) return;
    const tracks = Array.isArray(l.tracks) ? l.tracks : [];
    const since = Date.now() - DAY;
    setSummary({ songs: tracks.length, folders: Array.isArray(l.folders) ? l.folders.length : 0, fresh: tracks.filter((t) => (t.addedAt ?? 0) > since).length, loaded: true });
  };
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void window.bytune?.localLibrary().then((l: unknown) => alive && take(l)).catch(() => undefined);
    };
    load();
    // A song downloaded into a folder, or a folder added elsewhere, comes with a fresh scan.
    const onChanged = (e: Event): void => {
      const detail = (e as CustomEvent).detail;
      if (detail) take(detail);
      else load();
    };
    window.addEventListener("bytune:local-library-updated", onChanged);
    return () => {
      alive = false;
      window.removeEventListener("bytune:local-library-updated", onChanged);
    };
  }, []);
  return [summary, take];
}

/**
 * Local Music: how many songs in how many folders and what joined in the last day, with a rescan right
 * in the box; empty, a button that adds a folder. The box itself opens Local Music (its button lies
 * under the others: a button inside a button isn't allowed).
 */
function LocalMusicBox() {
  const [summary, take] = useLocalSummary();
  const navigate = useUI((s) => s.navigate);
  const toast = useUI((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const filterNonMusic = useSettings((s) => s.filterNonMusicAudio);

  const rescan = async (): Promise<void> => {
    if (!window.bytune || busy) return;
    setBusy(true);
    try {
      take(await window.bytune.scanLibrary(filterNonMusic));
      toast(T("Local library scanned"), "success");
    } catch {
      toast(T("Scan failed"), "error");
    } finally {
      setBusy(false);
    }
  };
  const addFolder = async (): Promise<void> => {
    if (!window.bytune || busy) return;
    const dir = await window.bytune.pickFolder();
    if (!dir) return;
    setBusy(true);
    try {
      const res = (await window.bytune.addLibraryFolders([dir])) as { added: { name: string }[] };
      if (!res.added.length) {
        toast(T("That folder is already in your library"), "info");
        return;
      }
      useSettings.getState().setLocalMusicFolder(dir);
      take(await window.bytune.scanLibrary(filterNonMusic));
      toast(T("Imported \"{name}\"", { name: res.added[0].name }), "success");
    } catch {
      toast(T("Couldn't import that folder"), "error");
    } finally {
      setBusy(false);
    }
  };

  const empty = summary.loaded && summary.songs === 0 && summary.folders === 0;
  return (
    <div
      className="relative flex-1 min-h-[120px] min-w-0 rounded-[20px] overflow-hidden"
      style={{ background: "linear-gradient(150deg, #4a2a0b, #2a1a0c 60%, #151312)", boxShadow: "inset 0 0 0 1px rgba(251,191,36,0.18)" }}
    >
      <button onClick={() => navigate({ name: "local" })} aria-label={T("Local Music")} className="absolute inset-0 hover:bg-white/[0.04] transition-colors" />
      <div className="pointer-events-none relative h-full px-4 py-3.5 flex flex-col gap-2">
        <span className="flex items-center gap-2.5 min-w-0">
          <span className="w-[30px] h-[30px] shrink-0 rounded-full grid place-items-center bg-[#fbbf24]/[0.16] text-[#fcd34d]">
            <FolderOpen className="w-4 h-4" />
          </span>
          <FitLine text={T("Local Music")} max={17} min={13} className="flex-1 min-w-0 font-black tracking-[-0.02em] text-white" />
          {!empty && (
            <button
              onClick={() => void rescan()}
              title={T("Rescan")}
              aria-label={T("Rescan")}
              className="pointer-events-auto w-[26px] h-[26px] shrink-0 rounded-full grid place-items-center bg-white/10 text-white hover:bg-white/20 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
            </button>
          )}
        </span>
        {empty ? (
          <button
            onClick={() => void addFolder()}
            className="pointer-events-auto mt-auto self-start max-w-full inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full bg-[#fbbf24] text-[#1c1206] text-[12.5px] font-extrabold whitespace-nowrap hover:brightness-110 transition-[filter]"
          >
            <Plus className="w-3.5 h-3.5" />
            {T("Add a folder")}
          </button>
        ) : (
          <>
            <span className="flex items-baseline gap-2 min-w-0">
              <span className="text-[30px] leading-none font-black tracking-[-0.04em] tabular-nums text-white">{summary.songs.toLocaleString(textLocale())}</span>
              <span className="min-w-0 truncate text-[12px] font-semibold text-white/70">
                {[summary.songs === 1 ? T("song") : T("songs"), plural(summary.folders, T("folder"), T("folders"))].join(" · ")}
              </span>
            </span>
            {summary.fresh > 0 && <BoxTag tone="amber">{T("+{count} new since yesterday", { count: summary.fresh })}</BoxTag>}
          </>
        )}
      </div>
    </div>
  );
}

/** The albums that joined last, tilted on the wall. */
export function NewOnTheWall() {
  const { albums } = useLibraryIndex();
  const navigate = useUI((s) => s.navigate);
  const fresh = useMemo(() => [...albums].filter((a) => a.thumb && a.addedAt > 0).sort((a, b) => b.addedAt - a.addedAt).slice(0, 6), [albums]);
  if (fresh.length < 3) return null;
  const turns = [-4, 3, -2, 4, -3, 2];
  return (
    <section className="mt-10">
      <h2 className="text-[30px] font-black tracking-[-0.03em] text-ink-hi mb-5">{T("New on the wall")}</h2>
      {/* Side by side with room between them: tilted, never over each other; as many a row as the
          section's own width holds (a window's width says nothing while the panels are open). */}
      <div className="grid gap-[22px] py-2 px-1.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(140px, 28%), 1fr))" }}>
        {fresh.map((a, i) => (
          <button
            key={a.key}
            onClick={() => navigate({ name: "album", param: a.route })}
            title={`${a.title} · ${a.artist}`}
            className="block rounded-[10px] overflow-hidden shadow-[0_18px_40px_-12px_rgba(0,0,0,0.85)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1.5 hover:shadow-[0_26px_50px_-12px_rgba(0,0,0,0.95)]"
            style={{ rotate: `${turns[i]}deg` }}
          >
            <img src={a.thumb} alt="" className="w-full aspect-square object-cover block" />
          </button>
        ))}
      </div>
      <p className="text-[13px] text-ink-dim mt-4">{T("{count} joined last — the newest is {title}.", { count: plural(fresh.length, T("album"), T("albums")), title: fresh[0].title })}</p>
    </section>
  );
}

/** The library by genre: a tile each, its cover blurred behind the name. */
export function ByGenre() {
  const genres = useLibraryGenres();
  const navigate = useUI((s) => s.navigate);
  const byGenre = useMemo(
    () =>
      genres
        .filter((g) => g.albumCount > 0)
        .slice(0, 5)
        .map((g) => ({ ...g, cover: g.tracks.find((t) => t.thumb)?.thumb ?? "" })),
    [genres]
  );
  if (!byGenre.length) return null;
  return (
    <section className="mt-12">
      <h2 className="text-[30px] font-black tracking-[-0.03em] text-ink-hi mb-5">{T("By genre")}</h2>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
        {byGenre.map((g) => (
          <button key={g.key} onClick={() => navigate({ name: "genre", param: g.route })} className="relative h-[92px] rounded-[14px] overflow-hidden bg-[#17171b] text-left group">
            {g.cover && <img src={g.cover} alt="" className="absolute -left-[20%] -top-[80%] w-[140%] h-[260%] object-cover blur-[18px] saturate-[1.7] brightness-[0.7] transition-[filter] group-hover:brightness-[0.85]" />}
            <span className="absolute left-3.5 bottom-2.5 right-3">
              <FitLine text={g.name} max={22} min={13} className="font-black tracking-[-0.03em] text-white" />
            </span>
            <span className="absolute right-3 top-2.5 text-[11px] font-extrabold text-white/80">{plural(g.albumCount, T("album"), T("albums"))}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
