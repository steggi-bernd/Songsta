/**
 * The Your Library page from before 2026-11-21, for Settings → Home with your library off: a wall of the
 * library's covers behind its name and numbers and "Jump back in" (LibraryHead), and the albums that
 * joined last beside the library by genre (LibraryShelves). The tiles under the head are LibraryTiles
 * (LibraryFront.tsx) in their classic size.
 */
import { useMemo } from "react";
import { Pause, Play } from "lucide-react";
import { useLibraryGenres, useLibraryIndex } from "../lib/catalogIndex";
import { plural } from "../lib/format";
import { T } from "../lib/i18n";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { CoverWall, FitLine, fmtLong } from "./LibraryFront";
import { Artwork } from "./primitives";

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

export function LibraryHead() {
  const { albums, tracks } = useLibraryIndex();
  const playlists = useLibrary((s) => s.playlists);
  const history = useLibrary((s) => s.history);
  const navigate = useUI((s) => s.navigate);
  const current = usePlayer((s) => s.queue[s.index] ?? null);
  const playing = usePlayer((s) => s.playing);

  const wall = useMemo(() => [...new Set(albums.map((a) => a.thumb).filter(Boolean))], [albums]);
  const seconds = useMemo(() => tracks.reduce((sum, t) => sum + (t.duration || 0), 0), [tracks]);

  const back = current ?? history[0] ?? null;

  const jumpBack = (): void => {
    if (!back) return;
    if (current) usePlayer.getState().toggle();
    else usePlayer.getState().playTrack(back);
  };


  return (
    <div>
      <div className="page-bleed -mt-5 relative overflow-hidden bg-[#08080a] min-h-[460px] flex items-end" style={{ containerType: "inline-size" }}>
        {/* Gone before the head's foot, as on Home: no cover can show through where the head meets the page. */}
        <div aria-hidden className="absolute inset-0" style={{ maskImage: "linear-gradient(180deg, #000 78%, transparent 97%)", WebkitMaskImage: "linear-gradient(180deg, #000 78%, transparent 97%)" }}>
          <CoverWall covers={wall} tilt={12} />
        </div>
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
