import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { AlertCircle, ArrowDownCircle, Check, ChevronDown, ChevronUp, FolderOpen, Heart, List, Loader2, MoreHorizontal, Pause, Play, Plus, Search, X } from "lucide-react";
import { sourceOf, useAvailabilityCheck } from "../stores/availability";
import { sameSong, songKey, useCatalog, versionsOf } from "../stores/catalog";
import { useSettings } from "../stores/settings";
import { addedLabel } from "../lib/exploreRows";
import {
  addedForOrder,
  columnsFor,
  formatCell,
  matchesSearch,
  moved,
  nextListSort,
  readColumns,
  readListSort,
  releasedCell,
  resized,
  sortTracks,
  toggled,
  TRACK_COLUMNS,
  widthOf,
  FIRST_DESC,
  type ListSort,
  type SortKey,
  type TrackColumn,
} from "../lib/trackColumns";
import { likedIdSet, useLibrary } from "../stores/library";
import { useIsMuted } from "../stores/muted";
import { BranchMark } from "./primitives";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI, type MenuItem } from "../stores/ui";
import { trackMenuItems } from "../lib/trackActions";
import { downloadForOffline, SERVER_SONG } from "../lib/downloads";
import { useDrag, type TrackSource } from "../lib/dnd";
import { fmtMinutes, fmtTime } from "../lib/format";
import { flowOrder } from "../lib/flowOrder";
import { camelotLabel, camelotOf, keyLabel } from "../lib/soundMatch";
import { soundOf, useSound } from "../stores/sound";
import { skipsOf } from "../stores/skips";
import type { SoundFacts } from "../../electron/sound-analysis";
import { Artwork, EqBars, EmptyState } from "./primitives";
import { ArtistLinks } from "./ArtistLinks";
import type { Track } from "../types";
import { T } from "../lib/i18n";

/** How long you've listened to a song, as short as a column needs it: "38 min", "2 h 5 min". */
const heardCell = (seconds: number): string => (seconds < 60 ? "" : fmtMinutes(seconds));

/** How much of a download is in: a ring the size of the row's other glyphs. */
function ProgressRing({ value }: { value: number }) {
  const r = 6.5;
  const around = 2 * Math.PI * r;
  const share = Math.min(1, Math.max(0, value));
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={around} strokeDashoffset={around * (1 - share)} />
    </svg>
  );
}

/** Download state glyph for a track row — spinner or filling ring / green check / red fail. */
export function DownloadBadge({ id }: { id: string }) {
  const dl = useLibrary((s) => s.downloads[id]);
  if (!dl || dl.status === "removed") return null;
  if (dl.status === "downloading" || dl.status === "queued") {
    // A ring that fills as the song comes in; a spinner while it waits or its size isn't known.
    const percent = dl.status === "downloading" && dl.total > 0 ? Math.round(dl.progress * 100) : null;
    return (
      <span className="p-1.5 rounded-md text-ink-hi" title={percent === null ? T("Downloading…") : T("Downloading {percent}%", { percent })}>
        {percent === null ? <Loader2 className="w-4 h-4 animate-spin" /> : <ProgressRing value={dl.progress} />}
      </span>
    );
  }
  if (dl.status === "done") {
    return (
      <span className="p-1.5 rounded-md text-emerald-400" title={T("Downloaded")}>
        <Check className="w-4 h-4" />
      </span>
    );
  }
  return (
    <span className="p-1.5 rounded-md text-red-400" title={T("Download failed")}>
      <AlertCircle className="w-4 h-4" />
    </span>
  );
}

/**
 * Beside the like button: a song that lives only on a server is saved for
 * offline listening from here (lib/downloads.ts). Once saved — or while it
 * loads — its state stays in view, like a like; the button itself shows on
 * hover. Songs with a file of their own are offline already and show nothing.
 */
/**
 * The row's file spot — the same width on every row, so the hearts line up:
 * a server song's saved mark or download button; for a song with a file on
 * this computer, its folder (opened in the file manager, shown on hover);
 * otherwise empty room.
 */
export function FileButton({ track }: { track: Track }) {
  // Re-read when the catalogue changes: a finished copy joins the song as its local version,
  // and the merged song may then carry the file's id — the download is the server copy's.
  const serverId = useCatalog(() => versionsOf(track).find((v) => SERVER_SONG.test(v.id))?.id ?? null);
  const filePath = useCatalog(() => versionsOf(track).find((v) => sourceOf(v) === "local" && v.localPath)?.localPath ?? null);
  const dl = useLibrary((s) => (serverId ? s.downloads[serverId] : undefined));
  if (serverId && (dl?.status === "queued" || dl?.status === "downloading" || dl?.status === "done")) return <DownloadBadge id={serverId} />;
  if (filePath) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          void window.bytune?.revealPath(filePath);
        }}
        title={T("Show in folder")}
        aria-label={T("Show {title} in its folder", { title: track.title })}
        className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-[color,background-color,opacity] opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <FolderOpen className="w-4 h-4" />
      </button>
    );
  }
  if (!serverId) return <span aria-hidden className="w-7 h-7 shrink-0" />;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        downloadForOffline([track]);
      }}
      title={dl?.status === "failed" ? T("Download failed — try again") : T("Download for offline listening")}
      aria-label={T("Download {title} for offline listening", { title: track.title })}
      className={`p-1.5 rounded-md hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-[color,background-color,opacity] ${
        dl?.status === "failed" ? "text-red-400" : "text-ink-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      }`}
    >
      {dl?.status === "failed" ? <AlertCircle className="w-4 h-4" /> : <ArrowDownCircle className="w-4 h-4" />}
    </button>
  );
}

interface TrackRowProps {
  track: Track;
  index: number;
  isCurrent: boolean;
  isPlaying: boolean;
  /** false while none of the song's copies can be reached (drive or server away) */
  available: boolean;
  onPlay: (index: number) => void;
  menuFor: (track: Track, from?: TrackSource) => MenuItem[];
  /** the columns between the title and the row's buttons, and the time (a stable reference, so the row memo holds) */
  columns: readonly ShownColumn[];
  /** when the song joined this list, or the library (ms; 0 = not known) */
  added: number;
  /** how often it was played, when that column shows */
  plays: number;
  /** what the sound analysis measured, when the tempo or key column shows */
  facts?: SoundFacts;
  /** the list's name and songs (stable references, so the row memo holds): Branch off continues there */
  sourceName?: string;
  sourceTracks?: Track[];
}

/**
 * One song row. Memoized: a list re-renders on every track change or
 * play/pause, but only the rows whose props actually change (the old and the
 * new current row) do work — the rest are skipped.
 */
const TrackRow = memo(function TrackRow({
  track,
  index,
  isCurrent,
  isPlaying,
  available,
  onPlay,
  menuFor,
  columns,
  added,
  plays,
  facts,
  sourceName,
  sourceTracks,
}: TrackRowProps) {
  const liked = useLibrary((s) => likedIdSet(s.liked).has(track.id));
  const toggleLike = useLibrary((s) => s.toggleLike);
  const muted = useIsMuted(track.id);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const navigate = useUI((s) => s.navigate);
  const from: TrackSource | undefined = sourceName && sourceTracks ? { name: sourceName, tracks: sourceTracks, index } : undefined;
  const drag = useDrag({ track, from });

  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, menuFor(track, from));
  };

  /** The row's own spot plays it — and pauses/resumes it once it's the current song. */
  const activate = (): void => {
    if (isCurrent) usePlayer.getState().toggle();
    else if (available) onPlay(index);
    else useUI.getState().toast(T("\"{title}\" can't be reached right now — its drive or server is away", { title: track.title }), "warning");
  };

  return (
    <div
      {...tintHoverHandlers(track.thumb)}
      {...drag.props}
      onClick={activate}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY);
      }}
      title={available ? undefined : T("Not available right now — its drive or server can't be reached")}
      aria-disabled={!available || undefined}
      // Long lists: rows off screen are neither laid out nor painted.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 60px" }}
      className={`group flex items-center gap-3.5 h-[60px] px-3 rounded-lg select-none ${available ? "cursor-pointer" : "cursor-default"} ${
        isCurrent ? "bg-ink-hi/[0.14]" : "hover:bg-ink-hi/[0.05]"
      } ${drag.dragging || !available ? "opacity-40" : muted ? "opacity-60" : ""}`}
    >
      {/* index (EQ bars while playing); on hover, play/pause at the same spot */}
      <div className="row-number w-7 shrink-0 grid place-items-center text-[13px] text-ink-faint tabular-nums">
        <span className={available || isCurrent ? "group-hover:hidden" : ""}>
          {isCurrent && isPlaying ? <EqBars /> : <span className={isCurrent ? "text-accent font-medium" : ""}>{index + 1}</span>}
        </span>
        {(available || isCurrent) && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              activate();
            }}
            className="hidden group-hover:block text-ink-hi hover:text-ink-hi transition-colors"
            title={isCurrent && isPlaying ? T("Pause") : T("Play")}
            aria-label={isCurrent && isPlaying ? T("Pause {title}", { title: track.title }) : T("Play {title}", { title: track.title })}
          >
            {isCurrent && isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
          </button>
        )}
      </div>

      <Artwork
        src={track.thumb}
        className="w-[52px] h-[52px] rounded-lg shrink-0"
        iconClassName="w-4 h-4"
        alt=""
      />

      {/* min-w floor: with showAlbum the fixed columns (index · artwork · album ·
          controls · time) can exceed a narrow list and, because the title's flex
          basis is 0, it would collapse to zero width before anything else gives.
          The floor keeps the title visible; the album column shrinks instead. */}
      <div className="flex-1 min-w-[120px]">
        <div className={`flex items-center gap-1.5 text-[16px] font-semibold tracking-[-0.2px] ${isCurrent ? "text-accent" : muted ? "text-red-300" : "text-ink-hi"}`}>
          <span className="truncate">{track.title}</span>
          <BranchMark id={track.id} />
        </div>
        <div className="text-[14px] truncate text-ink-dim mt-0.5">
          {track.artistId?.startsWith("lib:artist:") ? (
            <ArtistLinks artist={track.artist} className="hover:text-ink transition-colors" />
          ) : (
            track.artist
          )}
        </div>
      </div>

      {columns.map((c) =>
        c.key === "time" ? null : (
          <div key={c.key} style={cellWidth(c.key)} className={`shrink-0 text-xs text-ink-faint truncate ${c.right ? "text-right tabular-nums" : ""}`}>
            {c.key === "album" ? (
              track.albumId ? (
                <button
                  className="max-w-full truncate hover:text-ink hover:underline text-left transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate({ name: "album", param: track.albumId });
                  }}
                >
                  {track.album ?? T("Single")}
                </button>
              ) : (
                (track.album ?? "")
              )
            ) : c.key === "added" ? (
              added > 0 ? addedLabel(added) : ""
            ) : c.key === "released" ? (
              releasedCell(track)
            ) : c.key === "genre" ? (
              (track.genre ?? "")
            ) : c.key === "format" ? (
              formatCell(track)
            ) : c.key === "tempo" ? (
              facts && facts.bpm > 0 ? Math.round(facts.bpm) : ""
            ) : c.key === "key" ? (
              <KeyCell facts={facts} />
            ) : c.key === "heard" ? (
              heardCell(plays * (track.duration || 0))
            ) : plays > 0 ? (
              plays
            ) : (
              ""
            )}
          </div>
        )
      )}

      {/* A like and a saved copy stay in view; the rest shows on hover. */}
      <div className="w-[88px] shrink-0 flex items-center justify-end gap-0.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleLike(track);
          }}
          title={liked ? T("Remove from Liked Songs") : T("Add to Liked Songs")}
          aria-label={liked ? T("Remove from Liked Songs") : T("Add to Liked Songs")}
          className={`p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-[color,background-color,opacity] ${liked ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
        >
          <Heart key={liked ? "liked" : "unliked"} className={`w-4 h-4 animate-icon-pop ${liked ? "fill-accent text-accent" : ""}`} />
        </button>
        <FileButton track={track} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            openMenu(e.clientX, e.clientY);
          }}
          title={T("More options")}
          aria-label={T("More options")}
          className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-[color,background-color,opacity] opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>

      {columns.some((c) => c.key === "time") && (
        <div className="w-11 shrink-0 text-right text-xs text-ink-faint tabular-nums">
          {track.duration > 0 ? fmtTime(track.duration) : "—"}
        </div>
      )}
    </div>
  );
});

/** A song's key as its place on the Camelot wheel ("8A"), its name ("a-Moll") on hover. */
function KeyCell({ facts }: { facts?: SoundFacts }) {
  const c = facts && facts.key >= 0 ? camelotOf(facts.key, facts.minor) : null;
  if (!c || !facts) return null;
  return (
    <span title={keyLabel(facts.key, facts.minor)} className="inline-flex items-center h-5 px-1.5 rounded-md bg-ink-hi/[0.07] text-[11px] font-bold text-ink-dim tabular-nums">
      {camelotLabel(c)}
    </span>
  );
}

type ShownColumn = { key: TrackColumn; width: number; right: boolean };

/** A column's width comes from the list (a CSS variable), so pulling it moves every row without a single one being drawn anew. */
const cellWidth = (key: TrackColumn): CSSProperties => ({ width: `var(--col-${key})` });

const COLUMN_LABEL: Record<TrackColumn, string> = {
  album: T("Album"),
  added: T("Added"),
  released: T("Released"),
  genre: T("Genre"),
  format: T("Format"),
  tempo: T("Tempo"),
  key: T("Key"),
  plays: T("Plays"),
  heard: T("Heard by you"),
  time: T("Time"),
};
const NO_COUNTS = {};
const NO_FACTS: Record<string, SoundFacts> = {};

const SORT_LABEL: Record<SortKey, string> = {
  title: T("Title"),
  artist: T("Artist"),
  album: T("Album"),
  added: T("Date added"),
  released: T("Release date"),
  genre: T("Genre"),
  format: T("Quality"),
  tempo: T("Tempo"),
  key: T("Key"),
  plays: T("Plays"),
  heard: T("Heard by you"),
  time: T("Duration"),
  flow: T("Flowing"),
};

/** Which way a list stands ordered by this column, as the small mark beside its name. */
function SortMark({ desc }: { desc: boolean }) {
  return desc ? <ChevronDown aria-hidden className="w-3 h-3 shrink-0 text-accent" /> : <ChevronUp aria-hidden className="w-3 h-3 shrink-0 text-accent" />;
}

/**
 * A column's name in the list's head: a click orders the list by it (again: the other way round;
 * a third time: the list's own order), a drag moves the column. On its left edge, showing while
 * the pointer is over the head, a small handle: pulled, the column gets wider or narrower; a
 * double click gives it its own width back.
 */
function HeadCell({
  column,
  sorted,
  moving,
  onLabelDown,
  onSort,
  onPull,
  onPulled,
  onReset,
}: {
  column: ShownColumn;
  /** the list is ordered by this column: which way */
  sorted: ListSort | null;
  /** being dragged to another place */
  moving: boolean;
  onLabelDown: (key: TrackColumn, e: ReactPointerEvent<HTMLElement>) => void;
  /** from the keyboard: Enter or Space on the name */
  onSort: (key: TrackColumn) => void;
  onPull: (key: TrackColumn, width: number) => void;
  onPulled: (key: TrackColumn, width: number) => void;
  onReset: (key: TrackColumn) => void;
}) {
  const from = useRef<{ x: number; width: number; now: number } | null>(null);
  const label = COLUMN_LABEL[column.key];
  return (
    <div data-col={column.key} style={cellWidth(column.key)} className={`relative shrink-0 ${column.right ? "text-right" : ""}`}>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={T("Width of the {name} column", { name: COLUMN_LABEL[column.key] })}
        title={T("Drag to change the width; double-click to reset it")}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          from.current = { x: e.clientX, width: column.width, now: column.width };
        }}
        onPointerMove={(e) => {
          if (!from.current) return;
          // The column's right side stays where it is: pulling to the left makes it wider.
          from.current.now = from.current.width - (e.clientX - from.current.x);
          onPull(column.key, from.current.now);
        }}
        onPointerUp={(e) => {
          if (!from.current) return;
          e.currentTarget.releasePointerCapture(e.pointerId);
          const { now, width } = from.current;
          from.current = null;
          if (now !== width) onPulled(column.key, now);
        }}
        onDoubleClick={() => onReset(column.key)}
        className="column-grip absolute -left-[12px] top-1/2 -translate-y-1/2 w-[10px] h-5 grid place-items-center cursor-col-resize opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100 transition-opacity"
      >
        <span className="w-[3px] h-3 rounded-full bg-ink-hi/30" />
      </span>
      <span
        role="button"
        tabIndex={0}
        onPointerDown={(e) => onLabelDown(column.key, e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSort(column.key);
          }
        }}
        title={column.key === "time" ? T("Order by {name}", { name: label }) : T("Click to order by {name}, drag to move the column", { name: label })}
        className={`inline-flex max-w-full items-center gap-1 align-middle cursor-pointer select-none transition-colors hover:text-ink-hi ${column.right ? "flex-row-reverse" : ""} ${
          sorted ? "text-accent" : ""
        } ${moving ? "text-ink-hi cursor-grabbing" : ""}`}
      >
        <span className="truncate">{label}</span>
        {sorted && <SortMark desc={sorted.desc} />}
      </span>
    </div>
  );
}

interface TrackListProps {
  tracks: Track[];
  onPlay?: (index: number) => void;
  showAlbum?: boolean;
  showHeader?: boolean;
  /** when each song joined this list, by song (lib/listDates.ts); without it the Added column says when the library got the song */
  addedDates?: ReadonlyMap<string, number>;
  /** the list puts its newest songs first (Liked Songs); a playlist adds them at the end */
  newestFirst?: boolean;
  /** remembers how this list was last ordered ("liked", a playlist's or album's id); without it the order lasts as long as the page */
  listKey?: string;
  /** a search and an order to choose above the head (playlists, Liked Songs); what the search field says when empty */
  searchLabel?: string;
  menuFor?: (track: Track, from?: TrackSource) => MenuItem[];
  /** the list's name ("Lanterns", "Liked Songs"): its songs can be branched off into from the queue */
  sourceName?: string;
  emptyLabel?: string;
  emptyTitle?: string;
}

/** A column's name, as an order: the time column orders by length. */
const SORT_OF: Record<TrackColumn, SortKey> = {
  album: "album",
  added: "added",
  released: "released",
  genre: "genre",
  format: "format",
  tempo: "tempo",
  key: "key",
  plays: "plays",
  heard: "heard",
  time: "time",
};

export function TrackList({
  tracks,
  onPlay,
  showAlbum = true,
  showHeader = true,
  menuFor = trackMenuItems,
  sourceName,
  emptyLabel,
  emptyTitle = T("Nothing here yet"),
  addedDates,
  newestFirst = false,
  listKey,
  searchLabel,
}: TrackListProps) {
  const rawChoice = useSettings((s) => s.trackColumns);
  const savedChoice = useMemo(() => readColumns(rawChoice), [rawChoice]);
  const setChoice = useSettings((s) => s.setTrackColumns);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const root = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setRoom(el.clientWidth);
    const seen = new ResizeObserver(() => setRoom(el.clientWidth));
    seen.observe(el);
    return () => seen.disconnect();
  }, [tracks.length === 0]);

  // How the list stands ordered: remembered for the list, or for as long as the page is open.
  const savedSort = useSettings((s) => (listKey ? s.listSorts?.[listKey] : undefined));
  const [pageSort, setPageSort] = useState<ListSort | null>(null);
  const sort = listKey ? readListSort(savedSort) : pageSort;
  const setSort = useCallback(
    (next: ListSort | null) => {
      if (listKey) useSettings.getState().setListSort(listKey, next);
      else setPageSort(next);
    },
    [listKey]
  );
  const sortBy = useCallback((key: SortKey) => setSort(nextListSort(sort, key)), [setSort, sort]);

  // A column being dragged to another place: the head and the rows show it there at once, it's kept when let go.
  const [dragChoice, setDragChoice] = useState<ReturnType<typeof moved> | null>(null);
  const [movingKey, setMovingKey] = useState<TrackColumn | null>(null);
  const choice = dragChoice ?? savedChoice;

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  // When a song joined: this list, where the list knows. Songs that were in the list before
  // dates were kept (likes from older versions, say) fall back to the day the library got them —
  // close enough, and better than a blank — as does a list that keeps no dates of its own.
  const addedOf = useCallback((t: Track): number => (addedDates?.get(songKey(t.id)) || t.addedAt) ?? 0, [addedDates]);
  // The sound analysis' facts, only while a column or the order needs them.
  const wantsSound = choice.shown.includes("tempo") || choice.shown.includes("key") || sort?.key === "tempo" || sort?.key === "key" || sort?.key === "flow";
  const facts = useSound((s) => (wantsSound ? s.facts : NO_FACTS));
  // A column nobody here could fill stays away, whatever is switched on.
  const has = useMemo(
    () => ({
      album: showAlbum && tracks.some((t) => !!t.album),
      added: tracks.some((t) => addedOf(t) > 0),
      released: tracks.some((t) => !!releasedCell(t)),
      genre: tracks.some((t) => !!t.genre),
      format: tracks.some((t) => !!formatCell(t)),
      tempo: tracks.some((t) => (soundOf(t, facts)?.bpm ?? 0) > 0),
      key: tracks.some((t) => (soundOf(t, facts)?.key ?? -1) >= 0),
    }),
    [tracks, showAlbum, addedOf, facts]
  );
  const columns = useMemo(() => columnsFor(choice, has, room), [choice, has, room]);
  const showsPlays = columns.some((c) => c.key === "plays" || c.key === "heard") || sort?.key === "plays" || sort?.key === "heard";
  const showsSound = columns.some((c) => c.key === "tempo" || c.key === "key");
  const playCounts = useCatalog((s) => (showsPlays ? s.playCounts : NO_COUNTS)) as Record<string, { plays: number } | undefined>;
  const widths = useMemo(() => Object.fromEntries(TRACK_COLUMNS.map((c) => [`--col-${c.key}`, `${widthOf(choice, c.key)}px`])) as CSSProperties, [choice]);

  // The songs as they show: in the order asked for, then what the search lets through.
  const shown = useMemo(() => {
    let list = tracks;
    if (sort) {
      const order = sort.key === "added" ? addedForOrder(tracks.map((t) => addedOf(t)), newestFirst) : null;
      const playsOf = (t: Track): number => playCounts[t.id]?.plays ?? 0;
      list = sortTracks(tracks, sort, (i) => order?.[i] ?? 0, playsOf, {
        tempo: (t) => soundOf(t, facts)?.bpm ?? 0,
        keyRank: (t) => {
          const f = soundOf(t, facts);
          const c = f && f.key >= 0 ? camelotOf(f.key, f.minor) : null;
          return c ? c.n * 2 + (c.ring === "B" ? 1 : 0) : 0;
        },
        heard: (t) => playsOf(t) * (t.duration || 0),
        flow: (list) => flowOrder(list.map((t) => ({ item: t, facts: soundOf(t, facts), artist: t.artist, skips: skipsOf(t.id) })), { arc: true }),
      });
    }
    return query.trim() ? list.filter((t) => matchesSearch(t, query)) : list;
  }, [tracks, sort, addedOf, newestFirst, playCounts, query, facts]);

  const pull = useCallback((key: TrackColumn, width: number) => {
    const spec = TRACK_COLUMNS.find((c) => c.key === key)!;
    root.current?.style.setProperty(`--col-${key}`, `${Math.round(Math.min(spec.max, Math.max(spec.min, width)))}px`);
  }, []);
  const pulled = useCallback((key: TrackColumn, width: number) => setChoice(resized(readColumns(useSettings.getState().trackColumns), key, width)), [setChoice]);
  const reset = useCallback((key: TrackColumn) => setChoice(resized(readColumns(useSettings.getState().trackColumns), key, null)), [setChoice]);
  const chooseColumns = (x: number, y: number): void => {
    const now = readColumns(useSettings.getState().trackColumns);
    openContextMenu(
      x,
      y,
      [
        { label: T("Columns"), header: true },
        ...TRACK_COLUMNS.filter((c) => c.key !== "album" || showAlbum).map((c): MenuItem => ({
          label: COLUMN_LABEL[c.key],
          icon: Check,
          iconClassName: now.shown.includes(c.key) ? "" : "opacity-0",
          action: () => setChoice(toggled(readColumns(useSettings.getState().trackColumns), c.key)),
        })),
      ],
      { alignRight: true }
    );
  };

  /**
   * A press on a column's name: let go where it was, it orders the list; moved sideways, the column
   * goes with the pointer, in front of the first other column whose middle lies past it.
   */
  const labelDown = useCallback(
    (key: TrackColumn, e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const el = e.currentTarget;
      // Capture so the drag survives leaving the head; a synthetic event (tests) has no real pointer to capture.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* the move and up still come through the listeners below */
      }
      const startX = e.clientX;
      let dragging = false;
      let latest: ReturnType<typeof moved> | null = null;
      const movable = key !== "time";
      const move = (ev: PointerEvent): void => {
        if (!movable) return;
        if (!dragging && Math.abs(ev.clientX - startX) < 5) return;
        if (!dragging) {
          dragging = true;
          setMovingKey(key);
        }
        const others = [...(head.current?.querySelectorAll<HTMLElement>("[data-col]") ?? [])].filter((c) => c.dataset.col !== key && c.dataset.col !== "time");
        const next = others.find((c) => {
          const r = c.getBoundingClientRect();
          return r.left + r.width / 2 > ev.clientX;
        });
        const base = readColumns(useSettings.getState().trackColumns);
        const candidate = moved(latest ?? base, key, (next?.dataset.col as TrackColumn | undefined) ?? null);
        if (!latest || candidate.order?.join() !== latest.order?.join()) {
          latest = candidate;
          setDragChoice(candidate);
        }
      };
      const up = (): void => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        try {
          if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        } catch {
          /* nothing was captured */
        }
        if (dragging) {
          if (latest) setChoice(latest);
          setDragChoice(null);
          setMovingKey(null);
        } else {
          sortBy(SORT_OF[key]);
        }
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    },
    [setChoice, sortBy]
  );
  const sortByColumn = useCallback((key: TrackColumn) => sortBy(SORT_OF[key]), [sortBy]);

  const chooseOrder = (x: number, y: number): void => {
    // Tempo, key and the flowing order need songs the analysis measured; the facts are read now, not kept.
    const measured = tracks.some((t) => soundOf(t)?.bpm);
    const keys: SortKey[] = [
      "title",
      "artist",
      ...(has.album ? (["album"] as SortKey[]) : []),
      ...(has.added ? (["added"] as SortKey[]) : []),
      ...(has.released ? (["released"] as SortKey[]) : []),
      ...(has.genre ? (["genre"] as SortKey[]) : []),
      ...(has.format ? (["format"] as SortKey[]) : []),
      ...(measured ? (["tempo", "key"] as SortKey[]) : []),
      "plays",
      "heard",
      "time",
      ...(measured ? (["flow"] as SortKey[]) : []),
    ];
    openContextMenu(
      x,
      y,
      [
        { label: T("Order by"), header: true },
        { label: T("Custom order"), icon: Check, iconClassName: sort ? "opacity-0" : "", action: () => setSort(null) },
        ...keys.map((key): MenuItem => ({
          label: SORT_LABEL[key],
          icon: sort?.key === key ? (sort.desc ? ChevronDown : ChevronUp) : Check,
          iconClassName: sort?.key === key ? "text-accent" : "opacity-0",
          // The order already chosen, chosen again: the other way round.
          action: () => setSort(sort?.key === key ? { key, desc: !sort.desc } : { key, desc: FIRST_DESC[key] }),
        })),
      ],
      { alignRight: true }
    );
  };

  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const playing = usePlayer((s) => s.playing);
  const playQueue = usePlayer((s) => s.playQueue);
  const available = useAvailabilityCheck();
  // Songs that can't play right now stay out of the queue (the clicked one can). What plays is
  // what shows: the list in the order chosen, as far as the search lets it through.
  // Stable across renders, so the memoized rows don't all re-render with it.
  const playFromList = useCallback(
    (i: number) => {
      const queue: Track[] = [];
      let start = 0;
      shown.forEach((t, j) => {
        if (j === i) start = queue.length;
        if (j === i || available(t)) queue.push(t);
      });
      playQueue(queue, start);
    },
    [shown, available, playQueue]
  );
  // A list that plays in its own way (an album from a song on) gets the song's place in the whole list.
  const playOwn = useCallback((i: number) => onPlay?.(Math.max(0, tracks.indexOf(shown[i]))), [onPlay, tracks, shown]);
  const play = onPlay ? (shown === tracks ? onPlay : playOwn) : playFromList;

  if (!tracks.length) {
    return <EmptyState icon={Play} title={emptyTitle} body={emptyLabel ?? T("Tracks will appear here.")} />;
  }

  const closeSearch = (): void => {
    setQuery("");
    setSearching(false);
  };

  return (
    <div ref={root} style={widths}>
      {searchLabel !== undefined && (
        <div className="flex items-center justify-end gap-1 -mt-1 mb-2 min-h-[36px]">
          {searching ? (
            <label className="flex items-center gap-2 h-9 w-[260px] max-w-full px-3 rounded-full bg-ink-hi/[0.08] focus-within:bg-ink-hi/[0.11] transition-colors">
              <Search className="w-4 h-4 shrink-0 text-ink-faint" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeSearch();
                }}
                onBlur={() => {
                  if (!query.trim()) setSearching(false);
                }}
                placeholder={searchLabel}
                aria-label={searchLabel}
                className="flex-1 min-w-0 bg-transparent outline-none text-[13.5px] text-ink-hi placeholder:text-ink-faint"
              />
              {query && (
                <button onClick={closeSearch} title={T("Clear the search")} aria-label={T("Clear the search")} className="text-ink-faint hover:text-ink-hi transition-colors">
                  <X className="w-4 h-4" />
                </button>
              )}
            </label>
          ) : (
            <button
              onClick={() => setSearching(true)}
              title={searchLabel}
              aria-label={searchLabel}
              className="p-2 rounded-full text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
            >
              <Search className="w-[18px] h-[18px]" />
            </button>
          )}
          <button
            onClick={(e) => {
              const at = e.currentTarget.getBoundingClientRect();
              chooseOrder(at.right, at.bottom + 6);
            }}
            title={T("Order the list")}
            className="inline-flex items-center gap-2 h-9 pl-3 pr-2.5 rounded-full text-[13px] font-medium text-ink-dim hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
          >
            {sort ? SORT_LABEL[sort.key] : T("Custom order")}
            <List className="w-4 h-4" />
          </button>
        </div>
      )}
      {showHeader && (
        <div
          ref={head}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            chooseColumns(e.clientX, e.clientY);
          }}
          className="group/head flex items-center gap-3.5 px-3 pb-2.5 mb-1 border-b border-ink-hi/[0.06] text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-ghost"
        >
          <div className="w-7 shrink-0">
            <button
              onClick={() => setSort(null)}
              title={T("The list's own order")}
              className={`uppercase tracking-[0.14em] transition-colors hover:text-ink-hi ${sort ? "" : "text-ink-faint"}`}
            >
              #
            </button>
          </div>
          <div className="w-[52px] shrink-0" />
          <div className="flex-1 min-w-[120px]">
            <button
              onClick={() => sortBy(sort?.key === "artist" ? "artist" : "title")}
              title={T("Order by title")}
              className={`inline-flex items-center gap-1 uppercase tracking-[0.14em] transition-colors hover:text-ink-hi ${sort?.key === "title" || sort?.key === "artist" ? "text-accent" : ""}`}
            >
              {sort?.key === "artist" ? T("Title · by artist") : T("Title")}
              {(sort?.key === "title" || sort?.key === "artist") && <SortMark desc={sort.desc} />}
            </button>
          </div>
          {columns.map((c) =>
            c.key === "time" ? null : (
              <HeadCell
                key={c.key}
                column={c}
                sorted={sort && sort.key === SORT_OF[c.key] ? sort : null}
                moving={movingKey === c.key}
                onLabelDown={labelDown}
                onSort={sortByColumn}
                onPull={pull}
                onPulled={pulled}
                onReset={reset}
              />
            )
          )}
          {/* Over the rows' buttons, at the head's right end: which columns there are. */}
          <div className="w-[88px] shrink-0 flex justify-end">
            <button
              onClick={(e) => {
                const at = e.currentTarget.getBoundingClientRect();
                chooseColumns(at.right, at.bottom + 6);
              }}
              title={T("Choose the columns")}
              aria-label={T("Choose the columns")}
              className="-my-1.5 p-1.5 rounded-md text-ink-ghost hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          {columns.some((c) => c.key === "time") && (
            <div className="w-11 shrink-0 text-right">
              <button
                onClick={() => sortBy("time")}
                title={T("Order by {name}", { name: SORT_LABEL.time })}
                className={`inline-flex items-center gap-1 flex-row-reverse uppercase tracking-[0.14em] transition-colors hover:text-ink-hi ${sort?.key === "time" ? "text-accent" : ""}`}
              >
                {T("Time")}
                {sort?.key === "time" && <SortMark desc={sort.desc} />}
              </button>
            </div>
          )}
        </div>
      )}
      <div>
        {shown.length === 0 && query.trim() ? (
          <div className="py-10 text-center text-sm text-ink-dim">{T("No song here matches “{query}”", { query: query.trim() })}</div>
        ) : null}
        {shown.map((track, i) => {
          const isCurrent = sameSong(track.id, currentId);
          return (
            <Fragment key={`${track.id}-${i}`}>
              <TrackRow
                track={track}
                index={i}
                isCurrent={isCurrent}
                // Only the current row cares whether playback runs — the others keep equal props.
                isPlaying={isCurrent && playing}
                available={available(track)}
                onPlay={play}
                menuFor={menuFor}
                columns={columns}
                added={addedOf(track)}
                plays={showsPlays ? (playCounts[track.id]?.plays ?? 0) : 0}
                facts={showsSound ? soundOf(track, facts) : undefined}
                sourceName={sourceName}
                sourceTracks={shown}
              />
              {/* Hairline divider, inset to the title column — mobile's
                  ROW_DIVIDER_INSET clears the 52dp artwork the same way. */}
              {i < shown.length - 1 && <div className="h-px bg-ink-hi/[0.05] ml-[120px] mr-3" />}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
