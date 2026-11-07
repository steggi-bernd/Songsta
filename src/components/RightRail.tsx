/**
 * Right rail — the always-on song-details panel, Spotify-style.
 *
 * Default mode ("details"): a sharp artwork tile over the track title (it
 * opens the album) and the artists (each opens their page), then Next up,
 * About the song (Genius, plus the measured tempo and key) and an
 * About-the-artist card in Spotify's shape — photo header, name, facts line
 * beside a Wikipedia pill, and the Wikipedia lead — clicking it opens the
 * artist in the library. The queue button in the player bar swaps the
 * body to the queue sheet ("Queue" / "Recently played" text tabs with the
 * underline treatment, X returns to details). Lyrics live in the centre pane
 * (see LyricsCenter.tsx), not here.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Music2, Split, X } from "lucide-react";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { useAvailabilityCheck } from "../stores/availability";
import { Artwork, EqBars, IconBtn } from "./primitives";
import { handRows } from "../lib/queueSections";
import { draggedTrack, dragHasQueueRow, dragHasTrack, readQueueIndex, readTrack, useDrag } from "../lib/dnd";
import { branchOffAfterDrop } from "../lib/trackActions";
import { fmtTime } from "../lib/format";
import { useArtistAbout } from "../lib/artistAbout";
import { useArtistImages, useSongInfo } from "../lib/songInfo";
import { isLibraryTrack, leadArtist } from "../lib/libraryTracks";
import { ArtistLinks } from "./ArtistLinks";
import { DevicesPanel } from "./DevicesPanel";
import { useLibrary } from "../stores/library";
import { useSettings } from "../stores/settings";
import { soundOf, useSound } from "../stores/sound";
import { keyName } from "../../electron/sound-analysis";
import type { Track } from "../types";
import { upgradeArtwork } from "../lib/artwork";
import { T } from "../lib/i18n";

/** The queue's "Now playing" row — draggable like every other song row. */
function QueueCurrentRow({ track, playing }: { track: Track; playing: boolean }) {
  const drag = useDrag({ track });
  return (
    <div
      {...drag.props}
      className={`flex items-center gap-3 h-14 px-2 rounded-lg bg-ink-hi/[0.14] ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      <Artwork src={track.thumb} className="w-11 h-11 rounded-md shrink-0" iconClassName="w-4 h-4" alt="" />
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold truncate text-ink-hi flex items-center gap-2">
          <span className="truncate">{track.title}</span>
          {playing && <EqBars />}
        </div>
        <div className="text-[12px] truncate text-ink-hi/55 mt-0.5">{track.artist}</div>
      </div>
    </div>
  );
}

function TrackRow({
  track,
  isCurrent,
  isPlaying,
  onPlay,
  onRemove,
  queueIndex,
  available = true,
  dropEdge,
  onDragOver,
  onDrop,
}: {
  track: Track;
  isCurrent?: boolean;
  isPlaying?: boolean;
  onPlay: () => void;
  onRemove?: () => void;
  /** upcoming rows: their queue position — dragging them reorders the queue */
  queueIndex?: number;
  available?: boolean;
  /** where a dragged row would land relative to this one */
  dropEdge?: "before" | "after" | null;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  const drag = useDrag(queueIndex !== undefined ? { track, queueIndex } : { track });
  return (
    <div
      {...drag.props}
      data-queue-at={queueIndex}
      onClick={available ? onPlay : undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
      title={available ? undefined : T("Not available right now — its drive or server can't be reached")}
      className={`group relative flex items-center gap-3 h-12 px-2 rounded-lg select-none transition-colors ${
        available ? "cursor-pointer" : "cursor-default"
      } ${isCurrent ? "bg-ink-hi/[0.14]" : "hover:bg-ink-hi/[0.05]"} ${drag.dragging || !available ? "opacity-40" : ""}`}
    >
      {dropEdge && (
        <span
          aria-hidden
          className={`pointer-events-none absolute left-2 right-2 h-0.5 rounded-full bg-accent ${
            dropEdge === "before" ? "-top-[2px]" : "-bottom-[2px]"
          }`}
        />
      )}
      <Artwork src={track.thumb} className="w-9 h-9 rounded-md shrink-0" iconClassName="w-3.5 h-3.5" alt="" />
      <div className="flex-1 min-w-0">
        <div className={`text-[13px] truncate font-semibold ${isCurrent ? "text-accent" : "text-ink-hi"}`}>
          {track.title}
        </div>
        <div className="text-[11.5px] truncate text-ink-hi/55 mt-0.5">{track.artist}</div>
      </div>
      {isCurrent && isPlaying && <EqBars />}
      {track.duration > 0 && (
        <div className="w-9 text-right text-[11px] text-ink-hi/45 tabular-nums shrink-0">{fmtTime(track.duration)}</div>
      )}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title={T("Remove from queue")}
          aria-label={T("Remove from queue")}
          className="p-1 rounded-md text-ink-hi/45 hover:text-red-400 hover:bg-ink-hi/[0.06] transition-all shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ dropping on the queue */

/**
 * Drag to reorder "Next up" — or drag a song in from any list: the row
 * under the pointer shows where it lands (above or below it, by the
 * pointer's half). `tail` is the row the space below the list stands for:
 * the queue's last song in the queue panel, the card's last row in the
 * details' "Next up". The playing song stays put.
 */
function useQueueDrop(tail: () => number) {
  const index = usePlayer((s) => s.index);
  const moveInQueue = usePlayer((s) => s.moveInQueue);
  const [drop, setDrop] = useState<{ index: number; before: boolean } | null>(null);
  useEffect(() => {
    const clear = (): void => setDrop(null);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);
  const edgeOf = (e: React.DragEvent): boolean => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2;
  };
  const moveTo = (from: number | null, insertAt: number): void => {
    setDrop(null);
    if (from === null || from <= index) return;
    const to = from < insertAt ? insertAt - 1 : insertAt;
    if (to !== from && to > index) moveInQueue(from, to);
  };
  /** A queue row moves; a song from elsewhere is added (its drag allows copying only). */
  const accepts = (e: React.DragEvent): boolean => dragHasQueueRow(e) || dragHasTrack(e);
  const dropSong = (e: React.DragEvent, insertAt: number): void => {
    setDrop(null);
    const track = readTrack(e);
    if (!track) return;
    usePlayer.getState().insertInQueue([track], insertAt);
    // From a list: the toast offers to go on with the rest of that list behind it.
    const drag = draggedTrack();
    const from = drag?.from && drag.track.id === track.id ? drag.from : null;
    const branch = from && from.index < from.tracks.length - 1 ? from : null;
    useUI.getState().toast(
      T("Added “{title}” to the queue", { title: track.title }),
      "info",
      branch ? 7000 : 4600,
      branch ? { label: T("Branch off"), run: () => branchOffAfterDrop(branch) } : undefined
    );
  };
  const rowDragOver = (at: number) => (e: React.DragEvent): void => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dragHasQueueRow(e) ? "move" : "copy";
    const before = edgeOf(e);
    setDrop((d) => (d?.index === at && d.before === before ? d : { index: at, before }));
  };
  const rowDrop = (at: number) => (e: React.DragEvent): void => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const insertAt = edgeOf(e) ? at : at + 1;
    if (dragHasQueueRow(e)) moveTo(readQueueIndex(e), insertAt);
    else dropSong(e, insertAt);
  };
  /** The list itself — the gaps between rows and the space below them: before
      the first row whose middle is below the pointer, else after the last. (On
      a gap the line used to jump to the end of the list.) */
  const slotAt = (e: React.DragEvent): { index: number; before: boolean } => {
    for (const row of Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-queue-at]"))) {
      const r = row.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return { index: Number(row.dataset.queueAt), before: true };
    }
    return { index: tail(), before: false };
  };
  return { drop, setDrop, accepts, moveTo, dropSong, rowDragOver, rowDrop, slotAt };
}

/* ------------------------------------------------------------ queue sheet */

/** Exported for the fullscreen player's Queue view — the same sheet, data
    and behavior as the right-rail queue; only the mount point differs. */
export function QueuePanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"queue" | "recent">("queue");
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const playing = usePlayer((s) => s.playing);
  const removeAt = usePlayer((s) => s.removeAt);
  const history = useLibrary((s) => s.history);
  const playTrack = usePlayer((s) => s.playTrack);
  const available = useAvailabilityCheck();

  const current = queue[index] ?? null;
  const upcoming = queue.slice(index + 1);
  const lineEnd = usePlayer((s) => s.lineEnd);
  const branches = usePlayer((s) => s.branches);
  const [openBranches, setOpenBranches] = useState<ReadonlySet<string>>(new Set());
  const handEnd = Math.min(queue.length, Math.max(index + 1, lineEnd));
  const hand = handRows(queue, index, lineEnd, branches, openBranches);
  const fromTheList = queue.slice(handEnd);

  const { drop, setDrop, accepts, moveTo, dropSong, rowDragOver, rowDrop, slotAt } = useQueueDrop(() => queue.length - 1);
  // Row keys must not depend on the current queue index: embedding `index`
  // shifted every key on each track advance, remounting the whole upcoming
  // list (new drag state, new <img> decode) per track. Key by id plus its
  // occurrence number within the queue — stable across playback.
  const occurrence = new Map<string, number>();
  const stableKey = (id: string): string => {
    const n = occurrence.get(id) ?? 0;
    occurrence.set(id, n + 1);
    return `${id}#${n}`;
  };

  const queueRow = (t: Track, at: number) => (
    <TrackRow
      key={stableKey(t.id)}
      track={t}
      queueIndex={at}
      available={available(t)}
      dropEdge={drop?.index === at ? (drop.before ? "before" : "after") : null}
      onDragOver={rowDragOver(at)}
      onDrop={rowDrop(at)}
      onPlay={() => usePlayer.getState().jumpTo(at)}
      onRemove={() => {
        // Removing a row shifts the list up under a stationary
        // pointer — the row now under it never fires mouseenter,
        // so clear the hover wash here (navigate() does the same
        // for view changes).
        useUI.getState().setTintThumb(null);
        removeAt(at);
      }}
    />
  );

  const TabBtn = ({
    id,
    label,
  }: {
    id: "queue" | "recent";
    label: string;
  }) => (
    <button
      onClick={() => setTab(id)}
      aria-pressed={tab === id}
      className={`relative h-full px-1 text-[14px] font-bold tracking-[-0.2px] transition-colors ${
        tab === id ? "text-ink-hi" : "text-ink-hi/55 hover:text-ink-hi/85"
      }`}
    >
      {label}
      {/* Spotify's underline treatment — ours is white on the black canvas. */}
      <span
        className={`absolute left-0 right-0 bottom-0 h-[3px] rounded-full transition-opacity ${
          tab === id ? "bg-ink-hi opacity-100" : "opacity-0"
        }`}
      />
    </button>
  );

  return (
    <>
      {/* Header — Queue / Recently played tabs + close back to details. */}
      <div className="h-14 shrink-0 flex items-center gap-5 px-5 border-b border-ink-hi/[0.08]">
        <TabBtn id="queue" label={T("Queue")} />
        <TabBtn id="recent" label={T("Recently played")} />
        <div className="ml-auto">
          <IconBtn
            icon={X}
            title={T("Close queue")}
            onClick={onClose}
            className="rounded-full text-ink-hi/55 hover:text-ink-hi"
          />
        </div>
      </div>

      {tab === "queue" ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <span className="micro-label text-ink-hi/55">{T("Now playing")}</span>
            {upcoming.length > 0 && (
              <button
                onClick={() => usePlayer.getState().clearUpcoming()}
                className="text-[13px] font-semibold text-ink-hi/75 hover:text-ink-hi transition-colors"
                title={T("Clear upcoming")}
              >{T("Clear")}</button>
            )}
          </div>
          <div className="px-2 pb-2">
            {current ? (
              <QueueCurrentRow track={current} playing={playing} />
            ) : (
              <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">{T("Nothing playing — start a track to see your queue here.")}</div>
            )}
          </div>

          <div
            className="flex-1 min-h-0 overflow-y-auto scroll-center px-2 pt-1 pb-3 space-y-0.5"
            onDragOver={(e) => {
              if (!accepts(e) || (dragHasQueueRow(e) && !upcoming.length)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = dragHasQueueRow(e) ? "move" : "copy";
              const slot = slotAt(e);
              setDrop((d) => (d?.index === slot.index && d.before === slot.before ? d : slot));
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
            }}
            onDrop={(e) => {
              if (!accepts(e)) return;
              e.preventDefault();
              const slot = slotAt(e);
              const insertAt = slot.before ? slot.index : slot.index + 1;
              if (dragHasQueueRow(e)) moveTo(readQueueIndex(e), insertAt);
              else dropSong(e, insertAt);
            }}
          >
            {hand.length > 0 && (
              <div className="mb-2 rounded-xl bg-ink-hi/[0.05] p-1.5 pt-2">
                <div className="flex items-center justify-between px-2 pb-1.5">
                  <span className="min-w-0 truncate text-[12.5px] font-bold text-accent">{T("Next in queue")}</span>
                  <button onClick={() => usePlayer.getState().clearLine()} className="shrink-0 ml-2 text-[12px] font-semibold text-ink-hi/65 hover:text-ink-hi transition-colors">{T("Clear")}</button>
                </div>
                <div className="space-y-0.5">
                  {hand.map((row) => {
                    const openOrClose = (name: string): void => {
                      const next = new Set(openBranches);
                      if (!next.delete(name)) next.add(name);
                      setOpenBranches(next);
                    };
                    if (row.kind === "song") return queueRow(row.track, row.at);
                    if (row.kind === "more") {
                      return (
                        <button
                          key={`more:${row.branch}`}
                          onClick={() => openOrClose(row.branch)}
                          className="w-full flex items-center gap-2 h-8 pl-[60px] pr-2 rounded-lg text-left text-[12.5px] font-semibold text-ink-hi/60 hover:text-ink-hi hover:bg-ink-hi/[0.05] transition-colors"
                        >
                          <span className="truncate">{T("{count} more", { count: row.count })}</span>
                          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                        </button>
                      );
                    }
                    const open = openBranches.has(row.branch);
                    return (
                      <div key={`branch:${row.branch}`} className="flex items-center gap-1 h-8 pl-2 pr-1 mt-1 first:mt-0">
                        <button
                          onClick={() => row.folds && openOrClose(row.branch)}
                          title={row.folds ? (open ? T("Show less") : T("Show all")) : undefined}
                          className={`flex-1 min-w-0 flex items-center gap-2 text-left text-[12.5px] font-semibold text-ink-hi/80 transition-colors ${row.folds ? "hover:text-ink-hi" : "cursor-default"}`}
                        >
                          <Split className="w-3.5 h-3.5 shrink-0 text-accent" />
                          <span className="truncate">{row.branch}</span>
                          <span className="shrink-0 font-normal text-ink-hi/50 tabular-nums">{row.count}</span>
                          {row.folds && (open ? <ChevronUp className="w-3.5 h-3.5 shrink-0 text-ink-hi/50" /> : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-ink-hi/50" />)}
                        </button>
                        <button
                          onClick={() => usePlayer.getState().cancelBranch(row.branch)}
                          title={T("Undo branch")}
                          aria-label={T("Undo branch")}
                          className="p-1 rounded-md text-ink-hi/45 hover:text-red-400 hover:bg-ink-hi/[0.06] transition-all shrink-0"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {(fromTheList.length > 0 || !hand.length) && <h2 className="px-2 pt-1 pb-1 text-[20px] font-extrabold tracking-[-0.4px] text-ink-hi">{T("Next up")}</h2>}
            {upcoming.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">{T("Your queue is empty.")}</div>}
            {fromTheList.map((t, i) => queueRow(t, handEnd + i))}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto scroll-center px-2 py-2 space-y-0.5">
          {history.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">{T("Nothing here yet — tracks you play land in Recently played.")}</div>
          ) : (
            history.slice(0, 50).map((t, i) => (
              <TrackRow key={`${t.id}-${i}`} track={t} onPlay={() => playTrack(t)} />
            ))
          )}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- song details */

function DetailsBody() {
  const track = usePlayer((s) => s.queue[s.index] ?? null);
  const navigate = useUI((s) => s.navigate);
  const detailsDrag = useDrag({ track: track ?? { id: "", title: "", artist: "", duration: 0, thumb: "" } });

  if (!track) {
    return (
      <div className="flex-1 grid place-items-center px-6">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-ink-hi/[0.05] grid place-items-center mx-auto mb-4">
            <Music2 className="w-5 h-5 text-ink-hi/35" />
          </div>
          <p className="text-[14px] font-semibold text-ink-hi">{T("Nothing playing")}</p>
          <p className="text-[12.5px] text-ink-hi/55 mt-1">{T("Song details will show up here.")}</p>
        </div>
      </div>
    );
  }

  const album = track.albumId?.startsWith("lib:album:") ? track.albumId : null;
  const openAlbum = (): void => {
    if (album) navigate({ name: "album", param: album });
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-center px-3 py-3 space-y-3">
      {/* Full-width square artwork, Spotify-panel style — everything scrolls.
          The cover + title block is a drag source: drop it on a sidebar
          playlist. The whole header (art, title, artist) shares one drag
          origin so every pixel behaves the same. */}
      <div {...detailsDrag.props} className={detailsDrag.dragging ? "opacity-40" : ""}>
        <Artwork
          key={track.id}
          src={track.thumb}
          className="w-full aspect-square rounded-xl shadow-elev animate-art-in"
          iconClassName="w-10 h-10"
          alt=""
        />

        {/* Title + artist directly under the art, as in the player bar: the
            title opens the album, each credited artist their own page. */}
        <div className="px-0.5 mt-2.5 animate-meta-in" key={`rrmeta-${track.id}`}>
          <div className="text-[24px] font-extrabold tracking-[-0.5px] text-ink-hi leading-tight">
            {album ? (
              <span
                role="link"
                tabIndex={0}
                onClick={openAlbum}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openAlbum();
                }}
                title={track.album ? T("Go to {album}", { album: track.album }) : undefined}
                className="cursor-pointer hover:underline"
              >
                {track.title}
              </span>
            ) : (
              <span title={track.title}>{track.title}</span>
            )}
          </div>
          <div className="text-[14px] text-ink-hi/70 mt-1">
            {isLibraryTrack(track) ? <ArtistLinks artist={track.artist} className="hover:text-ink-hi" /> : track.artist}
          </div>
        </div>
      </div>

      <NextUpCard />
      <AboutSongCard track={track} />
      <AboutArtistCard track={track} />
    </div>
  );
}

/**
 * The next three songs of the queue, right under the song's own details:
 * a click plays one, "Open queue" shows the rest. Songs dragged here land
 * where the line shows and its rows move like the queue's (useQueueDrop);
 * while a song hovers here the panel doesn't turn to the queue. Nothing
 * after this song, no card.
 */
function NextUpCard() {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const playQueue = usePlayer((s) => s.playQueue);
  const available = useAvailabilityCheck();
  const next = queue.slice(index + 1, index + 4);
  const last = index + next.length;
  const { drop, setDrop, accepts, moveTo, dropSong, slotAt } = useQueueDrop(() => last);
  if (!next.length) return null;
  return (
    <section
      aria-label={T("Next up")}
      data-next-up
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = dragHasQueueRow(e) ? "move" : "copy";
        const slot = slotAt(e);
        setDrop((d) => (d?.index === slot.index && d.before === slot.before ? d : slot));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
      }}
      onDrop={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        const slot = slotAt(e);
        const insertAt = slot.before ? slot.index : slot.index + 1;
        if (dragHasQueueRow(e)) moveTo(readQueueIndex(e), insertAt);
        else dropSong(e, insertAt);
      }}
      className="rounded-xl bg-ink-hi/[0.04] px-1.5 pt-3 pb-1.5 animate-fade-in"
    >
      <div className="flex items-center justify-between gap-3 px-2 pb-1.5">
        <h3 className="text-[15px] font-bold text-ink-hi">{T("Next up")}</h3>
        <button
          onClick={() => useUI.getState().toggleQueue()}
          className="text-[12.5px] font-semibold text-ink-hi/65 hover:text-ink-hi transition-colors"
        >{T("Open queue")}</button>
      </div>
      {next.map((t, i) => {
        const at = index + 1 + i;
        return (
          <TrackRow
            key={`${at}:${t.id}`}
            track={t}
            queueIndex={at}
            available={available(t)}
            dropEdge={drop?.index === at ? (drop.before ? "before" : "after") : null}
            onPlay={() => playQueue(queue, at)}
          />
        );
      })}
    </section>
  );
}

const CLAMP_5 = { display: "-webkit-box", WebkitLineClamp: 5, WebkitBoxOrient: "vertical", overflow: "hidden" } as const;

/**
 * About the song: its tempo and key as the sound analysis measured them, and
 * from Genius (lib/songInfo.ts) when and on what it came out, its story —
 * five lines, the rest on "Show more" — its credits (written, produced, then
 * the detailed ones) and what it samples. The Genius button opens the song's
 * page, the source of all of that. Neither known, no card.
 */
function AboutSongCard({ track }: { track: Track }) {
  const songInfo = useSongInfo(track);
  const sound = useSound((s) => soundOf(track, s.facts));
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [track.id]);
  const info = songInfo && (songInfo.description || songInfo.credits.length || songInfo.released) ? songInfo : null;
  const tempo = sound?.bpm ? `${Math.round(sound.bpm)} BPM` : "";
  const key = sound ? keyName(sound.key, sound.minor) : "";
  if (!info && !tempo && !key) return null;

  const credits = !info ? [] : open ? info.credits : info.credits.slice(0, 4);
  const more = !!info && ((info.description?.length ?? 0) > 260 || info.credits.length > 4 || info.samples.length > 0 || !!info.recordedAt);
  return (
    <section aria-label={T("About the song")} className="rounded-xl bg-ink-hi/[0.04] p-3.5 animate-fade-in">
      <div className="flex items-center justify-between gap-3 min-h-[28px]">
        <h3 className="text-[15px] font-bold text-ink-hi">{T("About the song")}</h3>
        {info && (
          <button
            onClick={() => window.open(info.url, "_blank")}
            title={T("Open the song on Genius")}
            className="shrink-0 h-7 px-3 rounded-full border border-ink-hi/30 text-[12px] font-bold text-ink-hi hover:border-ink-hi/60 hover:bg-ink-hi/[0.06] transition-all active:scale-[0.98]"
          >{T("Genius")}</button>
        )}
      </div>
      {info && (info.released || info.album) && (
        <div className="text-[12.5px] text-ink-hi/55 mt-1 truncate">{[info.released, info.album].filter(Boolean).join(" · ")}</div>
      )}
      {(tempo || key) && (
        <dl className="mt-2.5 flex gap-7" title={T("Measured from the audio by the sound analysis")}>
          {tempo && (
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-hi/45">{T("Tempo")}</dt>
              <dd className="text-[13px] text-ink-hi/85 mt-0.5 tabular-nums">{tempo}</dd>
            </div>
          )}
          {key && (
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-hi/45">{T("Key")}</dt>
              <dd className="text-[13px] text-ink-hi/85 mt-0.5">{key}</dd>
            </div>
          )}
        </dl>
      )}
      {info?.description && (
        <p className="mt-2.5 text-[13px] leading-relaxed text-ink-hi/70 whitespace-pre-line" style={open ? undefined : CLAMP_5}>
          {info.description}
        </p>
      )}
      {info && (credits.length > 0 || (open && (info.samples.length > 0 || !!info.recordedAt))) && (
        <dl className="mt-3 space-y-2">
          {credits.map((c, i) => (
            <div key={`${c.label}-${i}`}>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-hi/45">{c.label}</dt>
              <dd className="text-[13px] text-ink-hi/85 mt-0.5">{c.names.join(", ")}</dd>
            </div>
          ))}
          {open && info.samples.length > 0 && (
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-hi/45">{T("Samples")}</dt>
              {info.samples.map((x, i) => (
                <dd key={i} className="text-[13px] text-ink-hi/85 mt-0.5">
                  {x.title}
                  {x.artist && <span className="text-ink-hi/55"> · {x.artist}</span>}
                </dd>
              ))}
            </div>
          )}
          {open && info.recordedAt && (
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-hi/45">{T("Recorded at")}</dt>
              <dd className="text-[13px] text-ink-hi/85 mt-0.5">{info.recordedAt}</dd>
            </div>
          )}
        </dl>
      )}
      {more && (
        <button onClick={() => setOpen(!open)} className="mt-2.5 text-[12.5px] font-semibold text-ink-hi/65 hover:text-ink-hi transition-colors">
          {open ? T("Show less") : T("Show more")}
        </button>
      )}
    </section>
  );
}

/**
 * About the artist, Spotify-panel style: photo header with the section label
 * over its top edge, the artist's name, the MusicBrainz facts line and the
 * Wikipedia lead. Everything comes from the open databases (artistAbout.ts);
 * the picture is the artist's own — the Wikimedia photo, else the one the
 * song's source carries, else Genius's photo or banner — never the song's
 * cover again; with none, the card goes without a picture. Clicking the
 * card opens the artist in the library; the Wikipedia button opens the
 * source article in the browser, which is also the credit the CC BY-SA
 * licence of the text asks for.
 */
function AboutArtistCard({ track }: { track: Track }) {
  const about = useArtistAbout(track);
  const navigate = useUI((s) => s.navigate);
  // Genius is asked only when the open databases have no photo.
  const genius = useArtistImages(about && !about.thumb ? leadArtist(track.artist) : "");
  const photo = about?.thumb ?? genius?.photo ?? genius?.banner ?? null;

  if (!about) return null;

  // The library artist page for the playing song's lead artist.
  const showInLibrary = (): void => {
    if (track.artistId?.startsWith("lib:artist:")) {
      navigate({ name: "artist", param: track.artistId });
      return;
    }
    useUI.getState().setSearchQuery(about.name);
    navigate({ name: "search" });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={showInLibrary}
      onKeyDown={(e) => {
        if (e.key === "Enter") showInLibrary();
      }}
      title={T("Show {name} in your library", { name: about.name })}
      aria-label={T("About the artist — show {name} in your library", { name: about.name })}
      className="group rounded-xl bg-ink-hi/[0.04] overflow-hidden text-left cursor-pointer hover:bg-ink-hi/[0.06] transition-colors animate-fade-in"
    >
      {/* Photo header with the label over its top edge, Spotify-style — a tall
          3:2 frame showing the whole artist shot, not a cropped strip. */}
      {photo ? (
        <div className="relative aspect-[3/2] bg-ink-hi/[0.06]">
          <img src={upgradeArtwork(photo)} alt="" className="w-full h-full object-cover object-top art-hairline" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/10 to-transparent" />
          <div className="absolute top-2.5 left-3.5 text-[15px] font-bold text-ink-hi">{T("About the artist")}</div>
        </div>
      ) : (
        <h3 className="px-3.5 pt-3.5 text-[15px] font-bold text-ink-hi">{T("About the artist")}</h3>
      )}

      <div className={photo ? "p-3.5 pt-3" : "p-3.5 pt-2"}>
        <div className="text-[15px] font-bold text-ink-hi truncate">{about.name}</div>
        {about.genres.length > 0 && (
          <div className="text-[12.5px] text-ink-hi/55 truncate mt-0.5">{about.genres.slice(0, 3).join(" · ")}</div>
        )}

        <div className="flex items-center justify-between gap-3 mt-2.5">
          <span className="text-[13px] text-ink-hi/70 truncate" title={about.facts ?? undefined}>
            {about.facts ?? T("Artist")}
          </span>
          {about.wikiUrl && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                // The main window's open handler sends web links to the system browser.
                window.open(about.wikiUrl as string, "_blank");
              }}
              className="shrink-0 h-8 px-4 rounded-full border border-ink-hi/30 text-[13px] font-bold text-ink-hi hover:border-ink-hi/60 hover:bg-ink-hi/[0.06] transition-all active:scale-[0.98]"
            >{T("Wikipedia")}</button>
          )}
        </div>

        {about.description && (
          <p
            className="mt-2.5 text-[13px] leading-relaxed text-ink-hi/70"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 5,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {about.description}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ root */

const RAIL_MIN = 280;
const RAIL_DEFAULT = 328;
/** At most this share of the window — the page in the middle keeps the rest. */
const RAIL_MAX_SHARE = 0.45;
const railClamp = (px: number): number => Math.round(Math.min(Math.max(px, RAIL_MIN), Math.max(RAIL_MIN, window.innerWidth * RAIL_MAX_SHARE)));

export function RightRail() {
  const mode = useUI((s) => s.rightPanel);
  const closeQueue = () => useUI.setState({ rightPanel: "details" });
  const saved = useSettings((s) => s.rightRailWidth);
  const setSaved = useSettings((s) => s.setRightRailWidth);
  // While dragging, the width follows the pointer here and is saved once, on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  // A smaller window lowers the cap: measure again when it changes.
  const [, remeasure] = useState(0);
  useEffect(() => {
    const onResize = (): void => remeasure((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const width = railClamp(dragWidth ?? saved);

  // A song dragged over the details turns the panel to the queue, so it can be dropped there.
  const springTimer = useRef<number | null>(null);
  const stopSpring = (): void => {
    if (springTimer.current !== null) window.clearTimeout(springTimer.current);
    springTimer.current = null;
  };
  useEffect(() => stopSpring, []);
  const springToQueue = (e: React.DragEvent): void => {
    // Over the details' "Next up" the song lands right there.
    if ((e.target as HTMLElement).closest?.("[data-next-up]")) return stopSpring();
    if (mode === "queue" || !dragHasTrack(e) || springTimer.current !== null) return;
    springTimer.current = window.setTimeout(() => {
      springTimer.current = null;
      useUI.setState({ rightPanel: "queue" });
    }, 450);
  };

  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* no capture (a pointer that is already gone): the moves still reach the grip */
    }
    const startX = e.clientX;
    const startWidth = width;
    let latest = startWidth;
    const move = (ev: PointerEvent): void => {
      // The panel sits on the right: pulling its left edge left makes it wider.
      latest = railClamp(startWidth + (startX - ev.clientX));
      setDragWidth(latest);
    };
    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setSaved(latest);
      setDragWidth(null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <aside
      style={{ width }}
      onDragOver={springToQueue}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) stopSpring();
      }}
      onDrop={stopSpring}
      className="relative shrink-0 flex flex-col glass-pill rounded-2xl"
      aria-label={T("Now playing panel")}
    >
      {/* The resize grip lives in the gap to the page; a double click goes back to the standard width. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={T("Resize the side panel")}
        aria-valuenow={width}
        aria-valuemin={RAIL_MIN}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => setSaved(RAIL_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            setSaved(railClamp(width + (e.key === "ArrowLeft" ? 16 : -16)));
          }
        }}
        title={T("Drag to resize · double-click for the standard width")}
        className="group/grip absolute -left-[7px] top-0 bottom-0 z-20 w-[8px] cursor-col-resize outline-none"
      >
        <span
          className={`absolute left-1/2 top-1/2 h-12 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
            dragWidth !== null ? "bg-ink-hi/50" : "bg-transparent group-hover/grip:bg-ink-hi/30 group-focus-visible/grip:bg-ink-hi/50"
          }`}
        />
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-[inherit]">
        {mode === "queue" ? <QueuePanel onClose={closeQueue} /> : mode === "devices" ? <DevicesPanel onClose={closeQueue} /> : <DetailsBody />}
      </div>
    </aside>
  );
}
