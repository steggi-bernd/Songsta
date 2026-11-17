/**
 * Your Library — the full-page counterpart of the sidebar pill, Spotify-style.
 * Three pages under one route: the playlists (grouped into the same folders
 * as the sidebar, with Liked Songs, Downloads and Local Music as pinned
 * shortcut cards; unpin from the card menu or the sidebar row), Liked Songs
 * (views/LikedSongsView.tsx: nothing but the liked songs) and the downloads.
 * Listening history is deliberately absent — it lives in the queue panel's
 * "Recently played" tab, not in the library.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Download, Folder, ListMusic, Music2, Pin, Play, RotateCw, Shuffle, Trash2, Pencil } from "lucide-react";
import { TrackList } from "../components/TrackList";
import { Btn, EmptyState } from "../components/primitives";
import { LibraryFront, LibraryShelves } from "../components/LibraryFront";
import { MixGallery } from "../components/MixGallery";
import { LikedSongsView } from "./LikedSongsView";
import { CreateMenu } from "../components/CreateMenu";
import { downloadForOffline } from "../lib/downloads";
import { useLibrary, type DownloadStatus, type LibraryFolder, type Playlist } from "../stores/library";

/** The download list's order: what's coming in first, then what failed, then what's here. */
const DOWNLOAD_ORDER: Record<DownloadStatus, number> = { downloading: 0, queued: 1, failed: 2, done: 3, removed: 4 };
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { dragHasPlaylist, readPlaylist, useDrag } from "../lib/dnd";
import { playlistFolderItems, playlistHeaderItems } from "../lib/trackActions";
import { plural, fmtTime } from "../lib/format";
import { upgradeArtwork } from "../lib/artwork";
import type { Track } from "../types";
import { T } from "../lib/i18n";

type LibTab = "playlists" | "liked" | "downloaded";

/** Empty-cover fill for a playlist with no artwork yet. */
const COVER_FALLBACK = "from-panel to-surface";

function tabFromParam(param: string | undefined): LibTab {
  if (param === "liked") return "liked";
  if (param === "downloaded") return "downloaded";
  return "playlists";
}

/**
 * A playlist on the Your Library page: a collage of four of its albums' covers (or its own picture)
 * with its name over the foot. The card opens it; the pin and the round play button stand at its
 * corners and only light up, they never move over anything. The rest is in its menu (right-click).
 */
function LibraryPlaylistCard({ playlist }: { playlist: Playlist }) {
  const navigate = useUI((s) => s.navigate);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const togglePin = useLibrary((s) => s.togglePinPlaylist);
  // Local playlists drag into sidebar folders to file them there.
  const drag = useDrag({
    playlist: {
      id: playlist.id,
      title: playlist.name,
      thumb: playlist.cover ?? (playlist.tracks[0]?.thumb || undefined),
    },
  });
  const covers: string[] = [];
  const seen = new Set<string>();
  for (const t of playlist.tracks) {
    const album = (t.album || t.title).toLowerCase();
    if (!t.thumb || seen.has(album)) continue;
    seen.add(album);
    covers.push(t.thumb);
    if (covers.length === 4) break;
  }
  const seconds = playlist.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const line = [plural(playlist.tracks.length, T("song"), T("songs")), seconds > 0 ? fmtTime(seconds) : ""].filter(Boolean).join(" · ");

  return (
    <div
      {...drag.props}
      title={T("Drag onto a sidebar folder to file it there")}
      className={`group relative rounded-2xl overflow-hidden bg-[#141418] shadow-[0_18px_40px_-20px_rgba(0,0,0,0.8)] ${drag.dragging ? "opacity-40" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, [...playlistHeaderItems(playlist), ...playlistFolderItems(playlist)]);
      }}
    >
      <button onClick={() => navigate({ name: "playlist", param: playlist.id })} aria-label={playlist.name} className="block w-full text-left">
        <span className="block relative aspect-square">
          {playlist.cover || covers.length === 1 ? (
            <img src={playlist.cover ?? upgradeArtwork(covers[0])} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
          ) : covers.length > 1 ? (
            <span className="absolute inset-0 grid grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <img key={i} src={upgradeArtwork(covers[i % covers.length])} alt="" loading="lazy" className="w-full h-full object-cover" />
              ))}
            </span>
          ) : (
            <span className={`absolute inset-0 grid place-items-center bg-gradient-to-br ${COVER_FALLBACK}`}>
              <Music2 className="w-10 h-10 text-ink-hi/25" />
            </span>
          )}
          <span aria-hidden className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/90 transition-colors group-hover:to-black/80" />
          <span className="absolute left-3.5 right-16 bottom-3">
            <span className="block text-[22px] font-black tracking-[-0.03em] text-white truncate">{playlist.name}</span>
            <span className="block text-[12px] text-white/70 truncate">{line}</span>
          </span>
        </span>
      </button>
      <button
        onClick={() => togglePin(playlist.id)}
        title={playlist.pinned ? T("Unpin") : T("Pin to top")}
        aria-label={playlist.pinned ? T("Unpin playlist") : T("Pin playlist")}
        className={`absolute top-2 right-2 w-8 h-8 grid place-items-center rounded-full bg-black/45 transition-opacity ${
          playlist.pinned ? "text-accent opacity-100" : "text-white/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-white"
        }`}
      >
        <Pin className={`w-3.5 h-3.5 ${playlist.pinned ? "fill-current" : ""}`} />
      </button>
      {playlist.tracks.length > 0 && (
        <button
          onClick={() => usePlayer.getState().playAll(playlist.tracks)}
          title={T("Play playlist")}
          aria-label={T("Play {name}", { name: playlist.name })}
          className="absolute right-3 bottom-3 w-11 h-11 grid place-items-center rounded-full bg-accent text-[#0b0b0d] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:brightness-110"
        >
          <Play className="w-[18px] h-[18px] fill-current" />
        </button>
      )}
    </div>
  );
}

/** Collapsible folder group holding its playlists, like the sidebar's rows. */
function FolderSection({
  folder,
  playlists,
  expanded,
  onToggle,
}: {
  folder: LibraryFolder;
  playlists: Playlist[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const openContextMenu = useUI((s) => s.openContextMenu);
  const openDialog = useUI((s) => s.openDialog);
  const [dropHover, setDropHover] = useState(false);

  const onFolderDragOver = (e: React.DragEvent): void => {
    if (!dragHasPlaylist(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDropHover(true);
  };
  const onFolderDragLeave = (e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHover(false);
  };
  const onFolderDrop = (e: React.DragEvent): void => {
    if (!dragHasPlaylist(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropHover(false);
    const lib = useLibrary.getState();
    const pl = readPlaylist(e);
    if (!pl || !lib.playlists.some((p) => p.id === pl.id)) return;
    lib.setPlaylistFolder(pl.id, folder.id);
    useUI.getState().toast(T("Moved “{title}” into “{name}”", { title: pl.title, name: folder.name }), "success");
  };

  return (
    <section>
      <button
        onDragOver={onFolderDragOver}
        onDragLeave={onFolderDragLeave}
        onDrop={onFolderDrop}
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu(e.clientX, e.clientY, [
            {
              label: T("Rename folder"),
              icon: Pencil,
              action: () =>
                openDialog({
                  title: T("Rename folder"),
                  initialValue: folder.name,
                  placeholder: T("Folder name"),
                  confirmLabel: T("Save"),
                  onConfirm: (value) => useLibrary.getState().renameFolder(folder.id, value),
                }),
            },
            {
              label: T("Delete folder"),
              icon: Trash2,
              danger: true,
              action: () => useLibrary.getState().deleteFolder(folder.id),
            },
          ]);
        }}
        title={T("Right-click to rename or delete — or drop a playlist here to file it")}
        className={`group flex items-center gap-3 py-1 pr-3 rounded-lg text-left hover:bg-ink-hi/[0.04] transition-colors w-full ${
          dropHover ? "ring-2 ring-inset ring-accent/60 bg-ink-hi/[0.08]" : ""
        }`}
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-ink-hi/45 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-ink-hi/45 shrink-0" />
        )}
        <span className="w-10 h-10 rounded-md bg-ink-hi/[0.06] border border-ink-hi/[0.05] grid place-items-center shrink-0">
          <Folder className="w-5 h-5 text-ink-hi/55" />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold text-ink-hi truncate">{folder.name}</span>
          <span className="block text-[12.5px] text-ink-hi/55">
            {plural(playlists.length, T("playlist"), T("playlists"))}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="grid gap-[18px] grid-cols-[repeat(auto-fill,minmax(190px,1fr))] mt-3">
          {playlists.length ? (
            playlists.map((p) => <LibraryPlaylistCard key={p.id} playlist={p} />)
          ) : (
            <p className="text-[13px] text-ink-hi/45 py-2">{T("Empty folder — right-click a playlist in the sidebar and move it here.")}</p>
          )}
        </div>
      )}
    </section>
  );
}

export function LibraryView() {
  const view = useUI((s) => s.view);
  const navigate = useUI((s) => s.navigate);
  const playlists = useLibrary((s) => s.playlists);
  const folders = useLibrary((s) => s.folders);
  const downloads = useLibrary((s) => s.downloads);

  // Which of the three pages: the route says (the sidebar's Liked Songs row leads to `liked`).
  const tab = tabFromParam(view.param);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  // Dropping songs on the open Liked page is handled panel-wide in App.

  // The computer sends no notifications: the list says how each download stands — what's on its
  // way first, then what failed, then what's here.
  const downloadRows = Object.values(downloads).filter((d) => d.status !== "removed");
  const downloadedTracks: Track[] = downloadRows.filter((d) => d.status === "done").map((d) => d.track);
  const listedDownloads: Track[] = [...downloadRows].sort((a, b) => DOWNLOAD_ORDER[a.status] - DOWNLOAD_ORDER[b.status]).map((d) => d.track);
  const onItsWay = downloadRows.filter((d) => d.status === "downloading" || d.status === "queued").length;
  const failedDownloads = downloadRows.filter((d) => d.status === "failed").map((d) => d.track);
  const downloadStand = [
    onItsWay === 1 ? T("1 song downloading") : onItsWay ? T("Downloading {count}", { count: plural(onItsWay, T("song"), T("songs")) }) : "",
    failedDownloads.length ? T("{count} didn't download", { count: plural(failedDownloads.length, T("song"), T("songs")) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const unfiled = playlists.filter((p) => !p.folderId);
  const pinnedFirst = [...unfiled.filter((p) => p.pinned), ...unfiled.filter((p) => !p.pinned)];

  const shufflePlay = (tracks: Track[]): void => {
    if (!tracks.length) return;
    usePlayer.setState({ shuffle: true });
    usePlayer.getState().playAll(tracks, true);
  };

  // Liked Songs has a page to itself.
  if (tab === "liked") return <LikedSongsView />;

  return (
    <div className="pb-12">
      {tab === "playlists" && <LibraryFront downloaded={downloadedTracks.length} />}
      {/* What joined last and the genres come first, the playlists under them (the user's wish, 2026-11-16). */}
      {tab === "playlists" && <LibraryShelves />}
      {/* Header — the shared create dropdown (Playlist / Folder) */}
      <div className={tab === "playlists" ? "mt-10" : ""}>
        <div className="flex items-end justify-between gap-4 animate-slide-up">
          {tab === "downloaded" ? (
            <div>
              <div className="micro-label text-ink-faint mb-1.5">{T("Offline")}</div>
              <h1 className="font-display text-[28px] font-bold tracking-tight text-ink-hi">{T("Downloads")}</h1>
              <p className="text-sm text-ink-dim mt-1">{plural(downloadedTracks.length, T("song"), T("songs"))}</p>
            </div>
          ) : (
            <h2 className="text-[30px] font-black tracking-[-0.03em] text-ink-hi">{T("Your playlists")}</h2>
          )}
          {tab === "playlists" && <CreateMenu onFolderCreated={(f) => setExpandedFolders((prev) => new Set(prev).add(f.id))} />}
        </div>
      </div>

      {tab === "playlists" && (
        <div className="mt-6 space-y-7">
          {folders.length === 0 && unfiled.length === 0 ? (
            <EmptyState
              icon={ListMusic}
              title={T("No playlists yet")}
              body={T("Use the + button above to create a playlist or a folder — or right-click any track and choose \"New playlist…\" to start one from a song you like.")}
            />
          ) : (
            <>
              {folders.map((f) => (
                <FolderSection
                  key={f.id}
                  folder={f}
                  playlists={playlists.filter((p) => p.folderId === f.id)}
                  expanded={expandedFolders.has(f.id)}
                  onToggle={() =>
                    setExpandedFolders((prev) => {
                      const next = new Set(prev);
                      if (next.has(f.id)) next.delete(f.id);
                      else next.add(f.id);
                      return next;
                    })
                  }
                />
              ))}
              {unfiled.length > 0 && (
                <section>
                  {folders.length > 0 && (
                    <h2 className="text-[15px] font-semibold text-ink-hi mb-3">{T("Playlists")}</h2>
                  )}
                  <div className="grid gap-[18px] grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
                    {pinnedFirst.map((p) => (
                      <LibraryPlaylistCard key={p.id} playlist={p} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {/* The mixes stand at the foot of the page, as wide cards (the user's pick, 2026-11-16). */}
      {tab === "playlists" && <MixGallery />}

      {tab === "downloaded" && (
        <div className="mt-6">
          {listedDownloads.length ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {downloadedTracks.length > 0 && (
                  <>
                    <Btn variant="white" size="md" icon={Play} onClick={() => usePlayer.getState().playAll(downloadedTracks)}>{T("Play all")}</Btn>
                    <Btn variant="glass" size="md" icon={Shuffle} onClick={() => shufflePlay(downloadedTracks)}>{T("Shuffle")}</Btn>
                  </>
                )}
                {failedDownloads.length > 0 && (
                  <Btn variant="glass" size="md" icon={RotateCw} onClick={() => downloadForOffline(failedDownloads)}>{T("Try again")}</Btn>
                )}
                {downloadStand && <p className="ml-2 text-[13px] text-ink-dim">{downloadStand}</p>}
              </div>
              <div className="mt-5">
                <TrackList tracks={listedDownloads} showAlbum emptyTitle={T("Nothing downloaded yet")} />
              </div>
            </>
          ) : (
            <EmptyState
              icon={Download}
              title={T("No downloads yet")}
              body={T("Right-click any track and choose Download — it lands here for offline playback.")}
              action={
                <Btn variant="white" onClick={() => navigate({ name: "search" })}>{T("Find something to download")}</Btn>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
