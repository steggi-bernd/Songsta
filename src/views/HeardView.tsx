/**
 * Everything you heard: the listening history as a page of its own, laid out like a playlist's. Two
 * tabs: History, every play, newest first and by day, with the covers (components/ListeningHistory.tsx);
 * Songs, the songs played last, each once, as a song list (Home shows what they were played from,
 * these are the single songs). Home's "Everything you heard" leads here; Replay keeps the history as
 * its last stop. Play and Shuffle take the tab's songs, each once, newest first; a history row plays
 * its song and goes on with what was heard before it.
 */
import { useMemo, useState } from "react";
import { Clock3, FileDown, ListPlus, Settings } from "lucide-react";
import type { Listen } from "../../electron/listens";
import { playCollection, useCollectionPlayback } from "../components/LibraryCards";
import { HistoryList, exportListeningHistory, useListeningHistory } from "../components/ListeningHistory";
import { PlaylistHero } from "../components/PlaylistHero";
import { TrackList } from "../components/TrackList";
import { Btn, EmptyState, Pills } from "../components/primitives";
import { upgradeArtwork } from "../lib/artwork";
import { plural } from "../lib/format";
import { T } from "../lib/i18n";
import { useArtworkPalette } from "../lib/palette";
import { trackAvailable } from "../stores/availability";
import { songKey, useCatalog } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

/** The songs of these plays that are still in the library, each once, in the order of the plays. */
function songsOf(listens: Listen[], byId: ReadonlyMap<string, Track>): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const l of listens) {
    const track = byId.get(l.id);
    if (!track) continue;
    const key = songKey(track.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

export function HeardView() {
  const { listens, more, total, loaded, shared, loadMore } = useListeningHistory();
  const byId = useCatalog((s) => s.byId);
  const recent = useLibrary((s) => s.history);
  const keeping = useSettings((s) => s.recordListening);
  const navigate = useUI((s) => s.navigate);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const toast = useUI((s) => s.toast);
  const [tab, setTab] = useState<"history" | "songs">("history");
  // The songs played last (the library keeps 200), as the catalogue has them now, each once.
  const recentSongs = useMemo(() => {
    const seen = new Set<string>();
    return recent
      .map((t) => byId.get(t.id) ?? t)
      .filter((t) => {
        const key = songKey(t.id);
        return !seen.has(key) && !!seen.add(key);
      });
  }, [recent, byId]);
  const heardSongs = useMemo(() => songsOf(listens, byId), [listens, byId]);
  const songs = tab === "songs" ? recentSongs : heardSongs;
  const { active, playing } = useCollectionPlayback(songs, true);
  // The newest song's cover stands behind the banner, as a playlist's does; four albums' covers make the square once
  // there are four (by album: two songs of one album can carry the same picture under different addresses).
  const covers = useMemo(() => {
    const byAlbum = new Map<string, string>();
    for (const t of songs) {
      const album = t.album ? `${t.album}|${t.albumArtist || t.artist}`.toLowerCase() : t.thumb;
      if (t.thumb && !byAlbum.has(album)) byAlbum.set(album, t.thumb);
      if (byAlbum.size === 4) break;
    }
    return [...byAlbum.values()];
  }, [songs]);
  const newestThumb = covers[0] ?? null;
  useArtworkPalette(newestThumb);

  const count = plural(total, T("listen"), T("listens"));
  const meta =
    tab === "songs"
      ? recentSongs.length
        ? plural(recentSongs.length, T("song"), T("songs"))
        : T("Nothing here yet")
      : !total
        ? T("Nothing here yet")
        : shared
          ? T("{count} · shared with your devices through your sync service", { count })
          : T("{count} · kept on this computer only", { count });

  // The song clicked, then what was heard before it: each song once, the ones that can't play right now left out.
  const playFrom = (_listen: Listen, at: number): void => {
    const queue = songsOf(listens.slice(at), byId).filter((t, i) => i === 0 || trackAvailable(t));
    if (queue.length) usePlayer.getState().playQueue(queue, 0);
  };

  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, [
      ...(songs.length
        ? [
            {
              label: T("Add all to queue"),
              icon: ListPlus,
              action: () => {
                usePlayer.getState().addToQueue(songs);
                toast(T("Songs added to queue"));
              },
            },
          ]
        : []),
      { label: T("Export as CSV…"), icon: FileDown, action: () => void exportListeningHistory(), separatorBefore: songs.length > 0 },
    ]);
  };

  return (
    <div className="page-tint page-bleed -mt-5">
      <PlaylistHero
        art={
          newestThumb ? (
            <img src={upgradeArtwork(newestThumb)} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="relative w-full h-full overflow-hidden" style={{ background: "linear-gradient(140deg, rgb(var(--accent) / 0.55) 0%, rgb(var(--accent) / 0.18) 55%, rgb(var(--page-bg)) 100%)" }}>
              <Clock3 className="absolute -right-8 -bottom-10 w-[280px] h-[280px] text-white/[0.08] rotate-[-10deg]" aria-hidden />
            </div>
          )
        }
        cover={
          covers.length >= 4 ? (
            <span className="grid grid-cols-2 w-full h-full">
              {covers.map((c) => (
                <img key={c} src={upgradeArtwork(c)} alt="" className="w-full h-full object-cover" />
              ))}
            </span>
          ) : undefined
        }
        eyebrow={T("Listening history")}
        title={T("Everything you heard")}
        meta={meta}
        playing={playing}
        onShuffle={() => songs.length && playCollection(songs, true)}
        onPlay={() => (active ? usePlayer.getState().toggle() : songs.length && playCollection(songs))}
        onMore={openMenu}
      />
      <div className="page-pad pb-12 pt-2">
        <div className="mb-4">
          <Pills
            options={[
              { key: "history", label: T("History") },
              { key: "songs", label: T("Songs") },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        {tab === "songs" ? (
          <TrackList
            tracks={recentSongs}
            showAlbum
            sourceName={T("Recently played")}
            emptyTitle={T("Nothing here yet")}
            emptyLabel={T("Songs you play show up here, newest first.")}
          />
        ) : listens.length > 0 ? (
          <HistoryList listens={listens} more={more} onMore={loadMore} covers onPlay={playFrom} />
        ) : loaded ? (
          <EmptyState
            icon={Clock3}
            title={T("Nothing here yet")}
            body={keeping ? T("Songs you play show up here, newest first.") : T("Your plays aren't kept right now. Turn on “Keep my plays” under Network & privacy, and what you play shows up here.")}
            action={
              keeping ? undefined : (
                <Btn variant="glass" icon={Settings} onClick={() => navigate({ name: "settings", param: "privacy" })}>{T("Network & privacy")}</Btn>
              )
            }
          />
        ) : null}
      </div>
    </div>
  );
}
