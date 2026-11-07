import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ContextMenu } from "./components/ContextMenu";
import { Dialog } from "./components/primitives";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { prefetchLyrics, LyricsCenter } from "./components/LyricsCenter";
import { NowPlaying } from "./components/NowPlaying";
import { PageScrollbar } from "./components/PageScrollbar";
import { PlayerBar } from "./components/PlayerBar";
import { RightRail } from "./components/RightRail";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { engineBoot } from "./lib/audio";
import { setAmbientFromArtwork } from "./lib/ambient";
import { watchDiscordPresence } from "./lib/discordPresence";
import { watchHomeSync } from "./lib/homeSync";
import { watchMutedSongs } from "./lib/mutedSongs";
import { watchNewVersion } from "./lib/newVersionWatch";
import { watchDevicesLeaving } from "./lib/deviceSwitchOff";
import { watchKeptLists } from "./lib/keptListsWatch";
import { watchPlayAhead } from "./lib/playAhead";
import { watchServerSync } from "./lib/serverSync";
import { watchArchiveDrops } from "./lib/archiveImport";
import { volumeTarget } from "./lib/cast";
import { listenForDownloadProgress } from "./lib/downloads";
import { watchLibraryEnrichment } from "./lib/libraryEnrichment";
import { watchMenuCommands } from "./lib/menuCommands";
import { usePanelDrop } from "./lib/panelDrop";
import { useArtworkPalette } from "./lib/palette";
import { startPipSync } from "./pip/pipSync";
import { usePlayer } from "./stores/player";
import { useLibrary } from "./stores/library";
import { useSettings } from "./stores/settings";
import { useUI } from "./stores/ui";
import { SmartPlaylistEditorHost } from "./components/SmartPlaylistEditor";
import { watchCatalog } from "./stores/catalog";
import { watchAlbumCopies } from "./lib/albumCopies";
import { watchRecoveredPlaylists } from "./lib/playlistRecovery";
import { watchSound } from "./stores/sound";
import { watchRecentlyPlayed } from "./lib/recentlyPlayed";
import { watchAvailability } from "./stores/availability";
import { JellyfinView } from "./views/JellyfinView";
import { LibraryAlbumView } from "./views/LibraryAlbumView";
import { LooseSongsView } from "./views/LooseSongsView";
import { LibraryArtistView } from "./views/LibraryArtistView";
import { ArtistLikedView } from "./views/ArtistLikedView";
import { LibraryHomeView } from "./views/LibraryHomeView";
import { MixView } from "./views/MixView";
import { SmartPlaylistView } from "./views/SmartPlaylistView";
import { SubsonicView } from "./views/SubsonicView";
import { SpotifyImportView } from "./views/SpotifyImportView";
import { LibrarySearchView } from "./views/LibrarySearchView";
import { LibraryView } from "./views/LibraryView";
import { LocalMusicView } from "./views/LocalMusicView";
import { ExploreView } from "./views/ExploreView";
import { LibraryCheckView } from "./views/LibraryCheckView";
import { GenreView } from "./views/GenreView";
import { PlaylistView } from "./views/PlaylistView";
import { ReplayView } from "./views/ReplayView";
import { SetupPages } from "./components/SetupPages";
import { SettingsView } from "./views/SettingsView";

/**
 * The middle panel's artwork wash — the morphing gradient at the top of the
 * content pane, on every view except Settings and the pages whose header
 * carries its own full-bleed picture (a wash would show behind it and the
 * list under it). At rest it wears the playing track's
 * colour; hovering any song / album / artist / playlist card borrows that
 * artwork's colour instead (cards feed `tintThumb` via tintHoverHandlers).
 * The colour itself is the ArtworkPalette background. Two stacked washes
 * crossfade by opacity — composited on the GPU, so a colour change never
 * restyles or repaints the page under it (see `.home-tint` in index.css).
 */
function TintWash() {
  const viewName = useUI((s) => s.view.name);
  const tintThumb = useUI((s) => s.tintThumb);
  const playingThumb = usePlayer((s) => s.queue[s.index]?.thumb ?? null);
  const palette = useArtworkPalette(tintThumb ?? playingThumb);
  const color = `rgb(${palette.elevated})`;
  const [wash, setWash] = useState<{ colors: [string, string]; front: 0 | 1 }>({ colors: [color, color], front: 0 });

  // A new colour goes onto the hidden layer, which then fades in over the old one.
  useEffect(() => {
    setWash((w) => {
      if (w.colors[w.front] === color) return w;
      const back: 0 | 1 = w.front === 0 ? 1 : 0;
      const colors: [string, string] = [...w.colors];
      colors[back] = color;
      return { colors, front: back };
    });
  }, [color]);

  if (viewName === "artist" || viewName === "playlist" || viewName === "artistliked" || viewName === "settings") return null;
  return (
    <>
      {([0, 1] as const).map((i) => (
        <div
          key={i}
          aria-hidden
          className="home-tint pointer-events-none absolute inset-x-0 top-0 h-[332px]"
          style={{ "--home-tint": wash.colors[i], opacity: wash.front === i ? 1 : 0 } as CSSProperties}
        />
      ))}
    </>
  );
}

function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "f") {
          e.preventDefault();
          const el = document.getElementById("global-search") as HTMLInputElement | null;
          el?.focus();
          el?.select();
        } else if (e.key.toLowerCase() === "b" && !e.shiftKey && !e.altKey) {
          // Ctrl/Cmd+B folds the library panel, like an editor's side bar.
          e.preventDefault();
          const s = useSettings.getState();
          s.setSidebarCollapsed(!s.sidebarCollapsed);
        }
        return;
      }
      // Chrome: in plain fullscreen, Escape leaves it — even while a field is
      // focused. (NowPlaying's own Escape path below closes the cinematic
      // view, which takes the fullscreen with it.)
      // A modal dialog is the topmost layer and owns the keyboard (Escape /
      // Enter via its own capture listener); without this guard Space toggled
      // playback behind a confirm dialog, and preventDefault kept the
      // focused Confirm button dead.
      if (useUI.getState().dialog) return;
      if (e.key === "Escape") {
        const ui = useUI.getState();
        // A context menu is the topmost layer and owns Escape: its own
        // listener folds the submenu first, then dismisses the menu. Without
        // this guard the same keystroke also closed the queue/lyrics panels
        // underneath it.
        if (ui.contextMenu) return;
        if (ui.osFullscreen && !ui.nowPlayingOpen) {
          void window.bytune?.setFullScreen(false);
          return;
        }
      }
      if (typing) return;

      const ui = useUI.getState();
      if (e.key === "Escape") {
        if (ui.nowPlayingOpen) ui.toggleNowPlaying();
        else if (ui.rightPanel === "queue" || ui.lyricsCenter) ui.closePanels();
        return;
      }

      // Held keys: only the plain arrow ramps (seek/volume) may repeat.
      // Every other shortcut machine-guns on key repeat — Space strobes
      // play/pause, KeyN strobes the fullscreen view, Shift+arrows skip a
      // whole track per repeat event.
      const isPlainArrow =
        !e.shiftKey &&
        (e.code === "ArrowRight" || e.code === "ArrowLeft" || e.code === "ArrowUp" || e.code === "ArrowDown");
      if (e.repeat && !isPlainArrow) return;

      const player = usePlayer.getState();
      switch (e.code) {
        case "Space":
          e.preventDefault();
          player.toggle();
          break;
        case "ArrowRight":
          if (e.shiftKey) player.next(true);
          else player.seek(player.position + 5);
          break;
        case "ArrowLeft":
          if (e.shiftKey) player.prev();
          else player.seek(player.position - 5);
          break;
        case "ArrowUp": {
          e.preventDefault();
          const volume = volumeTarget();
          volume.setVolume(volume.value + 0.05);
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          const volume = volumeTarget();
          volume.setVolume(volume.value - 0.05);
          break;
        }
        case "KeyM":
          volumeTarget().toggleMute();
          break;
        case "KeyS":
          player.toggleShuffle();
          break;
        case "KeyR":
          player.cycleRepeat();
          break;
        case "KeyQ":
          ui.toggleQueue();
          break;
        case "KeyL":
          ui.toggleLyrics();
          break;
        case "KeyN":
          ui.toggleNowPlaying();
          break;
        case "Slash":
          e.preventDefault();
          document.getElementById("global-search")?.focus();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Artwork-driven ambience: recolors the app atmosphere per track. */
function useAmbient(): void {
  const current = usePlayer((s) => s.queue[s.index] ?? null);

  useEffect(() => {
    void setAmbientFromArtwork(current?.thumb ?? null);
  }, [current?.thumb]);

  // Warm the lyrics cache the moment a track starts, so the lyrics view
  // opens (or flips to the next song) with words already on screen.
  useEffect(() => {
    prefetchLyrics(current);
  }, [current?.id]);
}

/**
 * Applies the appearance settings that act on the whole shell: theme,
 * reduced motion / blur and the liquid-glass recipe land as classes on
 * <html>, so every surface honours them without each component reading the
 * setting itself.
 */
function useAppearance(): void {
  const reduceAnimation = useSettings((s) => s.reduceAnimation);
  const reduceDynamicBlur = useSettings((s) => s.reduceDynamicBlur);
  const liquidGlass = useSettings((s) => s.liquidGlass);
  const corners = useSettings((s) => s.corners);
  const accent = useSettings((s) => s.accent);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("reduce-motion", reduceAnimation);
    root.classList.toggle("reduce-blur", reduceDynamicBlur);
    root.classList.toggle("noglass", !liquidGlass);
    root.dataset.corners = corners;
    root.dataset.accent = accent;
  }, [reduceAnimation, reduceDynamicBlur, liquidGlass, corners, accent]);
}

/**
 * Local player routing: home, albums, artists, mixes and smart playlists are
 * built from the library itself. The streaming routes (explore, remote
 * playlists, downloads) are gone — a stale link to one lands on home.
 */
function CurrentView(): ReactNode {
  const view = useUI((s) => s.view);
  switch (view.name) {
    case "home":
      return <LibraryHomeView />;
    case "local":
      return <LocalMusicView />;
    case "explore":
      return <ExploreView />;
    case "check":
      return <LibraryCheckView />;
    case "loose":
      return <LooseSongsView />;
    case "genre":
      return <GenreView param={view.param ?? ""} />;
    case "album":
      return <LibraryAlbumView param={view.param ?? ""} />;
    case "artist":
      return <LibraryArtistView param={view.param ?? ""} />;
    case "artistliked":
      return <ArtistLikedView param={view.param ?? ""} />;
    case "mix":
      return <MixView param={view.param ?? ""} />;
    case "smart":
      return <SmartPlaylistView id={view.param ?? ""} />;
    case "subsonic":
      return <SubsonicView />;
    case "search":
      return <LibrarySearchView />;
    case "library":
    case "playlists":
      return <LibraryView />;
    case "playlist":
      return <PlaylistView playlistId={view.param ?? ""} />;
    case "jellyfin":
      return <JellyfinView />;
    case "replay":
      return <ReplayView />;
    case "spotify":
      return <SpotifyImportView key={view.param ?? "liked"} param={view.param} />;
    case "settings":
      return <SettingsView />;
    default:
      return <LibraryHomeView />;
  }
}

export default function App() {
  const viewName = useUI((s) => s.view.name);
  const viewReloadNonce = useUI((s) => s.viewReloadNonce);
  const pendingScroll = useUI((s) => s.pendingScroll);
  const lyricsCenter = useUI((s) => s.lyricsCenter);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const panelDrop = usePanelDrop();

  // Back/forward land the user at the scroll they left the view at. Runs as a
  // layout effect so the offset applies before the first paint of the restored
  // view — no jump. Static pages (Settings) restore exactly; pages that refetch
  // restore as far as their skeleton allows.
  useLayoutEffect(() => {
    if (pendingScroll === null) return;
    const el = document.getElementById("view-scroll");
    if (el) el.scrollTop = pendingScroll;
    useUI.getState().clearPendingScroll();
  }, [pendingScroll, viewName, viewReloadNonce]);

  useEffect(() => {
    const unsubscribe = listenForDownloadProgress();
    return unsubscribe;
  }, []);

  // Covers/albums filled in from the open databases arrive in batches.
  useEffect(() => watchLibraryEnrichment(), []);

  // The catalogue behind home, album/artist pages, mixes and smart playlists.
  useEffect(() => watchCatalog(), []);
  useEffect(() => watchAlbumCopies(), []);
  useEffect(() => watchRecoveredPlaylists(), []);

  // Which folders and servers can play right now (lists grey out the rest).
  useEffect(() => watchAvailability(), []);

  // The song playing now as the Discord status, when that is turned on.
  useEffect(() => watchDiscordPresence(), []);
  useEffect(() => watchServerSync(), []);
  useEffect(() => watchHomeSync(), []);
  useEffect(() => watchMutedSongs(), []);
  useEffect(() => watchArchiveDrops(), []);
  useEffect(() => watchNewVersion(), []);
  useEffect(() => watchDevicesLeaving(), []);
  useEffect(() => watchKeptLists(), []);
  useEffect(() => watchPlayAhead(), []);

  // The mouse's back and forward buttons walk the views like the top bar's arrows (back closes
  // the full-screen player first). They come as mouse buttons 3 and 4 and, on Windows, also as
  // app commands from main — one press is one step either way.
  useEffect(() => {
    let last = 0;
    const step = (dir: "back" | "forward"): void => {
      const now = Date.now();
      if (now - last < 400) return;
      last = now;
      const ui = useUI.getState();
      if (dir === "back" && ui.nowPlayingOpen) ui.toggleNowPlaying();
      else if (dir === "back") ui.goBack();
      else ui.goForward();
    };
    const onButton = (e: MouseEvent): void => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.type === "mouseup") step(e.button === 3 ? "back" : "forward");
    };
    window.addEventListener("mousedown", onButton, true);
    window.addEventListener("mouseup", onButton, true);
    const off = window.bytune?.onNavCommand(step);
    return () => {
      window.removeEventListener("mousedown", onButton, true);
      window.removeEventListener("mouseup", onButton, true);
      off?.();
    };
  }, []);

  // Tempo, key and energy from the sound analysis — measured in main, following its setting.
  useEffect(() => watchSound(), []);
  // When each album, playlist and Liked Songs last played — the library panel's order.
  useEffect(() => watchRecentlyPlayed(), []);
  const soundAnalysis = useSettings((s) => s.soundAnalysis);
  useEffect(() => {
    void window.bytune?.setSoundAnalysis(soundAnalysis);
  }, [soundAnalysis]);

  // Folder watching follows its setting (main watches by default).
  const watchFolders = useSettings((s) => s.watchFolders);
  useEffect(() => {
    void window.bytune?.setFolderWatch(watchFolders);
  }, [watchFolders]);

  // Native miniplayer bridge: push playback snapshots to the PiP window and
  // execute transport commands coming back from it.
  useEffect(() => startPipSync(), []);

  // macOS application menu: commands in (play/pause, navigation…), playback
  // state out (menu checkmarks). No-op off macOS.
  useEffect(() => watchMenuCommands(), []);

  // Maximize / restore settle: the OS zooms the window while the layout snaps
  // underneath, and the seam reads as a jarring reflow. A short settle on the
  // shell — replayed on every flip of the maximized state, however it was
  // asked for (title-bar double-click, caption button, snap) — masks the snap.
  // The class removes itself on animationend so no transform lingers over the
  // fixed overlays.
  useEffect(() => {
    const off = window.bytune?.onMaximizeChange(() => {
      const el = shellRef.current;
      if (!el || document.documentElement.classList.contains("reduce-motion")) return;
      el.classList.remove("win-settle");
      void el.offsetWidth; // restart the animation on rapid toggles
      el.classList.add("win-settle");
    });
    return off;
  }, []);

  // Plain OS fullscreen (F11, handled in main): mirror the window state so
  // Escape can leave it and the shell knows it is in fullscreen. If fullscreen
  // leaves while the cinematic view is up, close that view too — it only
  // lives inside fullscreen. (A self-driven NowPlaying exit flips the store
  // first, so the guard never re-triggers.)
  useEffect(() => {
    const off = window.bytune?.onFullScreenChange((fs) => {
      const ui = useUI.getState();
      ui.setOsFullscreen(fs);
      if (!fs && ui.nowPlayingOpen) ui.toggleNowPlaying();
    });
    return off;
  }, []);

  useEffect(() => {
    // Boot the audio engine only after persisted state has been rehydrated —
    // player (queue), settings (quality/speed/fades) and library (history)
    // alike, so the first load never reads a default over a saved value.
    const stores = [usePlayer.persist, useSettings.persist, useLibrary.persist];
    if (stores.every((p) => p.hasHydrated())) {
      engineBoot();
      return;
    }
    const unsubs = stores.map((p) =>
      p.onFinishHydration(() => {
        if (stores.every((x) => x.hasHydrated())) engineBoot();
      })
    );
    return () => unsubs.forEach((u) => u());
  }, []);

  useKeyboardShortcuts();
  useAmbient();
  useAppearance();

  return (
    <div
      ref={shellRef}
      onAnimationEnd={(e) => {
        if (e.animationName === "win-settle") e.currentTarget.classList.remove("win-settle");
      }}
      className="h-screen flex flex-col ambient-root text-ink overflow-hidden select-none origin-center"
    >
      <TopBar />
      {/* Three-pane shell: sidebar · content · right rail, over a black canvas.
          8px gaps and side padding; 4px strip above the play bar (Spotify). */}
      <div className="flex flex-1 min-h-0 gap-2 px-2 pb-1">
        <Sidebar />
        <main
          className="flex-1 min-w-0 flex flex-col bg-surface rounded-2xl overflow-hidden relative"
          {...panelDrop.props}
        >
          {/* Full-panel drop highlight — same design as the sidebar rows'
              hover, drawn over the whole surface while a song is over a
              page that accepts it (open playlist / liked / local folder). */}
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-0 z-30 rounded-2xl ring-2 ring-inset ring-accent/60 bg-ink-hi/[0.08] transition-opacity duration-150 ${
              panelDrop.hovering ? "opacity-100" : "opacity-0"
            }`}
          />
          <TintWash />
          {lyricsCenter ? (
            <LyricsCenter />
          ) : (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto scroll-host relative" id="view-scroll">
                <div>
                  {/* The reload nonce rides in the key: a bump remounts the current
                      view so its data effects re-run — that is the Refresh button's
                      mechanism everywhere except Home (which re-orchestrates its
                      feed without a remount). */}
                  <div key={`${viewReloadNonce}:${viewName}`} className="animate-rise-in page-pad pt-5 pb-6">
                    <ErrorBoundary>
                      <CurrentView />
                    </ErrorBoundary>
                  </div>
                </div>
              </div>
              <PageScrollbar scrollerId="view-scroll" />
              {/* Frosted band behind the search filter row. It spans the full
                  panel width (clipped by main's rounded corners) and reads
                  the list's scroll through the shared timeline hoisted by
                  timeline-scope on <main>. Tree order puts it above the
                  scrolling rows; the sticky pills (z-10 inside the scroller)
                  paint above it, so they stay sharp while the rows behind
                  them blur. */}
              {viewName === "search" && (
                <div aria-hidden className="search-band pointer-events-none absolute inset-x-0 top-0 h-16" />
              )}
            </>
          )}
        </main>
        <RightRail />
      </div>
      <PlayerBar />
      <NowPlaying />
      <SetupPages />
      <Dialog />
      <SmartPlaylistEditorHost />
      <ContextMenu />
      <Toasts />
    </div>
  );
}