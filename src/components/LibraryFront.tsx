/**
 * The Your Library page around the playlists (views/LibraryView.tsx), after its mockup:
 *
 *  - LibraryFront: a wall of the library's covers behind its name and numbers, "Jump back in", and a
 *    row of tiles — Liked Songs with its newest covers, what played this week, Downloads and Local
 *    Music.
 *  - LibraryShelves: the albums that joined last, and the library by genre.
 *
 * Everything on it is the library's own: no number is made up, and a tile with nothing to show stays
 * away. Nothing that can be clicked lies over anything else that can, and nothing jumps to the front
 * when the pointer is over it: a hover lifts a thing a little, in its place.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Download, FolderOpen, Pause, Play } from "lucide-react";
import { useLibraryGenres, useLibraryIndex } from "../lib/catalogIndex";
import { plural } from "../lib/format";
import { T } from "../lib/i18n";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { Artwork } from "./primitives";

const DAY = 86_400_000;

/** "9 d 4 h", "3 h 20 min": how long everything would play. */
function fmtLong(seconds: number): string {
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

function Count({ value, label }: { value: string; label: string }) {
  return (
    <div>
      {/* Sized by the header's own width (cqi), not the window's: the panels beside it take their share. */}
      <div className="font-black tracking-[-0.03em] text-white" style={{ fontSize: "clamp(22px, 4cqi, 34px)" }}>
        {value}
      </div>
      <div className="text-[10.5px] font-extrabold tracking-[0.18em] text-zinc-400 uppercase">{label}</div>
    </div>
  );
}

/**
 * One line of text as large as its box allows, up to `max` px: a long word in another language makes it
 * smaller instead of breaking it or cutting it off. The class goes on the text itself, so a tracking in
 * em follows the size it ends up with.
 */
function FitLine({ text, max, min = 16, className = "" }: { text: string; max: number; min?: number; className?: string }) {
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
        {text}
      </span>
    </span>
  );
}

/** A cover wall: the library's covers in a tilted, receding grid. Nothing when there are too few. */
function CoverWall({ covers, tilt, columns = 7 }: { covers: string[]; tilt: number; columns?: number }) {
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

export function LibraryFront({ downloaded }: { downloaded: number }) {
  const { albums, tracks } = useLibraryIndex();
  const liked = useLibrary((s) => s.liked);
  const playlists = useLibrary((s) => s.playlists);
  const history = useLibrary((s) => s.history);
  const navigate = useUI((s) => s.navigate);
  const current = usePlayer((s) => s.queue[s.index] ?? null);
  const playing = usePlayer((s) => s.playing);
  const week = useThisWeek();

  const wall = useMemo(() => [...new Set(albums.map((a) => a.thumb).filter(Boolean))], [albums]);
  const seconds = useMemo(() => tracks.reduce((sum, t) => sum + (t.duration || 0), 0), [tracks]);
  const albumByKey = useMemo(() => {
    const map = new Map<string, (typeof albums)[number]>();
    for (const a of albums) {
      map.set(`${a.title.toLowerCase()}|${a.artist.toLowerCase()}`, a);
      if (!map.has(a.title.toLowerCase())) map.set(a.title.toLowerCase(), a);
    }
    return map;
  }, [albums]);
  const likedCovers = useMemo(() => albumCovers(liked, 3), [liked]);

  const back = current ?? history[0] ?? null;
  const maxPlays = Math.max(1, ...week.albums.map((a) => a.plays));

  const jumpBack = (): void => {
    if (!back) return;
    if (current) usePlayer.getState().toggle();
    else usePlayer.getState().playTrack(back);
  };

  // The Liked Songs tile scales its title and covers with its own width: one line, whatever the language.
  const likedTile: CSSProperties = {
    containerType: "inline-size",
    background: "linear-gradient(135deg, rgb(var(--accent)) 0%, rgb(var(--accent) / 0.55) 55%, rgb(var(--accent) / 0.2) 100%), #17121f",
  };
  const coverSize = (px: number, share: number): string => `min(${px}px, ${share}cqi)`;

  return (
    <div>
      <div className="page-bleed -mt-5 relative overflow-hidden bg-[#08080a] min-h-[460px] flex items-end" style={{ containerType: "inline-size" }}>
        <CoverWall covers={wall} tilt={12} />
        <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgb(var(--page-bg) / 0.94) 0%, rgb(var(--page-bg) / 0.6) 50%, rgb(var(--page-bg) / 0.25) 100%), linear-gradient(180deg, transparent 55%, rgb(var(--page-bg)) 100%)" }} />
        <div className="relative page-pad w-full pb-9 pt-24">
          {/* The name across the whole header; the numbers and the song to go back to share the row beneath. */}
          <h1 className="font-display font-black tracking-[-0.06em] leading-[0.9] text-white break-words" style={{ fontSize: "clamp(36px, 12.5cqi, 104px)" }}>
            {T("Your")}
            <br />
            <span className="italic text-accent">{T("Library.")}</span>
          </h1>
          <div className="flex items-end gap-7 flex-wrap mt-6">
            <div className="flex-1 basis-[300px] min-w-0 flex gap-x-8 gap-y-3 flex-wrap">
              <Count value={albums.length.toLocaleString()} label={T("ALBUMS")} />
              <Count value={tracks.length.toLocaleString()} label={T("SONGS")} />
              <Count value={playlists.length.toLocaleString()} label={T("PLAYLISTS")} />
              {seconds > 0 && <Count value={fmtLong(seconds)} label={T("OF MUSIC")} />}
            </div>
            {back && (
              <div className="flex items-center gap-3 p-3 pr-4 rounded-2xl bg-[#0f0f12]/75 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] backdrop-blur-sm max-w-full">
                {/* In a narrow header the cover gives the title room. */}
                <div className="shrink-0" style={{ width: "clamp(52px, 17cqi, 84px)", height: "clamp(52px, 17cqi, 84px)" }}>
                  <Artwork src={back.thumb} className="w-full h-full" rounded="rounded-[10px]" alt="" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10.5px] font-extrabold tracking-[0.2em] text-zinc-400 truncate">{current ? T("NOW PLAYING") : T("JUMP BACK IN")}</div>
                  <div className="font-extrabold tracking-[-0.02em] text-white truncate max-w-[240px]" style={{ fontSize: "clamp(16px, 4.5cqi, 20px)" }}>
                    {back.title}
                  </div>
                  <div className="text-[12.5px] text-zinc-400 truncate max-w-[240px]">{back.artist}</div>
                </div>
                <button
                  onClick={jumpBack}
                  title={current && playing ? T("Pause") : T("Play")}
                  aria-label={current && playing ? T("Pause") : T("Play {title}", { title: back.title })}
                  className="ml-1 w-12 h-12 shrink-0 rounded-full bg-accent text-[#0b0b0d] grid place-items-center hover:brightness-110 active:scale-95 transition-all"
                >
                  {current && playing ? <Pause className="w-[18px] h-[18px] fill-current" /> : <Play className="w-[18px] h-[18px] fill-current" />}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-[18px] flex-wrap mt-5">
        {/* Liked Songs: the accent, with its newest covers thrown on — the tile opens it, its round button plays it. */}
        <div className="relative flex-[5_1_340px] min-w-0 h-[280px] rounded-[20px] overflow-hidden" style={likedTile}>
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
        <div className="flex-[4_1_300px] min-w-0 h-[280px] rounded-[20px] bg-[#141418] px-5 pt-5 pb-4 flex flex-col">
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

        {/* Downloads and Local music. */}
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
      </div>
    </div>
  );
}

/** Under the page's head, above the playlists: the albums that joined last, and the library by genre. */
export function LibraryShelves() {
  const { albums } = useLibraryIndex();
  const genres = useLibraryGenres();
  const navigate = useUI((s) => s.navigate);
  const fresh = useMemo(() => [...albums].filter((a) => a.thumb && a.addedAt > 0).sort((a, b) => b.addedAt - a.addedAt).slice(0, 6), [albums]);
  const byGenre = useMemo(
    () =>
      genres
        .filter((g) => g.albumCount > 0)
        .slice(0, 4)
        .map((g) => ({ ...g, cover: g.tracks.find((t) => t.thumb)?.thumb ?? "" })),
    [genres]
  );
  if (fresh.length < 3 && byGenre.length === 0) return null;
  const turns = [-4, 3, -2, 4, -3, 2];

  return (
    <div className="flex gap-[18px] flex-wrap mt-10">
      {fresh.length >= 3 && (
        <section className="flex-[7_1_420px] min-w-0">
          <h2 className="text-[30px] font-black tracking-[-0.03em] text-ink-hi mb-5">{T("New on the wall")}</h2>
          {/* Side by side with room between them: tilted, never over each other; as many a row as the
              section's own width holds (a window's width says nothing while the panels are open). */}
          <div className="grid gap-4 py-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(84px, 1fr))" }}>
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
      )}
      {byGenre.length > 0 && (
        <section className="flex-[5_1_320px] min-w-0">
          <h2 className="text-[30px] font-black tracking-[-0.03em] text-ink-hi mb-5">{T("By genre")}</h2>
          <div className="grid grid-cols-2 gap-3">
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
      )}
    </div>
  );
}
