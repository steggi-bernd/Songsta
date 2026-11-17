/**
 * A local playlist page — BitChord mobile's DetailScreen, same construction
 * as the album and remote-playlist pages: full-bleed cover hero with the
 * "PLAYLIST • N TRACKS • ABOUT 3:2X" metadata line, circular glass controls,
 * then the playlist's own numbered track rows.
 */
import { useCallback } from "react";
import { AudioWaveform, FileDown, ListMusic, ListPlus } from "lucide-react";
import { exportM3uPlaylist } from "../lib/playlistFiles";
import { HERO_PILL, PlaylistHero } from "../components/PlaylistHero";
import { TrackList } from "../components/TrackList";
import { useCollectionPlayback } from "../components/LibraryCards";
import { EmptyState } from "../components/primitives";
import { playlistHeaderItems, playlistMenuItems } from "../lib/trackActions";
import type { TrackSource } from "../lib/dnd";
import { useListDates } from "../lib/listDates";
import { fmtMinutes, plural } from "../lib/format";
import { useArtworkPalette } from "../lib/palette";
import { useStillMissing } from "../lib/playlistRecovery";
import { upgradeArtwork } from "../lib/artwork";
import { readListSort } from "../lib/trackColumns";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { soundOf, useSound } from "../stores/sound";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { T } from "../lib/i18n";

/**
 * While the playlist plays (the queue is its songs): which song of how many, a thin band of how far
 * in, and how long it still runs.
 */
function ListProgress({ tracks }: { tracks: Track[] }) {
  const { active } = useCollectionPlayback(tracks, true);
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const position = usePlayer((s) => s.position);
  if (!active || index < 0 || !queue.length) return null;
  const current = queue[index]?.duration || 0;
  const before = queue.slice(0, index).reduce((n, t) => n + (t.duration || 0), 0);
  const after = queue.slice(index + 1).reduce((n, t) => n + (t.duration || 0), 0);
  const left = after + Math.max(0, current - position);
  const all = before + current + after;
  const share = all > 0 ? Math.min(1, (before + Math.min(position, current)) / all) : 0;
  return (
    <div className="flex items-center gap-3 mb-3 text-[12.5px] font-semibold text-accent tabular-nums" role="status">
      <span className="shrink-0">{T("Song {n} of {total}", { n: index + 1, total: queue.length })}</span>
      <span className="flex-1 h-[3px] rounded-full bg-ink-hi/[0.12] overflow-hidden">
        <span className="block h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="shrink-0">{T("{time} left", { time: fmtMinutes(left) })}</span>
    </div>
  );
}

const NO_TRACKS: Track[] = [];

export function PlaylistView({ playlistId }: { playlistId: string }) {
  const playlist = useLibrary((s) => s.playlists.find((p) => p.id === playlistId) ?? null);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const toast = useUI((s) => s.toast);
  const stillMissing = useStillMissing(playlistId);
  // When each song joined: seen here, or the day it was added on Spotify for a recovered list.
  const dates = useListDates(playlistId);
  const menuFor = useCallback((track: Track, from?: TrackSource) => (playlist ? playlistMenuItems(playlist, track, from) : []), [playlist]);

  // The picture chosen for it, else: artist-imported playlists wear the
  // artist's photo, not a song cover — the page tint and the hero read from
  // that same artwork.
  const coverThumb = playlist?.cover ?? playlist?.artistThumb ?? playlist?.tracks[0]?.thumb ?? null;
  useArtworkPalette(coverThumb);
  const { active, playing } = useCollectionPlayback(playlist?.tracks ?? NO_TRACKS);
  // "Sort flowing" orders the list (and so what plays) so each song leads into the next — for songs the analysis measured.
  // The raw saved order (a stable reference), read into a sort outside the selector: a fresh object from
  // the selector every time would re-render without end.
  const savedSort = useSettings((s) => s.listSorts?.[playlistId]);
  const sortNow = readListSort(savedSort);
  const measured = useSound((s) => (playlist?.tracks ?? NO_TRACKS).some((t) => (soundOf(t, s.facts)?.bpm ?? 0) > 0));

  // Dropping songs onto this page is handled panel-wide in App (usePanelDrop).

  if (!playlist) {
    return (
      <EmptyState
        icon={ListMusic}
        title={T("This playlist no longer exists")}
        body={T("It may have been deleted. Head back to your playlists to find the rest.")}
        className="pt-10"
      />
    );
  }

  const tracks = playlist.tracks;
  const totalSec = tracks.reduce((acc, t) => acc + t.duration, 0);
  // Spotify's model: a fresh playlist has no count — it only appears once there's something to count.
  const meta = [tracks.length ? plural(tracks.length, T("song"), T("songs")) : T("No songs yet"), totalSec > 0 ? fmtMinutes(totalSec) : ""].filter(Boolean).join(" · ");
  const flowing = sortNow?.key === "flow";
  // Four albums of its own make a mosaic where the playlist has no picture chosen (one cover each, as on its card).
  const mosaicCovers: string[] = [];
  const seenAlbums = new Set<string>();
  for (const t of tracks) {
    const album = (t.album || t.title).toLowerCase();
    if (!t.thumb || seenAlbums.has(album)) continue;
    seenAlbums.add(album);
    mosaicCovers.push(t.thumb);
    if (mosaicCovers.length === 4) break;
  }
  const mosaic = !playlist.cover && !playlist.artistThumb && mosaicCovers.length === 4;

  const play = (shuffle: boolean): void => {
    if (!tracks.length) return;
    if (shuffle) {
      usePlayer.setState({ shuffle: true });
      usePlayer.getState().playAll(tracks, true);
    } else {
      usePlayer.getState().playAll(tracks);
    }
  };

  const openHeaderMenu = (x: number, y: number): void => {
    const [renameItem, ...moreItems] = playlistHeaderItems(playlist);
    openContextMenu(x, y, [
      {
        label: T("Add all to queue"),
        icon: ListPlus,
        action: () => {
          usePlayer.getState().addToQueue(tracks);
          toast(T("Playlist added to queue"));
        },
      },
      ...(tracks.length
        ? [
            { label: T("Export as M3U…"), icon: FileDown, action: () => void exportM3uPlaylist(playlist.name, tracks) },
          ]
        : []),
      { ...renameItem, separatorBefore: true },
      ...moreItems,
    ]);
  };

  return (
    <div className="page-tint page-bleed -mt-5">
      <PlaylistHero
        art={
          coverThumb ? (
            <img src={upgradeArtwork(coverThumb)} alt="" className="w-full h-full object-cover" />
          ) : (
            /* Default cover — ByTune violet gradient with a big soft note
               watermark, Spotify's default-playlist-cover model. The hero's
               bottom fade still melts it into the page background. */
            <div
              className="relative w-full h-full overflow-hidden"
              style={{
                background:
                  "linear-gradient(140deg, rgb(109 40 217 / 0.85) 0%, rgb(59 7 100 / 0.9) 42%, rgb(30 27 75 / 0.92) 70%, rgb(var(--page-bg)) 100%)",
              }}
            >
              {/* sheen — keeps the violet from reading flat */}
              <div
                className="absolute inset-0"
                style={{
                  background:
                    "radial-gradient(ellipse 55% 45% at 18% 12%, rgb(255 255 255 / 0.14), transparent 70%)",
                }}
              />
              <ListMusic
                className="absolute -right-8 -bottom-10 w-[280px] h-[280px] text-white/[0.08] rotate-[-10deg]"
                aria-hidden
              />
            </div>
          )
        }
        cover={
          mosaic ? (
            <span className="grid grid-cols-2 w-full h-full">
              {mosaicCovers.map((c) => (
                <img key={c} src={upgradeArtwork(c)} alt="" className="w-full h-full object-cover" />
              ))}
            </span>
          ) : undefined
        }
        title={playlist.name}
        meta={meta}
        playing={playing}
        onShuffle={() => play(true)}
        onPlay={() => (active ? usePlayer.getState().toggle() : play(false))}
        onMore={openHeaderMenu}
        actions={
          measured && tracks.length > 2 ? (
            <button
              onClick={() => useSettings.getState().setListSort(playlist.id, flowing ? null : { key: "flow", desc: false })}
              aria-pressed={flowing}
              title={flowing ? T("Back to your own order") : T("Order the songs so each leads into the next: close in key and tempo, the energy rising and easing off")}
              className={`${HERO_PILL} ${flowing ? "bg-accent/25 text-accent border-accent/40" : "bg-black/30 text-white hover:bg-black/50"}`}
            >
              <AudioWaveform className="w-4 h-4" />
              {T("Sort flowing")}
            </button>
          ) : undefined
        }
      />

      <div className="page-pad pb-12 pt-2">
        {tracks.length > 0 && <ListProgress tracks={tracks} />}
        {stillMissing > 0 && (
          <div className="mb-3 flex items-center gap-3 rounded-xl bg-ink-hi/[0.05] px-4 py-2.5 text-[13px] text-ink-dim">
            <span className="min-w-0 flex-1">
              {T("Recovered from Spotify: {count} {value} not in your library yet. They join this playlist in their place as soon as they are.", { count: stillMissing, value: stillMissing === 1 ? T("song") : T("songs") })}
            </span>
            <button
              onClick={() => useUI.getState().navigate({ name: "spotify", param: `playlist:${playlist.id}` })}
              className="shrink-0 font-semibold text-ink-hi hover:underline"
            >{T("See which")}</button>
          </div>
        )}
        {tracks.length ? (
          <TrackList tracks={tracks} showAlbum sourceName={playlist.name} menuFor={menuFor} addedDates={dates} listKey={playlist.id} searchLabel={T("Search in this playlist")} />
        ) : (
          <EmptyState
            icon={ListMusic}
            title={T("Let's find something for your playlist")}
            body={T("Search for songs you love, or browse Explore to discover something new — then right-click any track to add it here.")}
            action={
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => {
                    useUI.getState().navigate({ name: "home" });
                    // The search field lives in the top bar; focus it once
                    // home has painted so typing starts immediately.
                    window.setTimeout(() => document.getElementById("global-search")?.focus(), 80);
                  }}
                  className="h-10 px-5 rounded-full bg-primary text-on-primary text-[13.5px] font-semibold hover:brightness-110 hover:shadow-[0_10px_36px_-10px_rgb(var(--primary)/0.55)] transition-all active:scale-[0.98]"
                >{T("Search for songs")}</button>
                <button
                  onClick={() => useUI.getState().navigate({ name: "explore" })}
                  className="h-10 px-5 rounded-full bg-panel border border-ink-hi/[0.09] text-[13.5px] font-semibold text-ink-hi hover:bg-ink-hi/[0.05] hover:border-ink-hi/[0.2] transition-all active:scale-[0.98]"
                >{T("Browse Explore")}</button>
                <button
                  onClick={() => useUI.getState().navigate({ name: "spotify", param: `playlist:${playlist.id}` })}
                  className="h-10 px-5 rounded-full bg-panel border border-ink-hi/[0.09] text-[13.5px] font-semibold text-ink-hi hover:bg-ink-hi/[0.05] hover:border-ink-hi/[0.2] transition-all active:scale-[0.98]"
                >{T("Recover a Spotify playlist")}</button>
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
