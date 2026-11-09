/**
 * Your Library — the full-page counterpart of the sidebar pill, Spotify-style.
 * Chips: Playlists / Liked / Downloaded. Playlists group into the same folders
 * as the sidebar, with Liked Songs, Downloads and Local Music as pinned
 * shortcut cards (unpin from the card menu or the sidebar row).
 * Listening history is deliberately absent — it lives in the queue panel's
 * "Recently played" tab, not in the library.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Download, FileDown, FileUp, Folder, FolderOpen, Heart, ListMusic, Music2, Pin, PinOff, Play, RotateCw, Shuffle, Trash2, Pencil } from "lucide-react";
import { TrackList } from "../components/TrackList";
import { Btn, EmptyState, Pills, PlayOverlay } from "../components/primitives";
import { CreateMenu } from "../components/CreateMenu";
import { downloadForOffline } from "../lib/downloads";
import { useLibrary, type DownloadStatus, type LibraryFolder, type Playlist } from "../stores/library";

/** The download list's order: what's coming in first, then what failed, then what's here. */
const DOWNLOAD_ORDER: Record<DownloadStatus, number> = { downloading: 0, queued: 1, failed: 2, done: 3, removed: 4 };
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { dragHasPlaylist, readPlaylist, useDrag } from "../lib/dnd";
import { playlistFolderItems, playlistHeaderItems } from "../lib/trackActions";
import { plural } from "../lib/format";
import { upgradeArtwork } from "../lib/artwork";
import { exportM3uPlaylist } from "../lib/playlistFiles";
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

function LibraryPlaylistCard({ playlist }: { playlist: Playlist }) {
  const navigate = useUI((s) => s.navigate);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const openDialog = useUI((s) => s.openDialog);
  const deletePlaylist = useLibrary((s) => s.deletePlaylist);
  const togglePin = useLibrary((s) => s.togglePinPlaylist);
  const toast = useUI((s) => s.toast);
  // Local playlists drag into sidebar folders to file them there.
  const drag = useDrag({
    playlist: {
      id: playlist.id,
      title: playlist.name,
      thumb: playlist.cover ?? (playlist.tracks[0]?.thumb || undefined),
    },
  });

  return (
    <div
      {...drag.props}
      title={T("Drag onto a sidebar folder to file it there")}
      className={`group relative w-44 text-left ${drag.dragging ? "opacity-40" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, [
          ...playlistHeaderItems(playlist),
          ...playlistFolderItems(playlist),
        ]);
      }}
    >
      <div className="rounded-xl bg-ink-hi/[0.03] p-3 card-lift duration-200 group-hover:bg-ink-hi/[0.07]">
        <button
          onClick={(e) => {
            e.stopPropagation();
            togglePin(playlist.id);
          }}
          title={playlist.pinned ? T("Unpin") : T("Pin to top")}
          aria-label={playlist.pinned ? T("Unpin playlist") : T("Pin playlist")}
          className={`absolute top-1 right-1 z-10 p-1.5 rounded-md transition-opacity ${
            playlist.pinned
              ? "text-accent opacity-100"
              : "text-ink-hi/60 opacity-0 group-hover:opacity-100 hover:text-ink-hi"
          }`}
        >
          <Pin className={`w-3.5 h-3.5 ${playlist.pinned ? "fill-current" : ""}`} />
        </button>
        <div
          role="button"
          tabIndex={0}
          onClick={() => navigate({ name: "playlist", param: playlist.id })}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate({ name: "playlist", param: playlist.id });
          }}
          title={playlist.name}
          className={`relative w-full aspect-square rounded-lg bg-gradient-to-br ${COVER_FALLBACK} border border-ink-hi/[0.05] overflow-hidden cursor-pointer`}
        >
          {playlist.cover ? (
            <img src={playlist.cover} alt="" className="absolute inset-0 w-full h-full object-cover p-1.5 rounded-lg bg-ink-hi/[0.04]" />
          ) : playlist.tracks.length > 0 ? (
            playlist.tracks.length === 1 ? (
              <img
                src={upgradeArtwork(playlist.tracks[0].thumb)}
                alt=""
                loading="lazy"
                decoding="async"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                className="absolute inset-0 w-full h-full object-cover p-1.5 rounded-lg bg-ink-hi/[0.04]"
              />
            ) : (
              <div className="grid grid-cols-2 gap-px w-full h-full p-1.5 rounded-lg overflow-hidden">
                {playlist.tracks.slice(0, 4).map((t) => (
                  <img
                    key={t.id}
                    src={upgradeArtwork(t.thumb)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
                    className="w-full h-full object-cover rounded-sm bg-ink-hi/[0.04]"
                  />
                ))}
              </div>
            )
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <Music2 className="w-8 h-8 text-ink-hi/25" />
            </div>
          )}
          <span className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-colors" aria-hidden />
          <PlayOverlay
            title={T("Play playlist")}
            onClick={() => {
              if (!playlist.tracks.length) {
                navigate({ name: "playlist", param: playlist.id });
                return;
              }
              usePlayer.getState().playAll(playlist.tracks);
            }}
          />
        </div>

        <div className="mt-3 flex items-start justify-between gap-1">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink truncate">{playlist.name}</div>
            <div className="text-[13px] text-ink-faint mt-0.5">{plural(playlist.tracks.length, T("song"), T("songs"))}</div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openDialog({
                title: T("Delete \"{name}\"?", { name: playlist.name }),
                body: T("This can't be undone. The tracks themselves aren't affected."),
                confirmLabel: T("Delete"),
                danger: true,
                onConfirm: () => {
                  deletePlaylist(playlist.id);
                  toast(T("Playlist deleted"), "info");
                },
              });
            }}
            title={T("Delete playlist")}
            aria-label={T("Delete {name}", { name: playlist.name })}
            className="p-1.5 rounded-md text-ink-ghost hover:text-red-400 hover:bg-ink-hi/10 opacity-0 group-hover:opacity-100 transition-all shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
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
        <div className="flex flex-wrap gap-5 mt-3">
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

/** Pinned shortcut tile (Liked / Downloads / Local) with a pin toggle. */
function ShortcutTile({
  title,
  subtitle,
  pinned,
  onTogglePin,
  onOpen,
  artClassName,
  art,
}: {
  title: string;
  subtitle: string;
  pinned: boolean;
  onTogglePin: () => void;
  onOpen: () => void;
  artClassName: string;
  art: ReactNode;
}) {
  const openContextMenu = useUI((s) => s.openContextMenu);
  return (
    <div
      className="group relative w-44 text-left"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, [
          {
            label: pinned ? T("Unpin") : T("Pin to top"),
            icon: pinned ? PinOff : Pin,
            action: onTogglePin,
          },
        ]);
      }}
    >
      <div className="rounded-xl bg-ink-hi/[0.03] p-3 card-lift duration-200 group-hover:bg-ink-hi/[0.07]">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          title={pinned ? T("Unpin") : T("Pin to top")}
          aria-label={pinned ? T("Unpin {title}", { title }) : T("Pin {title}", { title })}
          className={`absolute top-1 right-1 z-10 p-1.5 rounded-md transition-opacity ${
            pinned
              ? "text-accent opacity-100"
              : "text-ink-hi/60 opacity-0 group-hover:opacity-100 hover:text-ink-hi"
          }`}
        >
          <Pin className={`w-3.5 h-3.5 ${pinned ? "fill-current" : ""}`} />
        </button>
        <button onClick={onOpen} className="block w-full text-left">
          <div
            className={`relative w-full aspect-square rounded-lg bg-gradient-to-br border border-ink-hi/[0.05] grid place-items-center overflow-hidden ${artClassName}`}
          >
            {art}
          </div>
          <div className="mt-3">
            <div className="text-sm font-medium text-ink truncate">{title}</div>
            <div className="text-[13px] text-ink-faint mt-0.5">{subtitle}</div>
          </div>
        </button>
      </div>
    </div>
  );
}

export function LibraryView() {
  const view = useUI((s) => s.view);
  const navigate = useUI((s) => s.navigate);
  const liked = useLibrary((s) => s.liked);
  const playlists = useLibrary((s) => s.playlists);
  const folders = useLibrary((s) => s.folders);
  const downloads = useLibrary((s) => s.downloads);
  const pinnedSingles = useLibrary((s) => s.pinnedSingles);
  const togglePinSingle = useLibrary((s) => s.togglePinSingle);

  const [tab, setTab] = useState<LibTab>(() => tabFromParam(useUI.getState().view.param));
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  // Dropping songs on the open Liked page is handled panel-wide in App.

  // The sidebar deep-links here (Liked Songs → ?liked); keep the chip in sync
  // when the view changes while this component stays mounted.
  useEffect(() => {
    setTab(tabFromParam(view.param));
  }, [view.name, view.param]);

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

  return (
    <div className="pb-12">
      {/* Header — counts + the shared create dropdown (Playlist / Folder) */}
      <div>
        <div className="flex items-end justify-between gap-4 animate-slide-up">
          <div>
            <div className="micro-label text-ink-faint mb-1.5">{T("Collection")}</div>
            <h1 className="font-display text-[28px] font-bold tracking-tight text-ink-hi">{T("Your Library")}</h1>
            <p className="text-sm text-ink-dim mt-1">
              {plural(playlists.length, T("playlist"), T("playlists"))} ·{" "}
              {plural(folders.length, T("folder"), T("folders"))} ·{" "}
              {plural(liked.length, T("liked song"), T("liked songs"))}
            </p>
          </div>
          <CreateMenu onFolderCreated={(f) => setExpandedFolders((prev) => new Set(prev).add(f.id))} />
        </div>

        <div className="mt-5">
          <Pills
            options={[
              { key: "playlists" as const, label: T("Playlists"), count: playlists.length },
              { key: "liked" as const, label: T("Liked"), count: liked.length },
              { key: "downloaded" as const, label: T("Downloaded"), count: downloadedTracks.length },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </div>

      {tab === "playlists" && (
        <div className="mt-6 space-y-7">
          {/* Shortcut tiles — Liked Songs, Downloads + Local Music, pinned by default */}
          <div className="flex flex-wrap gap-5">
            {(
              [
                { key: "liked" as const, pinned: pinnedSingles?.liked ?? true },
                { key: "downloads" as const, pinned: pinnedSingles?.downloads ?? true },
                { key: "local" as const, pinned: pinnedSingles?.local ?? true },
              ]
                .sort((a, b) => Number(b.pinned) - Number(a.pinned))
                .map(({ key, pinned }) => {
                  if (key === "liked") {
                    return (
                      <ShortcutTile
                        key="liked"
                        title={T("Liked Songs")}
                        subtitle={plural(liked.length, T("song"), T("songs"))}
                        pinned={pinned}
                        onTogglePin={() => togglePinSingle("liked")}
                        onOpen={() => setTab("liked")}
                        artClassName="from-accent to-accent/25 bg-[#141418]"
                        art={<Heart className="w-9 h-9 fill-white text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.35)]" />}
                      />
                    );
                  }
                  if (key === "downloads") {
                    return (
                      <ShortcutTile
                        key="downloads"
                        title={T("Downloads")}
                        subtitle={plural(downloadedTracks.length, T("song"), T("songs"))}
                        pinned={pinned}
                        onTogglePin={() => togglePinSingle("downloads")}
                        onOpen={() => setTab("downloaded")}
                        artClassName="from-emerald-400/25 to-emerald-400/[0.05]"
                        art={
                          <Download
                            className={`w-9 h-9 ${downloadedTracks.length ? "text-emerald-300" : "text-ink-hi/55"}`}
                          />
                        }
                      />
                    );
                  }
                  return (
                    <ShortcutTile
                      key="local"
                      title={T("Local Music")}
                      subtitle={T("On this device")}
                      pinned={pinned}
                      onTogglePin={() => togglePinSingle("local")}
                      onOpen={() => navigate({ name: "local" })}
                      artClassName="from-white/[0.07] to-white/[0.02]"
                      art={<FolderOpen className="w-9 h-9 text-ink-hi/55" />}
                    />
                  );
                })
            )}
          </div>

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
                  <div className="flex flex-wrap gap-5">
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

      {tab === "liked" && (
        <div className="mt-6">
          {liked.length ? (
            <>
              <div className="flex items-center gap-2">
                <Btn variant="white" size="md" icon={Play} onClick={() => usePlayer.getState().playAll(liked)}>{T("Play all")}</Btn>
                <Btn variant="glass" size="md" icon={Shuffle} onClick={() => shufflePlay(liked)}>{T("Shuffle")}</Btn>
                <Btn variant="glass" size="md" icon={FileUp} onClick={() => navigate({ name: "spotify" })} className="ml-auto">{T("Import from Spotify")}</Btn>
                <Btn variant="glass" size="md" icon={FileDown} onClick={() => void exportM3uPlaylist(T("Liked Songs"), liked)}>{T("Export M3U")}</Btn>
              </div>
              <div className="mt-5">
                <TrackList tracks={liked} showAlbum sourceName={T("Liked Songs")} emptyTitle={T("No liked songs yet")} />
              </div>
            </>
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
      )}

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
