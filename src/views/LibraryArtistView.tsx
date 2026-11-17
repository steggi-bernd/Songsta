/**
 * Artist page for the library, Spotify-style: a full-width photo banner with
 * the name over it (their genre above it), play / shuffle / sounds like, and
 * your own numbers with them — time listened, plays, your song — then two tabs.
 *
 *  - Overview: a strip leading to the songs of theirs you've liked (a small
 *    playlist of their own, ArtistLikedView); side by side where there's room,
 *    the songs of theirs you play most (from your own listening history) and
 *    their discography as a raster (newest first); the releases they appear
 *    on, and an About card with the Wikipedia bio
 *  - Discography: every release of theirs in the library, newest on top,
 *    each with its cover, type, year and full track list — filterable by type
 *
 * Release types come from the tags where present, else from the title and
 * size (lib/releases.ts). Photo, bio and facts come from the open databases
 * (artistAbout.ts); the banner is the sharpest of the artist's pictures
 * (lib/artistBanner.ts); everything else is your own library.
 */
import { useEffect, useMemo, useState } from "react";
import { AudioWaveform, ChevronRight, ExternalLink, Pause, Play, Shuffle, User } from "lucide-react";
import { BannerPicture } from "../components/BannerPicture";
import { AlbumTile, BigPlayButton, playCollection } from "../components/LibraryCards";
import { TrackList } from "../components/TrackList";
import { Artwork, EqBars, EmptyState, ShelfScroller } from "../components/primitives";
import { LikedCover } from "../components/LikedCover";
import { resolveArtistAbout, useArtistPicture, type ArtistAbout } from "../lib/artistAbout";
import { bannerCandidates } from "../lib/artistBanner";
import { genresOfTrack } from "../lib/albumGenres";
import { artistAlbums, artistTracks, byPlays, useLibraryIndex, useLikedAmong, type LibAlbum } from "../lib/catalogIndex";
import { fmtLength, fmtMinutes, fmtTime } from "../lib/format";
import { parseRoute } from "../lib/libraryTracks";
import { RELEASE_LABEL } from "../lib/releases";
import { useArtistImages } from "../lib/songInfo";
import { trackMenuItems } from "../lib/trackActions";
import { sameSong, useCatalog, useFreshPlayCounts } from "../stores/catalog";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI } from "../stores/ui";
import type { Track } from "../types";
import { T } from "../lib/i18n";

/**
 * "Popular with you": the artist's songs you play most, as compact rows — rank, cover, title over
 * album, how often, how long. A click plays from that song on; right-click opens the song's menu.
 */
function PopularRows({ songs, plays }: { songs: Track[]; plays: (t: Track) => number }) {
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const playing = usePlayer((s) => s.playing);
  const openContextMenu = useUI((s) => s.openContextMenu);
  return (
    <div className="space-y-0.5">
      {songs.map((t, i) => {
        const isCurrent = sameSong(t.id, currentId);
        const count = plays(t);
        return (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            {...tintHoverHandlers(t.thumb)}
            onClick={() => (isCurrent ? usePlayer.getState().toggle() : usePlayer.getState().playQueue(songs, i))}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              if (isCurrent) usePlayer.getState().toggle();
              else usePlayer.getState().playQueue(songs, i);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openContextMenu(e.clientX, e.clientY, trackMenuItems(t));
            }}
            className={`group grid grid-cols-[28px_44px_minmax(0,1fr)_auto_44px] items-center gap-3 h-[58px] px-2 rounded-lg cursor-pointer select-none ${
              isCurrent ? "bg-ink-hi/[0.12]" : "hover:bg-ink-hi/[0.05]"
            }`}
          >
            <span className="row-number grid place-items-center text-[13px] text-ink-faint tabular-nums">
              <span className="group-hover:hidden">{isCurrent && playing ? <EqBars /> : <span className={isCurrent ? "text-accent" : ""}>{i + 1}</span>}</span>
              <span className="hidden group-hover:block text-ink-hi">{isCurrent && playing ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}</span>
            </span>
            <Artwork src={t.thumb} className="w-11 h-11 rounded-md" iconClassName="w-4 h-4" alt="" />
            <span className="min-w-0">
              <span className={`block truncate text-[15px] font-semibold ${isCurrent ? "text-accent" : "text-ink-hi"}`}>{t.title}</span>
              <span className="block truncate text-[12.5px] text-ink-dim">{t.album ?? ""}</span>
            </span>
            <span className="text-[12.5px] text-ink-dim tabular-nums">{count > 0 ? `${count}×` : ""}</span>
            <span className="text-right text-[12.5px] text-ink-faint tabular-nums">{t.duration > 0 ? fmtTime(t.duration) : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

type Tab = "overview" | "discography";
type DiscFilter = "all" | "albums" | "eps" | "compilations";
const DISC_FILTER_LABEL: Record<DiscFilter, string> = {
  all: T("All"),
  albums: T("Albums"),
  eps: T("Singles & EPs"),
  compilations: T("Compilations"),
};

function inFilter(a: LibAlbum, f: DiscFilter): boolean {
  if (f === "all") return true;
  if (f === "albums") return a.kind === "album";
  if (f === "eps") return a.kind === "ep" || a.kind === "single";
  return a.kind === "compilation";
}

/** "2014 · EP" for the release shelves. */
const releaseLine = (a: LibAlbum): string => `${a.year ? `${a.year} · ` : ""}${RELEASE_LABEL[a.kind]}`;

/** One release in the discography: cover, title, type · year · length, play, and its songs. */
function DiscographyRelease({ album }: { album: LibAlbum }) {
  const navigate = useUI((s) => s.navigate);
  const open = (): void => navigate({ name: "album", param: album.route });
  return (
    <section className="space-y-3">
      <div className="flex items-end gap-5">
        <button onClick={open} className="shrink-0" title={T("Open {title}", { title: album.title })} aria-label={T("Open {title}", { title: album.title })}>
          <Artwork src={album.thumb} rounded="rounded-md" className="w-[136px] h-[136px] shadow-elev" iconClassName="w-8 h-8" />
        </button>
        <div className="min-w-0 pb-1">
          <button
            onClick={open}
            className="block max-w-full truncate text-left text-[26px] font-extrabold tracking-[-0.02em] text-ink-hi hover:underline"
          >
            {album.title}
          </button>
          <div className="text-[14px] text-ink-dim mt-1">
            {RELEASE_LABEL[album.kind]}
            {album.year ? ` · ${album.year}` : ""} · {album.tracks.length} {album.tracks.length === 1 ? T("song") : T("songs")},{" "}
            {fmtLength(album.duration)}
          </div>
          <div className="mt-3">
            <BigPlayButton onClick={() => playCollection(album.tracks)} label={T("Play {title}", { title: album.title })} tracks={album.tracks} />
          </div>
        </div>
      </div>
      <TrackList tracks={album.tracks} showAlbum={false} showHeader={false} sourceName={album.title} emptyLabel={T("No songs.")} />
    </section>
  );
}

export function LibraryArtistView({ param }: { param: string }) {
  const name = parseRoute(param, "artist") ?? "";
  const { tracks, albums, loaded } = useLibraryIndex();
  const playCounts = useCatalog((s) => s.playCounts);
  const navigate = useUI((s) => s.navigate);
  const [about, setAbout] = useState<ArtistAbout | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [discFilter, setDiscFilter] = useState<DiscFilter>("all");
  useFreshPlayCounts();

  useEffect(() => {
    let alive = true;
    setAbout(null);
    setShowAll(false);
    setTab("overview");
    setDiscFilter("all");
    void resolveArtistAbout(name).then((a) => {
      if (alive) setAbout(a);
    });
    return () => {
      alive = false;
    };
  }, [name]);

  const images = useArtistImages(name);
  const picture = useArtistPicture(name);
  const songs = useMemo(() => artistTracks(tracks, name), [tracks, name]);
  const popular = useMemo(() => byPlays(songs, playCounts), [songs, playCounts]);
  const likedHere = useLikedAmong(songs);
  const { own, appearsOn } = useMemo(() => artistAlbums(albums, name), [albums, name]);
  const byType = useMemo(
    () => ({
      albums: own.filter((a) => inFilter(a, "albums")),
      eps: own.filter((a) => inFilter(a, "eps")),
      compilations: own.filter((a) => inFilter(a, "compilations")),
    }),
    [own]
  );
  // Your numbers with them: time listened (plays × length), plays, the song you play most; their commonest genre.
  const yours = useMemo(() => {
    let heard = 0;
    let plays = 0;
    const genreCount = new Map<string, number>();
    for (const t of songs) {
      const n = playCounts[t.id]?.plays ?? 0;
      plays += n;
      heard += n * (t.duration || 0);
      const g = genresOfTrack(t)[0];
      if (g) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
    }
    const genre = [...genreCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const top = popular[0] && (playCounts[popular[0].id]?.plays ?? 0) > 0 ? popular[0] : null;
    return { heard, plays, genre, top };
  }, [songs, popular, playCounts]);

  if (!loaded) return null;
  if (!songs.length) {
    return <EmptyState icon={User} title={T("No songs by {name}", { name })} body={T("Nothing in your library credits this artist.")} />;
  }

  // The banner: the artist's sharpest picture, else a cover (lib/artistBanner.ts).
  const banner = bannerCandidates({ picture, genius: images, photo: about?.thumb ?? null, covers: [own[0]?.thumb, songs[0]?.thumb] });
  const counts = [
    byType.albums.length ? `${byType.albums.length} ${byType.albums.length === 1 ? T("album") : T("albums")}` : null,
    byType.eps.length ? `${byType.eps.length} ${byType.eps.length === 1 ? "single or EP" : "singles & EPs"}` : null,
  ].filter(Boolean);
  const filters = (Object.keys(DISC_FILTER_LABEL) as DiscFilter[]).filter(
    (f) => f === "all" || own.some((a) => inFilter(a, f))
  );

  return (
    <div className="space-y-7">
      {/* Banner: the photo bleeds to the panel edges, the name sits on it. */}
      <header className="relative page-bleed -mt-5 h-[340px] overflow-hidden animate-fade-in">
        <BannerPicture key={name} candidates={banner} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-black/10" />
        <div className="absolute inset-x-0 page-pad bottom-7">
          <span className="inline-flex items-center h-[26px] px-2.5 mb-3 rounded-md bg-black/45 backdrop-blur-sm text-[11.5px] font-bold tracking-[0.04em] text-white/90">
            {yours.genre ? T("{genre} · in your library", { genre: yours.genre }) : T("In your library")}
          </span>
          <h1 className="font-display font-extrabold tracking-[-0.04em] text-white leading-none drop-shadow-lg" style={{ fontSize: name.length > 18 ? 56 : 88 }}>
            {name}
          </h1>
          <div className="text-[15px] text-white/85 mt-4">
            {T("{count} {value}{value2} in your library", { count: songs.length, value: songs.length === 1 ? T("song") : T("songs"), value2: counts.length > 0 ? ` · ${counts.join(" · ")}` : "" })}{about?.facts && <span className="text-white/65"> · {about.facts}</span>}
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <BigPlayButton onClick={() => playCollection(popular)} label={T("Play {name}", { name })} tracks={songs} />
          <button
            onClick={() => playCollection(songs, true)}
            title={T("Shuffle play")}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-full bg-ink-hi/[0.07] hover:bg-ink-hi/[0.12] text-[13.5px] font-semibold text-ink-hi transition-colors"
          >
            <Shuffle className="w-4 h-4" />
            {T("Shuffle")}
          </button>
          {(yours.top ?? songs[0]) && (
            <button
              onClick={() => navigate({ name: "soundslike", param: (yours.top ?? songs[0]).id })}
              title={T("Songs that sound like theirs, by tempo and key")}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-full bg-ink-hi/[0.07] hover:bg-ink-hi/[0.12] text-[13.5px] font-semibold text-ink-hi transition-colors max-w-full"
            >
              <AudioWaveform className="w-4 h-4 shrink-0" />
              <span className="truncate">{T("Sounds like {name}", { name })}</span>
            </button>
          )}
        </div>
        {yours.plays > 0 && (
          <div className="flex flex-wrap gap-x-7 gap-y-2">
            <div className="min-w-0">
              <div className="text-[22px] font-black tracking-[-0.02em] text-ink-hi leading-tight tabular-nums">{fmtMinutes(yours.heard)}</div>
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-ink-dim">{T("Heard by you")}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[22px] font-black tracking-[-0.02em] text-ink-hi leading-tight tabular-nums">{yours.plays}</div>
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-ink-dim">{T("Plays")}</div>
            </div>
            {yours.top && (
              <div className="min-w-0 max-w-[220px]">
                <div className="text-[22px] font-black tracking-[-0.02em] text-accent leading-tight pb-[0.1em] truncate">{yours.top.title}</div>
                <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-ink-dim">{T("Your song")}</div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-6 border-b border-ink-hi/[0.08]" role="tablist" aria-label={T("Artist sections")}>
        {(["overview", "discography"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`relative pb-3 text-[15px] font-bold transition-colors ${tab === t ? "text-ink-hi" : "text-ink-hi/55 hover:text-ink-hi/85"}`}
          >
            {t === "overview" ? T("Overview") : T("Discography{value}", { value: own.length ? ` · ${own.length}` : "" })}
            <span className={`absolute left-0 right-0 -bottom-px h-[3px] rounded-full ${tab === t ? "bg-ink-hi" : "bg-transparent"}`} />
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          {likedHere.length > 0 && (
            <button
              onClick={() => navigate({ name: "artistliked", param })}
              className="group w-full flex items-center gap-3.5 h-[68px] pl-2 pr-4 rounded-lg bg-ink-hi/[0.05] hover:bg-ink-hi/[0.1] transition-colors text-left"
            >
              <LikedCover className="w-[52px] h-[52px] rounded-md shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-ink-hi truncate">{T("Liked songs")}</span>
                <span className="block text-[13px] text-ink-dim truncate mt-0.5">
                  {T("{count} {value} by {name}", { count: likedHere.length, value: likedHere.length === 1 ? T("song") : T("songs"), name })}
                </span>
              </span>
              <ChevronRight className="w-5 h-5 shrink-0 text-ink-dim group-hover:text-ink-hi transition-colors" />
            </button>
          )}
          {/* Side by side where the page has room for both, one under the other where it hasn't. */}
          <div className="grid gap-x-8 gap-y-8 items-start" style={{ gridTemplateColumns: own.length ? "repeat(auto-fit, minmax(min(100%, 380px), 1fr))" : "1fr" }}>
            <section className="min-w-0">
              <h2 className="section-title text-[21px] mb-3">{T("Popular with you")}</h2>
              <PopularRows songs={popular.slice(0, showAll ? 10 : 5)} plays={(t) => playCounts[t.id]?.plays ?? 0} />
              {popular.length > 5 && (
                <button onClick={() => setShowAll((v) => !v)} className="mt-2 ml-2 text-[13px] font-bold text-ink-dim hover:text-ink-hi transition-colors">
                  {showAll ? T("Show less") : T("See more")}
                </button>
              )}
            </section>
            {own.length > 0 && (
              <section className="min-w-0">
                <div className="flex items-baseline justify-between gap-3 mb-3">
                  <h2 className="section-title text-[21px]">{T("Discography")}</h2>
                  {own.length > 4 && (
                    <button onClick={() => setTab("discography")} className="text-[13px] font-bold text-ink-dim hover:text-ink-hi hover:underline transition-colors shrink-0">
                      {T("Show all")}
                    </button>
                  )}
                </div>
                <div className="grid gap-x-1 gap-y-1 -mx-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
                  {own.slice(0, 4).map((a) => (
                    <AlbumTile key={a.key} fluid album={a} subtitle={releaseLine(a)} />
                  ))}
                </div>
              </section>
            )}
          </div>

          {appearsOn.length > 0 && (
            <section>
              <h2 className="section-title text-[21px] mb-4">{T("Appears on")}</h2>
              <ShelfScroller>
                {appearsOn.map((a) => (
                  <AlbumTile key={a.key} album={a} subtitle={`${a.year ? `${a.year} · ` : ""}${a.artist}`} />
                ))}
              </ShelfScroller>
            </section>
          )}

          {about?.description && (
            <section className="max-w-[860px]">
              <h2 className="section-title text-[21px] mb-4">{T("About")}</h2>
              <div className="rounded-2xl bg-ink-hi/[0.04] overflow-hidden flex flex-col md:flex-row">
                {about.thumb && <img src={about.thumb} alt="" className="md:w-[280px] h-[220px] md:h-auto object-cover object-top" />}
                <div className="p-6 min-w-0">
                  {about.genres.length > 0 && <div className="text-[13px] text-ink-dim mb-3">{about.genres.join(" · ")}</div>}
                  <p className="text-[15px] leading-relaxed text-ink-hi/85 whitespace-pre-line">{about.description}</p>
                  {about.wikiUrl && (
                    <button
                      onClick={() => window.open(about.wikiUrl as string, "_blank", "noopener,noreferrer")}
                      className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-bold text-ink-hi hover:underline"
                    >{T("Read more on Wikipedia")}{" "}<ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
        </>
      ) : own.length === 0 ? (
        <EmptyState
          icon={User}
          title={T("No releases of their own yet")}
          body={T("{name} appears on other artists' albums in your library — see Overview.", { name })}
        />
      ) : (
        <>
          {filters.length > 2 && (
            <div className="flex flex-wrap gap-2">
              {filters.map((f) => (
                <button
                  key={f}
                  onClick={() => setDiscFilter(f)}
                  aria-pressed={discFilter === f}
                  className={`h-8 px-3 rounded-full text-[13px] font-medium transition-colors ${
                    discFilter === f ? "bg-ink-hi text-black" : "bg-ink-hi/[0.07] text-ink-hi hover:bg-ink-hi/[0.12]"
                  }`}
                >
                  {DISC_FILTER_LABEL[f]}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-10">
            {own
              .filter((a) => inFilter(a, filters.length > 2 ? discFilter : "all"))
              .map((a) => (
                <DiscographyRelease key={a.key} album={a} />
              ))}
          </div>
        </>
      )}
    </div>
  );
}
