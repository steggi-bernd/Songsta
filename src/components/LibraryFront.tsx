/**
 * The front of the Your Library page: a wall of the library's covers behind its name and numbers,
 * "Jump back in" for what played last, and a grid of tiles under it — Liked Songs with its newest
 * covers, what played most this month, Downloads, Local music, and the albums that joined last.
 * Everything on it is the library's own: no number is made up, and a tile with nothing to show
 * stays away. The playlists and folders follow below it (views/LibraryView.tsx).
 */
import { useEffect, useMemo, useState } from "react";
import { Download, FolderOpen, Play } from "lucide-react";
import { useLibraryIndex } from "../lib/catalogIndex";
import { plural } from "../lib/format";
import { T } from "../lib/i18n";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { Artwork } from "./primitives";

interface MonthAlbum {
  name: string;
  artist?: string;
  thumb?: string;
  ms: number;
}

/** "9 d 4 h", "3 h 20 min": how long everything would play. */
function fmtLong(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return T("{days} d {hours} h", { days, hours });
  if (hours > 0) return T("{hours} h {minutes} min", { hours, minutes: minutes % 60 });
  return T("{minutes} min", { minutes });
}

const fmtShort = (ms: number): string => {
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? T("{hours} h {minutes}", { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, "0") }) : T("{minutes} min", { minutes });
};

function Count({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-[clamp(22px,2.6vw,34px)] font-black tracking-[-0.03em] text-white">{value}</div>
      <div className="text-[10.5px] font-extrabold tracking-[0.18em] text-zinc-400">{label}</div>
    </div>
  );
}

export function LibraryFront({ downloaded }: { downloaded: number }) {
  const { albums, tracks } = useLibraryIndex();
  const liked = useLibrary((s) => s.liked);
  const playlists = useLibrary((s) => s.playlists);
  const history = useLibrary((s) => s.history);
  const navigate = useUI((s) => s.navigate);
  const current = usePlayer((s) => s.queue[s.index] ?? null);
  const playing = usePlayer((s) => s.playing);

  // What played most this month, as Replay counts it; nothing shows until something did.
  const [month, setMonth] = useState<MonthAlbum[]>([]);
  useEffect(() => {
    let alive = true;
    void window.bytune
      ?.statsSummary("month")
      .then((res) => {
        const albumsOf = (res as { albums?: MonthAlbum[] } | null)?.albums;
        if (alive && Array.isArray(albumsOf)) setMonth(albumsOf.filter((a) => a.ms >= 60_000).slice(0, 4));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const wall = useMemo(() => {
    const covers = [...new Set(albums.map((a) => a.thumb).filter(Boolean))];
    if (covers.length < 6) return [];
    return Array.from({ length: 28 }, (_, i) => covers[(i * 5 + Math.floor(i / 7) * 3) % covers.length]);
  }, [albums]);
  const fresh = useMemo(() => [...albums].filter((a) => a.thumb && a.addedAt > 0).sort((a, b) => b.addedAt - a.addedAt).slice(0, 6), [albums]);
  const seconds = useMemo(() => tracks.reduce((sum, t) => sum + (t.duration || 0), 0), [tracks]);
  const coverOf = useMemo(() => {
    const byName = new Map(albums.map((a) => [a.title.toLowerCase(), a.thumb]));
    return (a: MonthAlbum): string => a.thumb || byName.get(a.name.toLowerCase()) || "";
  }, [albums]);

  const back = current ?? history[0] ?? null;
  const maxMonth = Math.max(1, ...month.map((a) => a.ms));
  // One cover per album: a server gives every song of an album its own picture address.
  const likedCovers: string[] = [];
  const likedAlbums = new Set<string>();
  for (const t of liked) {
    const album = (t.album || t.title).toLowerCase();
    if (!t.thumb || likedAlbums.has(album)) continue;
    likedAlbums.add(album);
    likedCovers.push(t.thumb);
    if (likedCovers.length === 3) break;
  }

  const jumpBack = (): void => {
    if (!back) return;
    if (current) usePlayer.getState().toggle();
    else usePlayer.getState().playTrack(back);
  };

  return (
    <div>
      <div className="page-bleed -mt-5 relative overflow-hidden bg-[#08080a] min-h-[430px] flex items-end">
        {wall.length > 0 && (
          <div
            aria-hidden
            className="absolute left-1/2 -top-[250px] w-[1700px] -ml-[850px] grid grid-cols-7 gap-3"
            style={{ transform: "perspective(1300px) rotateX(40deg) rotateZ(12deg)", transformOrigin: "50% 40%" }}
          >
            {wall.map((src, i) => (
              <img key={i} src={src} alt="" loading="lazy" className="w-full aspect-square object-cover rounded-[10px] block" />
            ))}
          </div>
        )}
        <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgb(var(--page-bg) / 0.94) 0%, rgb(var(--page-bg) / 0.6) 50%, rgb(var(--page-bg) / 0.25) 100%), linear-gradient(180deg, transparent 55%, rgb(var(--page-bg)) 100%)" }} />
        <div className="relative page-pad w-full pb-8 pt-24 flex items-end gap-7 flex-wrap">
          <div className="flex-1 basis-[340px] min-w-0">
            <h1 className="font-display font-black tracking-[-0.06em] leading-[0.9] text-white text-[clamp(52px,8vw,104px)]">
              {T("Your")}
              <br />
              <span className="italic text-accent">{T("Library.")}</span>
            </h1>
            <div className="flex gap-x-8 gap-y-3 mt-5 flex-wrap">
              <Count value={albums.length.toLocaleString()} label={T("ALBUMS")} />
              <Count value={tracks.length.toLocaleString()} label={T("SONGS")} />
              <Count value={playlists.length.toLocaleString()} label={T("PLAYLISTS")} />
              {seconds > 0 && <Count value={fmtLong(seconds)} label={T("OF MUSIC")} />}
            </div>
          </div>
          {back && (
            <div className="flex items-center gap-4 p-3 pr-5 rounded-2xl bg-[#0f0f12]/75 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] backdrop-blur-sm max-w-full">
              <Artwork src={back.thumb} className="w-[84px] h-[84px] shrink-0" rounded="rounded-[10px]" alt="" />
              <div className="min-w-0">
                <div className="text-[10.5px] font-extrabold tracking-[0.2em] text-zinc-400">{current ? T("NOW PLAYING") : T("JUMP BACK IN")}</div>
                <div className="text-[20px] font-extrabold tracking-[-0.02em] text-white truncate max-w-[240px]">{back.title}</div>
                <div className="text-[12.5px] text-zinc-400 truncate max-w-[240px]">{back.artist}</div>
              </div>
              <button
                onClick={jumpBack}
                title={current && playing ? T("Pause") : T("Play")}
                aria-label={current && playing ? T("Pause") : T("Play {title}", { title: back.title })}
                className="ml-2 w-12 h-12 shrink-0 rounded-full bg-accent text-[#0b0b0d] grid place-items-center hover:brightness-110 active:scale-95 transition-all"
              >
                {current && playing ? <span className="flex gap-1"><span className="w-1.5 h-4 bg-current rounded-sm" /><span className="w-1.5 h-4 bg-current rounded-sm" /></span> : <Play className="w-[18px] h-[18px] fill-current" />}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-[18px] flex-wrap mt-5">
        {/* Liked Songs: the accent, with its newest covers thrown on. */}
        <button
          onClick={() => navigate({ name: "library", param: "liked" })}
          className="relative flex-[5_1_340px] min-w-0 h-[280px] rounded-[20px] overflow-hidden text-left group"
          style={{ background: "linear-gradient(135deg, rgb(var(--accent)) 0%, rgb(var(--accent) / 0.55) 55%, rgb(var(--accent) / 0.2) 100%), #17121f" }}
        >
          {likedCovers[0] && <img src={likedCovers[0]} alt="" className="absolute right-[118px] top-[18px] w-[112px] h-[112px] rounded-[10px] object-cover shadow-[0_24px_50px_rgba(0,0,0,0.5)]" style={{ transform: "rotate(-12deg)" }} />}
          {likedCovers[1] && <img src={likedCovers[1]} alt="" className="absolute right-6 top-[44px] w-[128px] h-[128px] rounded-[10px] object-cover shadow-[0_24px_50px_rgba(0,0,0,0.5)]" style={{ transform: "rotate(9deg)" }} />}
          {likedCovers[2] && <img src={likedCovers[2]} alt="" className="absolute right-[150px] top-[112px] w-[96px] h-[96px] rounded-[10px] object-cover shadow-[0_24px_50px_rgba(0,0,0,0.5)]" style={{ transform: "rotate(5deg)" }} />}
          <span className="absolute left-[26px] bottom-6 z-10">
            <span className="block text-[12px] font-black tracking-[0.22em] text-[#0b0b0d]/70 uppercase">
              {liked.length ? T("{count} · newest: {title}", { count: plural(liked.length, T("song"), T("songs")), title: liked[0].title }) : T("Nothing liked yet")}
            </span>
            <span className="block text-[62px] font-black tracking-[-0.05em] leading-[0.95] text-[#0b0b0d] whitespace-pre-line">{T("Liked\nSongs")}</span>
          </span>
          {liked.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              title={T("Play Liked Songs")}
              onClick={(e) => {
                e.stopPropagation();
                usePlayer.getState().playAll(liked);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  usePlayer.getState().playAll(liked);
                }
              }}
              className="absolute right-[22px] bottom-[22px] w-[60px] h-[60px] rounded-full bg-[#0b0b0d] text-white grid place-items-center transition-transform group-hover:scale-105 active:scale-95"
            >
              <Play className="w-[22px] h-[22px] fill-current" />
            </span>
          )}
        </button>

        {/* This month: what played most, as bars. */}
        {month.length > 0 && (
          <button onClick={() => navigate({ name: "replay" })} className="flex-[4_1_300px] min-w-0 h-[280px] rounded-[20px] bg-[#141418] px-[22px] py-5 flex flex-col gap-2.5 text-left hover:bg-[#17171c] transition-colors">
            <span className="flex items-baseline">
              <span className="text-[22px] font-black tracking-[-0.02em] text-white flex-1">{T("This month")}</span>
              <span className="text-[11px] font-extrabold tracking-[0.16em] text-zinc-400 uppercase">{fmtShort(month.reduce((sum, a) => sum + a.ms, 0))}</span>
            </span>
            {month.map((a) => (
              <span key={a.name} className="flex items-center gap-3">
                <Artwork src={coverOf(a)} className="w-11 h-11 shrink-0" rounded="rounded-md" alt="" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13.5px] font-bold text-white truncate">{a.name}</span>
                  <span className="block h-1.5 rounded-full bg-white/[0.08] mt-1.5">
                    <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(6, (a.ms / maxMonth) * 100)}%` }} />
                  </span>
                </span>
                <span className="text-[12px] font-extrabold text-zinc-400 w-[52px] text-right">{fmtShort(a.ms)}</span>
              </span>
            ))}
          </button>
        )}

        {/* Downloads and Local music. */}
        <div className="flex-[3_1_220px] min-w-0 flex flex-col gap-[18px]">
          <button onClick={() => navigate({ name: "library", param: "downloaded" })} className="flex-1 min-h-[131px] rounded-[20px] px-5 py-[18px] flex flex-col justify-between text-left hover:brightness-110 transition-all" style={{ background: "linear-gradient(140deg, #0f766e, #134e4a)" }}>
            <Download className="w-[26px] h-[26px] text-white" />
            <span>
              <span className="block text-[24px] font-black tracking-[-0.03em] text-white">{T("Downloads")}</span>
              <span className="block text-[12px] font-semibold text-white/75">{downloaded ? T("{count} ready offline", { count: plural(downloaded, T("song"), T("songs")) }) : T("Nothing downloaded yet")}</span>
            </span>
          </button>
          <button onClick={() => navigate({ name: "local" })} className="flex-1 min-h-[131px] rounded-[20px] px-5 py-[18px] flex flex-col justify-between text-left hover:brightness-110 transition-all" style={{ background: "linear-gradient(140deg, #b45309, #7c2d12)" }}>
            <FolderOpen className="w-[26px] h-[26px] text-white" />
            <span>
              <span className="block text-[24px] font-black tracking-[-0.03em] text-white">{T("Local Music")}</span>
              <span className="block text-[12px] font-semibold text-white/75">{T("On this device")}</span>
            </span>
          </button>
        </div>
      </div>

      {/* New on the wall: the albums that joined last, fanned. */}
      {fresh.length >= 3 && (
        <div className="mt-9">
          <h2 className="text-[30px] font-black tracking-[-0.03em] text-ink-hi mb-6">{T("New on the wall")}</h2>
          <div className="flex pl-[26px] pb-3">
            {fresh.map((a, i) => (
              <button
                key={a.key}
                onClick={() => navigate({ name: "album", param: a.route })}
                title={`${a.title} · ${a.artist}`}
                className="shrink-0 -ml-[26px] rounded-[10px] overflow-hidden shadow-[0_24px_50px_-10px_rgba(0,0,0,0.9)] transition-transform duration-200 hover:z-10 hover:!rotate-0 hover:!-translate-y-3"
                style={{ transform: `rotate(${[-8, 5, -4, 7, -6, 4][i]}deg) translateY(${[6, -8, 10, -4, 8, -6][i]}px)` }}
              >
                <img src={a.thumb} alt="" className="w-[150px] h-[150px] object-cover block" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
