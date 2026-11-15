/**
 * Liked Songs: a page of its own, laid out like a playlist's, with nothing on it but the liked
 * songs. (It used to be one of three tabs on the library page, next to Playlists and Downloaded.)
 * Reached as the library route with `liked` (App), so the sidebar's row, "Playing from" and the
 * drop of songs onto the open page go on as before.
 */
import { FileDown, FileUp, Heart, ListPlus } from "lucide-react";
import { LikedCover } from "../components/LikedCover";
import { PlaylistHero } from "../components/PlaylistHero";
import { TrackList } from "../components/TrackList";
import { Btn, EmptyState } from "../components/primitives";
import { upgradeArtwork } from "../lib/artwork";
import { fmtTime, plural } from "../lib/format";
import { T } from "../lib/i18n";
import { useArtworkPalette } from "../lib/palette";
import { exportM3uPlaylist } from "../lib/playlistFiles";
import { useListDates } from "../lib/listDates";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";

export function LikedSongsView() {
  const liked = useLibrary((s) => s.liked);
  const navigate = useUI((s) => s.navigate);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const toast = useUI((s) => s.toast);
  const dates = useListDates("liked");
  // The newest like's album cover stands behind the banner, as a playlist's does; the page tint reads from it too.
  const newestThumb = liked[0]?.thumb ?? null;
  useArtworkPalette(newestThumb);

  const totalSec = liked.reduce((acc, t) => acc + (t.duration || 0), 0);
  const meta = [T("Playlist"), liked.length ? plural(liked.length, T("song"), T("songs")) : "", totalSec > 0 ? T("about {time}", { time: fmtTime(totalSec) }) : ""]
    .filter(Boolean)
    .join(" • ")
    .toUpperCase();

  const play = (shuffle: boolean): void => {
    if (!liked.length) return;
    if (shuffle) {
      usePlayer.setState({ shuffle: true });
      usePlayer.getState().playAll(liked, true);
    } else {
      usePlayer.getState().playAll(liked);
    }
  };

  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, [
      ...(liked.length
        ? [
            {
              label: T("Add all to queue"),
              icon: ListPlus,
              action: () => {
                usePlayer.getState().addToQueue(liked);
                toast(T("Liked Songs added to queue"));
              },
            },
            { label: T("Export as M3U…"), icon: FileDown, action: () => void exportM3uPlaylist(T("Liked Songs"), liked) },
          ]
        : []),
      { label: T("Import from Spotify"), icon: FileUp, action: () => navigate({ name: "spotify" }), separatorBefore: liked.length > 0 },
    ]);
  };

  return (
    <div className="page-tint page-bleed -mt-5">
      <PlaylistHero
        art={
          newestThumb ? (
            <img src={upgradeArtwork(newestThumb)} alt="" className="w-full h-full object-cover" />
          ) : (
            <LikedCover className="w-full h-full" heartClassName="w-28 h-28 opacity-30" />
          )
        }
        title={T("Liked Songs")}
        meta={meta}
        onShuffle={() => play(true)}
        onPlay={() => play(false)}
        onMore={openMenu}
      />
      <div className="page-pad pb-12 pt-2">
        {liked.length ? (
          <TrackList tracks={liked} showAlbum sourceName={T("Liked Songs")} emptyTitle={T("No liked songs yet")} addedDates={dates} listKey="liked" newestFirst searchLabel={T("Search in Liked Songs")} />
        ) : (
          <EmptyState
            icon={Heart}
            title={T("Songs you like will show up here")}
            body={T("Click the heart on any song — in the player, a playlist, or search — and it lands in this list. Or bring your Liked Songs over from Spotify.")}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Btn variant="white" icon={FileUp} onClick={() => navigate({ name: "spotify" })}>{T("Import from Spotify")}</Btn>
                <Btn variant="glass" onClick={() => navigate({ name: "search" })}>{T("Find something to like")}</Btn>
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
