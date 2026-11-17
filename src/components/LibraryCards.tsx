/**
 * Shelf tiles for the library: albums, artists and mixes, in the same shape
 * as the catalogue cards (Cards.tsx) — square cover over title/subtitle, the
 * translucent tile fading in on hover, a play button over the cover.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { resolveArtistAbout } from "../lib/artistAbout";
import { resolveArtistImages } from "../lib/songInfo";
import type { LibAlbum, LibGenre } from "../lib/catalogIndex";
import { trackAvailable } from "../stores/availability";
import { sameSong, songKey } from "../stores/catalog";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI } from "../stores/ui";
import type { Track } from "../types";
import { Artwork, PlayOverlay } from "./primitives";
import { T } from "../lib/i18n";

const NO_TRACKS: Track[] = [];

/**
 * Whether the playing song belongs to these tracks: the collection's play
 * button then pauses and resumes it in place instead of starting over.
 * `exact`: only while the queue is these tracks — a few songs picked out of
 * an album (the artist page's liked songs) still start as their own list
 * while the album plays one of them.
 */
export function useCollectionPlayback(tracks: Track[], exact = false): { active: boolean; playing: boolean } {
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const queue = usePlayer((s) => (exact ? s.queue : null));
  const playing = usePlayer((s) => s.playing);
  const active = useMemo(() => {
    if (!currentId || !tracks.some((t) => sameSong(t.id, currentId))) return false;
    if (!queue) return true;
    const keys = new Set(tracks.map((t) => songKey(t.id)));
    return queue.every((q) => keys.has(songKey(q.id)));
  }, [tracks, currentId, queue]);
  return { active, playing: active && playing };
}

/** Play a collection; songs that can't be reached right now stay out of the queue. */
export function playCollection(tracks: Track[], shuffle = false): void {
  const list = tracks.filter((t) => trackAvailable(t));
  if (!list.length) {
    useUI.getState().toast(T("None of these songs can be reached right now — their drive or server is away"), "warning");
    return;
  }
  if (shuffle) usePlayer.setState({ shuffle: true });
  usePlayer.getState().playAll(list, shuffle);
}

/** The cover/header play button: plays the collection, or pauses/resumes it once it's playing. */
function playOrToggle(active: boolean, play: () => void): () => void {
  return () => (active ? usePlayer.getState().toggle() : play());
}

const CARD_LOOK = "group text-left cursor-pointer active:scale-[0.98] rounded-xl p-2 transition-colors duration-200 hover:bg-ink-hi/[0.08]";
/** a shelf's card keeps its width; a fluid one fills its grid cell (Explore's centred raster) */
const CARD = `${CARD_LOOK} w-[184px] shrink-0`;
const CARD_FLUID = `${CARD_LOOK} w-full min-w-0`;
const CARD_TITLE = "text-[15px] font-semibold text-ink-hi truncate leading-snug";
const CARD_SUB = "text-[13px] text-ink-dim truncate mt-0.5";

function activateOnKey(open: () => void) {
  return (e: KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
}

function Tile({
  thumb,
  round,
  title,
  subtitle,
  onOpen,
  onPlay,
  playing,
  art,
  rootRef,
  fluid,
}: {
  thumb: string;
  round?: boolean;
  title: string;
  subtitle: string;
  onOpen: () => void;
  onPlay?: () => void;
  /** the collection is playing: the button shows pause and stays visible */
  playing?: boolean;
  /** custom artwork (mix collage) instead of a single cover */
  art?: ReactNode;
  rootRef?: RefObject<HTMLDivElement>;
  /** fills its grid cell instead of keeping a shelf card's width */
  fluid?: boolean;
}) {
  const shape = round ? "rounded-full" : "rounded-xl";
  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={activateOnKey(onOpen)}
      {...tintHoverHandlers(thumb)}
      className={`${fluid ? CARD_FLUID : CARD} select-none`}
    >
      <div className={`relative overflow-hidden ${shape}`}>
        {art ?? (
          <Artwork
            src={thumb}
            rounded={shape}
            className="w-full aspect-square transition-transform duration-300 ease-out origin-top group-hover:scale-[1.05]"
            iconClassName="w-7 h-7"
          />
        )}
        {onPlay && <PlayOverlay onClick={onPlay} playing={playing} />}
      </div>
      <div className="mt-2.5">
        <div className={CARD_TITLE} title={title}>
          {title}
        </div>
        <div className={CARD_SUB}>{subtitle}</div>
      </div>
    </div>
  );
}

export function AlbumTile({ album, subtitle, fluid }: { album: LibAlbum; subtitle?: string; fluid?: boolean }) {
  const navigate = useUI((s) => s.navigate);
  const { active, playing } = useCollectionPlayback(album.tracks);
  return (
    <Tile
      fluid={fluid}
      thumb={album.thumb}
      title={album.title}
      subtitle={subtitle ?? `${album.year ? `${album.year} · ` : ""}${album.artist}`}
      onOpen={() => navigate({ name: "album", param: album.route })}
      onPlay={playOrToggle(active, () => playCollection(album.tracks))}
      playing={playing}
    />
  );
}

/**
 * True once the element has been on screen. Lookups that go out to the open
 * databases (artist photos) wait for it, so a list of a thousand artists
 * asks only for the ones scrolled past.
 */
export function useSeen<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/**
 * The artist's photo: the open databases' (Wikimedia Commons), else
 * Genius's, else a cover as stand-in. An empty name asks nothing.
 */
export function useArtistPhoto(name: string, fallback = ""): string {
  const [photo, setPhoto] = useState<string>(fallback);
  useEffect(() => {
    let alive = true;
    setPhoto(fallback);
    void resolveArtistAbout(name).then(async (a) => {
      if (!alive) return;
      if (a?.thumb) {
        setPhoto(a.thumb);
        return;
      }
      const g = await resolveArtistImages(name);
      if (alive && g?.photo) setPhoto(g.photo);
    });
    return () => {
      alive = false;
    };
  }, [name, fallback]);
  return photo;
}

export function ArtistTile({
  name,
  route,
  subtitle,
  fallbackThumb,
  fluid,
}: {
  name: string;
  route: string;
  subtitle: string;
  fallbackThumb: string;
  fluid?: boolean;
}) {
  const navigate = useUI((s) => s.navigate);
  const [ref, seen] = useSeen<HTMLDivElement>();
  const photo = useArtistPhoto(seen ? name : "", fallbackThumb);
  return <Tile rootRef={ref} round fluid={fluid} thumb={photo} title={name} subtitle={subtitle} onOpen={() => navigate({ name: "artist", param: route })} />;
}

/** A genre of the library: a collage of its covers, opening the genre's page (all its songs). */
export function GenreTile({ genre, fluid }: { genre: LibGenre; fluid?: boolean }) {
  const navigate = useUI((s) => s.navigate);
  const { active, playing } = useCollectionPlayback(genre.tracks);
  return (
    <Tile
      fluid={fluid}
      thumb={genre.tracks.find((t) => t.thumb)?.thumb ?? ""}
      title={genre.name}
      subtitle={`${genre.tracks.length} ${genre.tracks.length === 1 ? T("song") : T("songs")} · ${genre.artistCount} ${genre.artistCount === 1 ? T("artist") : T("artists")}`}
      onOpen={() => navigate({ name: "genre", param: genre.route })}
      onPlay={playOrToggle(active, () => playCollection(genre.tracks, true))}
      playing={playing}
      art={<CoverCollage tracks={genre.tracks} className="rounded-xl transition-transform duration-300 ease-out origin-top group-hover:scale-[1.05]" />}
    />
  );
}

/** 2×2 cover collage — mixes and smart playlists. */
export function CoverCollage({ tracks, className = "" }: { tracks: Track[]; className?: string }) {
  const covers: string[] = [];
  for (const t of tracks) {
    if (t.thumb && !covers.includes(t.thumb)) covers.push(t.thumb);
    if (covers.length === 4) break;
  }
  if (covers.length < 4) {
    return <Artwork src={covers[0]} rounded="rounded-xl" className={`w-full aspect-square ${className}`} iconClassName="w-7 h-7" />;
  }
  return (
    <div className={`grid grid-cols-2 w-full aspect-square overflow-hidden ${className}`}>
      {covers.map((c) => (
        <Artwork key={c} src={c} className="w-full aspect-square" rounded="rounded-none" iconClassName="w-4 h-4" />
      ))}
    </div>
  );
}

export function MixTile({ title, subtitle, tracks, route }: { title: string; subtitle: string; tracks: Track[]; route: string }) {
  const navigate = useUI((s) => s.navigate);
  const { active, playing } = useCollectionPlayback(tracks);
  return (
    <Tile
      thumb={tracks[0]?.thumb ?? ""}
      title={title}
      subtitle={subtitle}
      onOpen={() => navigate({ name: "mix", param: route })}
      onPlay={playOrToggle(active, () => playCollection(tracks))}
      playing={playing}
      art={<CoverCollage tracks={tracks} className="rounded-xl transition-transform duration-300 ease-out origin-top group-hover:scale-[1.05]" />}
    />
  );
}

/**
 * Spotify's round green play button for page headers. Given the page's
 * tracks, it turns into pause while one of them plays and resumes in place.
 */
export function BigPlayButton({
  onClick,
  label = T("Play"),
  tracks,
}: {
  onClick: () => void;
  label?: string;
  tracks?: Track[];
}) {
  const { active, playing } = useCollectionPlayback(tracks ?? NO_TRACKS);
  const title = playing ? T("Pause") : label;
  return (
    <button
      onClick={playOrToggle(active, onClick)}
      title={title}
      aria-label={title}
      className="w-14 h-14 shrink-0 rounded-full bg-primary text-on-primary grid place-items-center shadow-float hover:scale-105 active:scale-95 transition-transform"
    >
      {playing ? (
        <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current" aria-hidden>
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current ml-0.5" aria-hidden>
          <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
        </svg>
      )}
    </button>
  );
}

/** Compact quick-access tile (the home page's top grid, Spotify-style). */
export function QuickTile({ title, thumb, art, onOpen, onPlay }: { title: string; thumb?: string; art?: ReactNode; onOpen: () => void; onPlay: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={activateOnKey(onOpen)}
      {...tintHoverHandlers(thumb ?? null)}
      className="group flex items-center gap-3 h-16 rounded-md bg-ink-hi/[0.07] hover:bg-ink-hi/[0.14] transition-colors overflow-hidden pr-3 cursor-pointer select-none"
    >
      <div className="w-16 h-16 shrink-0 overflow-hidden">{art ?? <Artwork src={thumb} rounded="rounded-none" className="w-16 h-16" iconClassName="w-5 h-5" />}</div>
      <span className="flex-1 min-w-0 text-[14px] font-bold text-ink-hi truncate">{title}</span>
      <button
        title={T("Play {title}", { title })}
        aria-label={T("Play {title}", { title })}
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
        className="w-9 h-9 shrink-0 rounded-full bg-primary text-on-primary grid place-items-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 shadow-float transition-opacity hover:scale-105"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current ml-0.5" aria-hidden>
          <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
        </svg>
      </button>
    </div>
  );
}

/** Header for mixes and smart playlists: collage, label, title, length, play/shuffle. */
export function CollectionHeader({
  label,
  title,
  subtitle,
  tracks,
  actions,
}: {
  label: string;
  title: string;
  subtitle?: string;
  tracks: Track[];
  actions?: ReactNode;
}) {
  const length = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const h = Math.floor(length / 3600);
  const m = Math.floor((length % 3600) / 60);
  return (
    <>
      <header className="flex items-end gap-6 pt-4 animate-slide-up">
        <div className="w-[232px] shrink-0 shadow-elev rounded-lg overflow-hidden">
          <CoverCollage tracks={tracks} />
        </div>
        <div className="min-w-0 pb-1">
          <div className="text-[13px] font-semibold text-ink-hi/80">{label}</div>
          <h1 className="font-display font-extrabold tracking-[-0.04em] text-ink-hi leading-[1.15] pb-[0.08em] line-clamp-2" style={{ fontSize: title.length > 24 ? 44 : 64 }}>
            {title}
          </h1>
          <div className="text-[14px] text-ink-hi/75 mt-2">
            {subtitle ? `${subtitle} · ` : ""}
            {tracks.length} {tracks.length === 1 ? T("song") : T("songs")}
            {length > 0 && `, ${h > 0 ? T("{h} hr {m} min", { h, m }) : `${m} min`}`}
          </div>
        </div>
      </header>
      <div className="flex items-center gap-5">
        <BigPlayButton onClick={() => tracks.length && playCollection(tracks)} label={T("Play {title}", { title })} tracks={tracks} />
        <button
          onClick={() => tracks.length && playCollection(tracks, true)}
          title={T("Shuffle play")}
          aria-label={T("Shuffle play")}
          className="w-10 h-10 grid place-items-center rounded-full text-ink-hi/70 hover:text-ink-hi hover:scale-105 transition-all"
        >
          <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
            <path d="m18 2 4 4-4 4" />
            <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
            <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
            <path d="m18 14 4 4-4 4" />
          </svg>
        </button>
        {actions}
      </div>
    </>
  );
}
