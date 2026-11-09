/** Songsta desktop — Electron main process. */
// First of all: the data folder moves before anything else opens a file in it.
import "./rename-data";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, protocol, session, shell } from "electron";
import type { NativeImage } from "electron";
import { fileURLToPath, pathToFileURL } from "url";
import * as m3u from "./m3u";
import * as fs from "fs";
import * as path from "path";
import * as downloads from "./downloads";
import * as autoeq from "./autoeq";
import * as canvas from "./canvas";
import * as discord from "./discord";
import { enrichLocalLibrary } from "./enrich";
import * as folderWatch from "./folder-watch";
import * as archive from "./archive-import";
import * as cast from "./cast";
import { samePath } from "./local-paths";
import * as homeSync from "./home-sync";
import * as jellyfin from "./jellyfin";
import * as subsonic from "./subsonic";
import { indexLibraryLyrics, libraryLyrics, type LyricsRequest } from "./library-lyrics";
import { saveLyricsIndexSync, searchLyrics } from "./lyrics-index";
import { analyseLibrarySound, configureSoundAnalysis, saveSoundIndexSync, setSoundAnalysisEnabled, soundFacts, soundStatus } from "./sound-library";
import * as meta from "./metadata";
import * as songInfo from "./song-info";
import * as listens from "./listens";
import { configureAppUpdate, installUpdate, latestKnown, startUpdate, updateState } from "./app-update";
import { addFirewallRule, firewallMatters, hasFirewallRule } from "./firewall";
import { backupExport, backupImport } from "./backup";
import * as locallib from "./local-library";
import * as persist from "./persist";
import * as pip from "./pip";
import * as stats from "./stats";
import { proxyUrlForJellyfin, proxyUrlForLocalTrack, proxyUrlForSubsonic, startStreamProxy } from "./stream-proxy";
import * as transcode from "./transcode";
import * as transition from "./data-transition";
import { buildAppMenu, type MenuCommand, type MenuPlaybackState, type MenuWiring } from "./mac-menu";
import * as startup from "./startup";
import type { Track } from "../src/types";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const isMac = process.platform === "darwin";

// Covers extracted from local files are served to the renderer over this
// scheme; registered privileged so <img> can use it everywhere.
protocol.registerSchemesAsPrivileged([
  { scheme: "localart", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Jellyfin covers: fetched (and disk-cached) by the main process, which
  // holds the server token — see jellyfin.ts.
  { scheme: "jfart", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Navidrome/Subsonic covers, same arrangement — see subsonic.ts.
  { scheme: "ssart", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// What a library throws asynchronously is logged; the app stays alive.
process.on("uncaughtException", (err) => {
  console.error("[bytune] uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[bytune] unhandled rejection:", reason);
});

let mainWindow: BrowserWindow | null = null;
/**
 * macOS: closing the main window hides it and keeps the app (and playback)
 * running — the close button is not a quit. This flag marks a REAL quit so
 * the hide-on-close guard stands down.
 */
let quitting = false;
/** before-quit can fire twice (window close → quit); the drain must run once. */
let drainStarted = false;
/**
 * Set for the whole app:resetData span. The renderer keeps playing until its
 * reload lands, so listening events arriving in that window belong to the
 * pre-reset session — recording them would re-arm stats flushes that
 * re-create the buckets the reset just deleted (and quit would persist them).
 */
let dataResetActive = false;

function iconPath(): string | undefined {
  // Windows: give the window the multi-size .ico so the shell can pick
  // exact-size bitmaps for the taskbar button and preview thumbnails instead
  // of scaling a single raster. macOS keeps the .png (Dock setIcon).
  const name = process.platform === "win32" ? "icon.ico" : "icon.png";
  const p = path.join(app.getAppPath(), "build", name);
  return fs.existsSync(p) ? p : undefined;
}

/* ------------------------- macOS application menu ------------------------- */

/** Last playback state the renderer pushed; drives the menu checkmarks. */
let menuState: MenuPlaybackState = { playing: false, shuffle: false, repeat: "off" };

function menuWiring(): MenuWiring {
  return {
    sendCommand: (command): void => {
      // The main window may be hidden (macOS close-to-hide) but its renderer
      // stays alive — hidden-window commands keep working, which is the point.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("menu:command", command);
      }
    },
    backupExport: (): void => {
      void backupExport(mainWindow).catch((err) =>
        console.warn("[bytune] menu backup export failed:", err instanceof Error ? err.message : err)
      );
    },
    backupImport: (): void => {
      void backupImport(mainWindow).catch((err) =>
        console.warn("[bytune] menu backup import failed:", err instanceof Error ? err.message : err)
      );
    },
    showMainWindow: (): void => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
  };
}

/** (Re)build the macOS app menu from the current playback state. */
function applyMenu(): void {
  if (!isMac) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenu(menuState, menuWiring(), isDev)));
}

/* ------------------------ Windows taskbar thumbbar ------------------------ */

/**
 * Transport buttons on the taskbar preview (hover the taskbar icon):
 * previous · play/pause · next — the surface Spotify shows. Windows only
 * (setThumbarButtons wraps win32 ITaskbarList3; macOS has no taskbar). The
 * play/pause glyph follows the renderer's pushed playback state — the same
 * menu:push-state signal that drives the macOS menu checkmarks — so one
 * renderer push keeps both native surfaces truthful.
 */
const thumbarIcons = new Map<string, NativeImage>();
/** The glyphs' colour on a light taskbar, where white would vanish. */
const GLYPH_ON_LIGHT = 0x20;

function lightTaskbar(): boolean {
  try {
    return !nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  } catch {
    return false;
  }
}

function thumbarIcon(name: "previous" | "play" | "pause" | "next"): NativeImage {
  const light = lightTaskbar();
  const key = light ? `${name}-on-light` : name;
  let img = thumbarIcons.get(key);
  if (!img) {
    // 1x (16px) + 2x (32px) representations: high-DPI taskbars pick the
    // sharp copy instead of upscaling a blurry 16px bitmap.
    img = nativeImage.createEmpty();
    for (const [scale, file] of [
      [1, `${name}-16.png`],
      [2, `${name}-32.png`],
    ] as const) {
      const p = path.join(__dirname, "assets", "thumbar", file);
      if (!fs.existsSync(p)) continue;
      if (!light) {
        img.addRepresentation({ scaleFactor: scale, buffer: fs.readFileSync(p) });
        continue;
      }
      // The same glyph, dark: its alpha kept, its colour changed (premultiplied pixels).
      const glyph = nativeImage.createFromBuffer(fs.readFileSync(p));
      const { width, height } = glyph.getSize();
      const pixels = glyph.toBitmap();
      for (let i = 0; i < pixels.length; i += 4) {
        const shade = Math.round((GLYPH_ON_LIGHT * pixels[i + 3]) / 255);
        pixels[i] = shade;
        pixels[i + 1] = shade;
        pixels[i + 2] = shade;
      }
      img.addRepresentation({ scaleFactor: scale, width, height, buffer: pixels });
    }
    thumbarIcons.set(key, img);
  }
  return img;
}

let thumbarThemeWatched = false;

/** Returns true when the taskbar accepted the buttons (false = too early). */
function applyThumbar(): boolean {
  if (process.platform !== "win32") return true;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const command = (c: MenuCommand) => (): void => menuWiring().sendCommand(c);
  return mainWindow.setThumbarButtons([
    { icon: thumbarIcon("previous"), tooltip: "Previous", click: command("previous") },
    {
      icon: thumbarIcon(menuState.playing ? "pause" : "play"),
      tooltip: menuState.playing ? "Pause" : "Play",
      click: command("play-pause"),
    },
    { icon: thumbarIcon("next"), tooltip: "Next", click: command("next") },
  ]);
}

/**
 * Home or away (jellyfin.ts checkReach): which of the server's addresses answers, looked at now and
 * then and after a sleep, with the page told when that changes. A laptop taken out of the house goes
 * on through the tunnel or proxy, and comes back to the direct way at home.
 */
const REACH_EVERY_MS = 30_000;
function watchServerReach(): void {
  const look = async (): Promise<void> => {
    if (await jellyfin.checkReach().catch(() => false)) mainWindow?.webContents.send("jellyfin:reach", jellyfin.status());
  };
  setTimeout(() => void look(), 3000);
  setInterval(() => void look(), REACH_EVERY_MS);
  powerMonitor.on("resume", () => void look());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: "#0a0a0a",
    title: "Songsta",
    show: false,
    autoHideMenuBar: true,
    // Frameless look, native behaviour. Windows: the renderer's top bar is a
    // drag surface (move + double-click-maximize) while Windows draws its own
    // caption buttons top-right — so the snap-layout flyout still works.
    // macOS: hiddenInset keeps the native traffic lights (top-left, inset
    // below the app menu bar) and the renderer leaves room for them instead
    // of drawing its own buttons.
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac ? { trafficLightPosition: { x: 20, y: 28 }, zoomToPageWidth: true } : {}),
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // macOS close-to-hide: the window can stay hidden for hours while
      // music plays. Chromium throttles hidden-window timers (fade curves,
      // stats accumulation, lyric sync all run on JS timers), so the main
      // window must keep full timer resolution. Windows destroys its window
      // on close, so its behaviour is unchanged.
      backgroundThrottling: isMac ? false : undefined,
    },
  });

  mainWindow.once("ready-to-show", () => {
    // Windows opens maximized by default; macOS keeps a normal-sized window
    // (Spotify's convention) — the user's own zoom is remembered by the OS.
    if (!isMac && !mainWindow?.isMaximized()) mainWindow?.maximize();
    mainWindow?.show();
  });

  // Windows taskbar thumbbar: the toolbar can only attach once the window
  // owns a taskbar button, i.e. after the first show. If Windows still
  // refuses (shell timing), retry once — every later play/pause re-applies
  // the bar anyway via menu:push-state.
  if (process.platform === "win32") {
    const attach = (triesLeft: number): void => {
      const ok = applyThumbar();
      if (isDev) console.log("[bytune] taskbar thumbbar:", ok ? "attached" : "deferred");
      if (!ok && triesLeft > 0) setTimeout(() => attach(triesLeft - 1), 1500);
    };
    mainWindow.once("show", () => attach(5));
    // Again whenever the window comes back: without a play or pause nothing else would, and
    // Windows forgets the buttons of a window it rebuilt its taskbar for.
    mainWindow.on("show", () => void applyThumbar());
    mainWindow.on("restore", () => void applyThumbar());
    mainWindow.on("focus", () => void applyThumbar());
    if (!thumbarThemeWatched) {
      thumbarThemeWatched = true;
      nativeTheme.on("updated", () => void applyThumbar());
    }
  }

  // Keep the renderer's maximize/restore button icon in sync.
  const sendMaximized = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window:maximized", mainWindow.isMaximized());
    }
  };
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);

  // Keyboard shortcuts live in the renderer (a window keydown listener). A
  // focused WINDOW alone isn't enough: after alt-tabbing back the webContents
  // itself can hold no keyboard focus — the last click inside may have been on
  // the drag-region title bar — and shortcuts then do nothing until a click
  // refocuses the page. Re-focus the page whenever the window becomes active:
  // Space works immediately (Spotify-style), and never fires for another app
  // because the renderer only receives keys while this window is focused.
  // In-page focus (search field, inputs) is unaffected by webContents.focus().
  mainWindow.on("focus", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
  });

  // The mouse's back/forward buttons: Windows reports them as app commands; the views walk their history.
  mainWindow.on("app-command", (_e, cmd) => {
    if (cmd !== "browser-backward" && cmd !== "browser-forward") return;
    mainWindow?.webContents.send("nav:command", cmd === "browser-backward" ? "back" : "forward");
  });

  // Mirror native fullscreen to the renderer: F11 is handled here, while the
  // cinematic view (NowPlaying) drives it over IPC — the renderer tracks the
  // state either way (Escape leaves it; NowPlaying closes if it goes away).
  // NB: the value comes from the event itself, never from isFullScreen():
  // on Windows the flag is still stale while these fire, so reading it here
  // reports the state being left, not the one being entered.
  const sendFullScreen = (fs: boolean): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window:fullscreen", fs);
    }
  };
  mainWindow.on("enter-full-screen", () => sendFullScreen(true));
  mainWindow.on("leave-full-screen", () => sendFullScreen(false));

  pip.restrictNavigation(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Keep explicit web links in the system browser, never in a privileged window.
    try {
      const target = new URL(url);
      // And the one page of Windows' settings the devices panel points to.
      if (target.protocol === "http:" || target.protocol === "https:" || target.href === "ms-settings:bluetooth") {
        void shell.openExternal(target.href).catch((err) => console.warn("[bytune] external browser unavailable:", err.message));
      }
    } catch { /* malformed URL */ }
    return { action: "deny" };
  });
  void mainWindow.loadURL(pip.rendererUrl()).catch((err) => {
    console.warn("[bytune] main window load failed:", err instanceof Error ? err.message : err);
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    // DevTools are a development convenience, not a shipping feature.
    if (isDev && input.type === "keyDown" && input.key === "F12") {
      mainWindow?.webContents.toggleDevTools();
    }
    // Chrome-style F11: toggle plain OS fullscreen (window covers the screen,
    // taskbar hidden). Swallowed before it reaches the page — it must work
    // with a text field focused, and the renderer follows via the
    // enter/leave-full-screen events above, not the key itself.
    if (input.type === "keyDown" && input.key === "F11") {
      event.preventDefault();
      mainWindow?.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // macOS: the red close button (and Cmd+W) hide the window — a music player
  // keeps playing with its window closed (Apple Music / Spotify behaviour),
  // and the Dock icon brings it back via the activate handler. Only a real
  // quit (Cmd+Q, Dock → Quit) destroys the window.
  mainWindow.on("close", (event) => {
    if (isMac && !quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // The miniplayer floats above other apps but is not a stand-alone app:
    // closing the main window takes the native PiP with it (and quits).
    pip.closePip();
  });
}

/** Why the last track-URL request for an id produced no URL (for the renderer's error toast). */
const trackUrlErrors = new Map<string, "missing" | transcode.TranscodeFailure>();

/** Hand a fresh local-library snapshot to the renderer (views + catalogue reload). */
function pushLibrary(lib: locallib.LocalLibrary): void {
  try {
    mainWindow?.webContents.send("library:enriched", lib);
  } catch {
    /* window gone */
  }
  scheduleLyricsIndex();
  scheduleSoundAnalysis();
}

/** Background cover/album fill; each batch is pushed to the renderer. */
function startEnrichment(): void {
  enrichLocalLibrary(pushLibrary);
}

/** The lyrics index catches up a little after the library last changed (scans, enrichment). */
let lyricsIndexTimer: NodeJS.Timeout | null = null;
function scheduleLyricsIndex(delayMs = 15_000): void {
  if (lyricsIndexTimer) clearTimeout(lyricsIndexTimer);
  lyricsIndexTimer = setTimeout(() => {
    lyricsIndexTimer = null;
    void indexLibraryLyrics();
  }, delayMs);
}

/** The sound analysis picks up new and changed files a minute after the library last changed. */
let soundTimer: NodeJS.Timeout | null = null;
function scheduleSoundAnalysis(delayMs = 60_000): void {
  if (soundTimer) clearTimeout(soundTimer);
  soundTimer = setTimeout(() => {
    soundTimer = null;
    void analyseLibrarySound();
  }, delayMs);
}

/** After folders change: watch the new set and let the views know. */
function libraryFoldersChanged(lib: locallib.LocalLibrary): void {
  folderWatch.syncFolderWatchers();
  pushLibrary(lib);
}

// Exact names used by renderer persistence; internal stores are main-only.
const RENDERER_STORES = new Set([
  "settings",
  "library",
  "player",
  "recent-searches",
  "artist-about-cache",
  "smart-playlists",
  "spotify-import",
  "album-edits",
  "library-order",
  // when each part of how the library is organised changed (lib/libraryDocs.ts)
  "library-sync",
  "muted",
  "device-names",
  "server-sync",
]);
/** "jf:<item>" / "ss:<song>" — a song on one of the servers. */
function serverItem(id: unknown): { kind: "jf" | "ss"; raw: string } {
  const m = typeof id === "string" ? /^(jf|ss):([\w.:-]{1,128})$/.exec(id) : null;
  if (!m) throw new Error("Not a server song");
  return { kind: m[1] as "jf" | "ss", raw: m[2] };
}

function assertRendererStore(name: unknown): asserts name is string {
  if (typeof name !== "string" || !RENDERER_STORES.has(name)) throw new Error("Store not allowed");
}

function registerIpc(): void {
  // Every main-window channel goes through this boundary, including fire-and-forget events.
  const ipc = {
    handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
      ipcMain.handle(channel, (event, ...args) => {
        if (!pip.isTrustedSender(event, mainWindow)) throw new Error("Untrusted IPC sender");
        return listener(event, ...args);
      });
    },
    on(channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void): void {
      ipcMain.on(channel, (event, ...args) => {
        if (pip.isTrustedSender(event, mainWindow)) listener(event, ...args);
      });
    },
  };
  pip.registerPipIpc();
  // Own lyrics first (.lrc, embedded tags, Jellyfin), then cache, then the open providers.
  ipc.handle("music:lyrics", (_e, q: LyricsRequest) => libraryLyrics(q));
  // Songs by a line of their lyrics — only the lyrics already on this computer (lyrics-index.ts).
  ipc.handle("lyrics:search", (_e, q: unknown) => (typeof q === "string" ? searchLyrics(q) : []));
  // The sound analysis (sound-library.ts): progress for Settings, results for mixes, details and transitions.
  ipc.handle("sound:status", () => soundStatus());
  ipc.handle("sound:facts", () => soundFacts());
  ipc.handle("sound:enabled", (_e, on: unknown) => setSoundAnalysisEnabled(on !== false));

  ipc.handle("library:get", () => locallib.readLocalLibrary());
  ipc.handle("art:save", (_e, bytes: unknown) => (bytes instanceof Uint8Array ? locallib.saveChosenArt(bytes) : null));
  ipc.handle("library:scan", async (_e, filterNonMusic?: boolean) => {
    folderWatch.noteFilterNonMusic(filterNonMusic !== false);
    const lib = await locallib.scanLibrary(filterNonMusic !== false);
    pushLibrary(lib);
    startEnrichment();
    return lib;
  });
  ipc.handle("library:watch", (_e, enabled: boolean) => folderWatch.setFolderWatchEnabled(enabled !== false));
  ipc.handle("library:setFolders", async (_e, folders: string[]) => {
    const clean = approvedFolderInputs(folders, 8);
    const lib = await locallib.setLibraryFolders(clean);
    libraryFoldersChanged(lib);
    return lib;
  });
  ipc.handle("library:addFolders", async (_e, paths: string[]) => {
    // Same gate as setFolders: only directories already approved through the
    // native picker (app:pickFolder approves before returning) may enter the
    // local library. The renderer must not be able to mint approvals itself.
    const clean = approvedFolderInputs(Array.isArray(paths) ? paths.slice(0, 8) : [], 8);
    const res = await locallib.addLibraryFolders(clean);
    for (const f of res.added) approveDir(f.path);
    libraryFoldersChanged(res.lib);
    return res;
  });
  ipc.handle("library:renameFolder", (_e, folderPath: string, displayName: string) =>
    locallib.renameLibraryFolder(String(folderPath ?? ""), displayName)
  );
  ipc.handle("library:removeFolder", async (_e, folderPath: string) => {
    const lib = await locallib.removeLibraryFolder(String(folderPath ?? ""));
    libraryFoldersChanged(lib);
    return lib;
  });
  ipc.handle("library:folderStatuses", () => locallib.folderStatuses());
  // What can play right now: imported folders that exist, servers that answer.
  ipc.handle("library:availability", async () => {
    const [jf, ss] = await Promise.all([jellyfin.ping(), subsonic.ping()]);
    return { folders: locallib.folderStatuses(), jellyfin: jf, subsonic: ss };
  });
  ipc.handle("library:needsRescan", () => locallib.hasStaleScanRecords());
  ipc.handle("library:trackurl", async (_e, id: string) => {
    if (String(id ?? "").startsWith("jf:")) {
      await startStreamProxy();
      return jellyfin.status().connected ? proxyUrlForJellyfin(String(id)) : null;
    }
    if (String(id ?? "").startsWith("ss:")) {
      await startStreamProxy();
      return subsonic.status().connected ? proxyUrlForSubsonic(String(id)) : null;
    }
    const key = String(id ?? "");
    const p = locallib.localStreamPath(key);
    if (!p) {
      trackUrlErrors.set(key, "missing");
      return null;
    }
    // AIFF, ALAC, WMA, WavPack, APE and DSD are converted to a cached FLAC
    // first (FFmpeg) — the proxy then serves that file instead.
    let served = p;
    try {
      served = await transcode.ensurePlayable(p, locallib.localTrackById(key)?.codec);
    } catch (err) {
      trackUrlErrors.set(key, err instanceof transcode.TranscodeError ? err.reason : "transcode-failed");
      return null;
    }
    trackUrlErrors.delete(key);
    // Serve over the stream proxy — Chromium blocks file:// media when the
    // renderer runs on an http origin (dev server / packaged build).
    await startStreamProxy();
    return proxyUrlForLocalTrack(key) ?? pathToFileURL(served).toString();
  });
  ipc.handle("library:trackerror", (_e, id: string) => trackUrlErrors.get(String(id ?? "")) ?? null);
  ipc.handle("ffmpeg:status", (_e, recheck?: boolean) => transcode.ffmpegStatus(recheck === true));
  ipc.handle("library:artbytes", async (_e, thumb: string) => {
    if (String(thumb ?? "").startsWith("jfart://")) return (await jellyfin.artBytes(String(thumb)))?.data ?? null;
    if (String(thumb ?? "").startsWith("ssart://")) return (await subsonic.artBytes(String(thumb)))?.data ?? null;
    // Raw cover bytes for the palette extractors: Chromium blocks CORS-mode
    // loads (and fetch) to the custom localart:// scheme at the scheme level,
    // so canvas pixel reads can never go through the URL. The renderer turns
    // these bytes into a same-origin blob URL instead — no CORS involved.
    const art = locallib.readLocalArtThumb(String(thumb ?? ""));
    return art ? art.data : null;
  });

  // Open metadata (MusicBrainz · Cover Art Archive · iTunes · Wikidata/Wikipedia).
  ipc.handle("meta:artist", (_e, name: string) => meta.lookupArtist(String(name ?? "")));
  // About a song (story, credits) and an artist's photo and banner, from Genius (song-info.ts).
  ipc.handle("meta:song", (_e, title: unknown, artist: unknown) =>
    songInfo.songInfo(String(title ?? "").slice(0, 200), String(artist ?? "").slice(0, 200))
  );
  ipc.handle("meta:artistImages", (_e, name: unknown) => songInfo.artistImages(String(name ?? "").slice(0, 200)));
  // The artist page's banner at full size, from Wikimedia (metadata.ts lookupArtistPicture).
  ipc.handle("meta:artistPicture", (_e, name: unknown) => meta.lookupArtistPicture(String(name ?? "").slice(0, 200)));
  // Jellyfin server as a second library source.
  ipc.handle("jellyfin:status", () => jellyfin.status());
  ipc.handle("jellyfin:setAway", (_e, address: unknown) => jellyfin.setAway(address));
  ipc.handle("jellyfin:connect", (_e, input: { server: string; username?: string; password?: string; apiKey?: string }) =>
    jellyfin.connect(input ?? { server: "" })
  );
  ipc.handle("jellyfin:disconnect", () => jellyfin.disconnect());
  ipc.handle("jellyfin:library", () => jellyfin.readLibrary());
  ipc.handle("jellyfin:refresh", () => jellyfin.refreshLibrary());
  // The relist at start (stores/catalog.ts) only needs to hear whether anything changed; null: the
  // server couldn't be listed (expected right after signing in to Windows), tried again later.
  ipc.handle("jellyfin:relist", () => jellyfin.refreshLibrary().then((listed) => listed.changed, () => null));

  // AutoEQ headphone correction profiles for the parametric EQ.
  ipc.handle("autoeq:search", (_e, q: string) => autoeq.searchAutoEq(String(q ?? "")));
  ipc.handle("autoeq:fetch", (_e, p: string) => autoeq.fetchAutoEq(String(p ?? "")));

  // Navidrome / Subsonic server as a third library source.
  ipc.handle("subsonic:status", () => subsonic.status());
  ipc.handle("subsonic:connect", (_e, input: { server: string; username: string; password: string }) =>
    subsonic.connect(input ?? { server: "", username: "", password: "" })
  );
  ipc.handle("subsonic:disconnect", () => subsonic.disconnect());
  ipc.handle("subsonic:library", () => subsonic.readLibrary());
  ipc.handle("subsonic:refresh", () => subsonic.refreshLibrary());
  ipc.handle("subsonic:relist", () => subsonic.refreshLibrary().then((listed) => listed.changed, () => null));

  // The sync service: the page decides what to say (lib/homeSync.ts), the login stays here.
  ipc.handle("homeSync:info", () => homeSync.info());
  ipc.handle("homeSync:setAddress", (_e, value: unknown) => homeSync.setAddress(String(value ?? "").slice(0, 300)));
  ipc.handle("homeSync:request", (_e, method: unknown, path: unknown, body: unknown, timeoutMs: unknown) =>
    homeSync.request(method, path, body, timeoutMs)
  );

  // Server sync: Liked Songs ↔ the servers' favorites, plays counted there too.
  // The renderer decides what changes (lib/serverSync.ts); these only talk to the servers.
  ipc.handle("jellyfin:users", () => jellyfin.listUsers());
  ipc.handle("jellyfin:setSyncUser", (_e, id: unknown) =>
    jellyfin.setSyncUser(typeof id === "string" && id ? id.slice(0, 64) : null)
  );
  ipc.handle("server:favorites", async () => {
    const settle = async (list: () => Promise<unknown[]>) => {
      try {
        return { ok: true, tracks: await list() };
      } catch (err) {
        return { ok: false, tracks: [], error: err instanceof Error ? err.message : "failed" };
      }
    };
    return {
      jellyfin: jellyfin.status().syncUserId ? await settle(jellyfin.favoriteTracks) : null,
      subsonic: subsonic.status().connected ? await settle(subsonic.favoriteTracks) : null,
    };
  });
  ipc.handle("server:setFavorite", async (_e, id: unknown, favorite: unknown) => {
    const { kind, raw } = serverItem(id);
    if (kind === "jf") await jellyfin.setFavorite(raw, favorite === true);
    else await subsonic.setStarred(raw, favorite === true);
  });
  ipc.handle("server:played", async (_e, id: unknown, at: unknown) => {
    const { kind, raw } = serverItem(id);
    const when = typeof at === "number" && Number.isFinite(at) && at > 0 && at <= Date.now() + 60_000 ? new Date(at) : new Date();
    if (kind === "jf") await jellyfin.markPlayed(raw, when);
    else await subsonic.scrobble(raw, true, when);
  });
  ipc.handle("server:nowPlaying", async (_e, id: unknown) => {
    const { kind, raw } = serverItem(id);
    // Jellyfin's "now playing" belongs to a playback session; only the play itself is reported there.
    if (kind === "ss") await subsonic.scrobble(raw, false);
  });

  ipc.handle("canvas:get", (_e, q: { title?: string; artist?: string; album?: string }) =>
    canvas.canvasFor(String(q?.title ?? ""), String(q?.artist ?? ""), q?.album ? String(q.album) : undefined)
  );

  // Listening telemetry: one fire-and-forget channel feeding stats.
  ipc.on(
    "playback:event",
    (_e, ev: { type: string; track?: Track; positionSec?: number; playedSec?: number; deltaMs?: number }) => {
      if (dataResetActive) return;
      // A new listen re-arms the one-play rule (replays count, loops don't).
      if (ev.type === "start" && ev.track?.id) stats.noteTrackStart(ev.track.id);
      if ((ev.type === "progress" || ev.type === "stop" || ev.type === "pause") && ev.track && (ev.deltaMs ?? 0) > 0) {
        stats.recordListening(ev.track, ev.deltaMs as number);
      }
    }
  );
  // Discord status (optional): the renderer says what plays; the pipe to Discord lives here.
  ipc.handle("discord:configure", (_e, enabled: unknown, clientId: unknown) =>
    discord.configureDiscord(enabled === true, typeof clientId === "string" ? clientId.slice(0, 64) : "")
  );
  ipc.handle("discord:status", () => discord.discordStatus());
  ipc.on("discord:activity", (_e, activity: unknown) => {
    discord.setDiscordActivity(activity);
    // The album's cover from the open databases, as a public address Discord can fetch at once
    // (metadata.ts discordCover): nothing of the server or the files.
    const shown = discord.sanitizeActivity(activity);
    if (!shown?.album) return;
    void meta
      .discordCover(shown.albumArtist || shown.artist, shown.album)
      .then((url) => {
        if (url) discord.setDiscordCover(shown, url);
      })
      .catch(() => undefined);
  });

  // Songsta at sign-in, on Windows (startup.ts).
  ipc.handle("startup:state", () => startup.startupState());
  ipc.handle("startup:setOpenAtLogin", (_e, on: unknown) => startup.setOpenAtLogin(on === true));

  ipc.handle("stats:playcounts", () => stats.playCounts());
  // The listening history (listens.ts): on this computer only — read a page, export it as CSV.
  ipc.handle("listens:page", (_e, before: unknown, limit: unknown) =>
    listens.readListens(typeof before === "number" ? before : undefined, Number(limit) || 100)
  );
  ipc.handle("listens:moment", () => listens.momentScores());
  ipc.handle("listens:export", async () => {
    if (!mainWindow) return null;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "Export listening history",
      defaultPath: path.join(app.getPath("documents"), "Songsta listening history.csv"),
      filters: [{ name: "Spreadsheet (CSV)", extensions: ["csv"] }],
    });
    if (res.canceled || !res.filePath) return null;
    const { csv, count } = await listens.listensCsv();
    await fs.promises.writeFile(res.filePath, csv, "utf-8");
    return { path: res.filePath, count };
  });
  ipc.handle("stats:summary", (_e, period: string) => {
    const p = (["month", "lastMonth", "year", "all"] as const).find((x) => x === period) ?? "month";
    return stats.summary(p);
  });

  // Window controls — the renderer draws the frameless window's chrome.
  ipc.on("window:minimize", () => mainWindow?.minimize());
  ipc.on("window:maximizeToggle", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipc.on("window:close", () => mainWindow?.close());
  ipc.handle("window:isMaximized", () => !!mainWindow?.isMaximized());
  // Windows-only: hide/restore the native caption-button strip while the
  // immersive Now Playing view is open (Spotify hides its chrome there too).
  // There is no supported visibility toggle, so we try to wash the overlay out
  // (transparent colours, zero height); if the OS clamps that, the renderer
  // falls back to real OS fullscreen, where Windows drops the buttons itself.
  ipc.handle("window:setOverlayChrome", (_e, visible: boolean) => {
    if (!mainWindow || process.platform !== "win32") return "unsupported";
    try {
      mainWindow.setTitleBarOverlay(
        visible
          ? { color: "#000000", symbolColor: "#ffffff", height: 56 }
          : { color: "#00000000", symbolColor: "#00000000", height: 0 }
      );
      return "ok";
    } catch (err) {
      console.warn("[bytune] setTitleBarOverlay failed:", err);
      return "failed";
    }
  });
  ipc.handle("window:setFullScreen", (_e, fs: boolean) => {
    mainWindow?.setFullScreen(fs === true);
    return true;
  });

  ipc.handle("data:scope", () => transition.serializeData(async () => transition.documentScope()));
  ipc.handle("data:read", (_e, name: string, scope: string) => {
    assertRendererStore(name);
    return transition.serializeData(async () => transition.readForDocument(name, scope));
  });
  ipc.handle("data:write", (_e, name: string, data: unknown, scope: string) => transition.serializeData(async () => {
    assertRendererStore(name);
    await transition.writeForDocument(name, data, scope);
  }));
  ipc.handle("app:resetData", () => transition.serializeData(async () => {
    dataResetActive = true;
    try {
      transition.invalidateResetDocuments();
      stats.resetStats();
      await listens.clearListens();
      await Promise.all([downloads.resetDownloads(), locallib.resetLocalLibrary()]);
      await persist.resetAppData();
      // Approvals live in memory too.
      approvedDirs.clear();
    } finally {
      dataResetActive = false;
    }
  }));

  ipc.handle("app:latestVersion", () => latestKnown());
  ipc.handle("update:state", () => updateState());
  ipc.handle("update:start", () => startUpdate());
  ipc.handle("update:install", () => installUpdate());
  // A text file the renderer composed (the Spotify import's shopping list),
  // written only where the user picks in the native save dialog.
  ipc.handle("file:saveText", async (_e, suggestedName: unknown, content: unknown) => {
    if (typeof suggestedName !== "string" || typeof content !== "string") throw new Error("Invalid file");
    if (content.length > 20 * 1024 * 1024) throw new Error("File too large");
    const name = suggestedName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 120) || "list.csv";
    const csv = path.extname(name).toLowerCase() !== ".txt";
    if (!mainWindow) return null;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "Save list",
      defaultPath: path.join(app.getPath("downloads"), csv && !/\.csv$/i.test(name) ? `${name}.csv` : name),
      filters: csv ? [{ name: "Spreadsheet (CSV)", extensions: ["csv"] }] : [{ name: "Text", extensions: ["txt"] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.writeFile(res.filePath, content, "utf-8");
    return res.filePath;
  });
  ipc.handle("app:pickFolder", async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Choose download folder",
      properties: ["openDirectory", "createDirectory"],
    });
    const dir = res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
    if (dir) approveDir(dir);
    return dir;
  });
  // Casting to a network player (cast.ts / upnp.ts); the renderer steers, status comes back as cast:status.
  ipc.handle("cast:find", () => cast.findDevices());
  const castSession = (value: unknown): string | undefined => (typeof value === "string" && /^[\w-]{1,40}$/.test(value) ? value : undefined);
  ipc.handle("cast:start", (_e, id: unknown, session: unknown) =>
    cast.start(
      String(id ?? "").slice(0, 300),
      (s) => {
        try {
          mainWindow?.webContents.send("cast:status", s);
        } catch {
          /* window gone */
        }
      },
      castSession(session)
    )
  );
  ipc.handle("cast:load", (_e, song: unknown, position: unknown, play: unknown, session: unknown) =>
    cast.load(cast.songFrom(song), Math.max(0, Number(position) || 0), play === true, castSession(session))
  );
  ipc.handle("cast:control", (_e, action: unknown, value: unknown, session: unknown, device: unknown) =>
    cast.control(String(action ?? ""), Number(value), castSession(session), typeof device === "string" ? device.slice(0, 300) : undefined)
  );
  ipc.handle("cast:join", (_e, session: unknown, device: unknown) => cast.join(castSession(session) ?? "main", String(device ?? "").slice(0, 300)));
  ipc.handle("cast:leave", (_e, session: unknown, device: unknown) => cast.leave(castSession(session) ?? "main", String(device ?? "").slice(0, 300)));
  ipc.handle("cast:stop", (_e, session: unknown) => cast.stop(castSession(session)));
  ipc.handle("cast:again", () => cast.againAll());
  ipc.handle("cast:playAhead", (_e, map: unknown) => cast.setPlayAhead(map));
  ipc.handle("device:power", (_e, id: unknown) => cast.devicePower(String(id ?? "").slice(0, 300)));
  ipc.handle("device:switchOff", (_e, id: unknown) => cast.deviceSwitchOff(String(id ?? "").slice(0, 300)));
  ipc.handle("device:command", (_e, id: unknown, word: unknown) => cast.deviceCommand(String(id ?? "").slice(0, 300), String(word ?? "").slice(0, 40)));
  ipc.handle("tv:pairStart", (_e, id: unknown) => cast.tvPairStart(String(id ?? "").slice(0, 300)));
  ipc.handle("tv:pairFinish", (_e, code: unknown) => cast.tvPairFinish(String(code ?? "").slice(0, 20)));
  ipc.handle("tv:pairCancel", () => cast.tvPairCancel());
  ipc.handle("tv:power", (_e, id: unknown) => cast.tvPower(String(id ?? "").slice(0, 300)));
  ipc.handle("tv:off", (_e, id: unknown) => cast.tvOff(String(id ?? "").slice(0, 300)));
  ipc.handle("firewall:matters", () => firewallMatters());
  ipc.handle("firewall:hasRule", () => hasFirewallRule());
  ipc.handle("firewall:allow", () => addFirewallRule());

  // M3U playlists (m3u.ts): read with paths resolved; written where the user picks.
  ipc.handle("playlist:openM3u", async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Import a playlist",
      properties: ["openFile"],
      filters: [{ name: "Playlist", extensions: ["m3u8", "m3u"] }],
    });
    const file = res.canceled ? null : res.filePaths[0];
    if (!file) return null;
    const bytes = await fs.promises.readFile(file);
    if (bytes.length > 5 * 1024 * 1024) throw new Error("That file is far too large for a playlist");
    // .m3u8 is UTF-8; an old .m3u is often Windows-1252.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("windows-1252").decode(bytes);
    }
    const dir = path.dirname(file);
    const entries = m3u.parseM3u(text).map((e) => {
      if (!e.path) return e; // a Songsta note
      try {
        if (/^file:/i.test(e.path)) return { ...e, path: fileURLToPath(e.path) };
        if (/^[a-z][a-z0-9+.-]+:\/\//i.test(e.path)) return e; // http(s) and other URLs stay as they are
        return { ...e, path: path.resolve(dir, e.path) }; // relative to the playlist's own folder
      } catch {
        return e;
      }
    });
    return { name: path.basename(file).replace(/\.m3u8?$/i, ""), entries };
  });
  ipc.handle("playlist:saveM3u", async (_e, suggestedName: unknown, content: unknown) => {
    if (typeof suggestedName !== "string" || typeof content !== "string") throw new Error("Invalid playlist");
    if (content.length > 20 * 1024 * 1024) throw new Error("Playlist too large");
    if (!mainWindow) return null;
    const name = suggestedName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 120) || "Playlist";
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "Export playlist",
      defaultPath: path.join(app.getPath("music"), `${name}.m3u8`),
      filters: [{ name: "Playlist (M3U8)", extensions: ["m3u8"] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.writeFile(res.filePath, content, "utf-8");
    return res.filePath;
  });

  // Bought music: a store's ZIP, unpacked into one of the library folders as one album.
  ipc.handle("library:pickArchive", async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Import bought music",
      defaultPath: app.getPath("downloads"),
      properties: ["openFile"],
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  ipc.handle("library:importArchive", async (_e, zipPath: unknown, folder: unknown) => {
    if (typeof zipPath !== "string" || typeof folder !== "string") throw new Error("Choose a .zip file");
    const folders = (locallib.readLocalLibrary().folders as (string | { path: string })[]).map((f) => (typeof f === "string" ? f : f.path));
    const target = folders.find((f) => samePath(f, folder));
    if (!target || !isApprovedPath(target)) throw new Error("Choose one of your library folders");
    return archive.importArchive(zipPath, target);
  });
  ipc.handle("app:revealPath", (_e, p: string) => {
    if (p && isApprovedPath(p)) shell.showItemInFolder(p);
  });
  ipc.handle("app:openPath", (_e, p: string) => {
    if (p && isApprovedPath(p)) return shell.openPath(p);
    return "Not allowed";
  });

  ipc.handle("download:start", async (_e, track: Track, dir?: string) => {
    if (dir && !isApprovedPath(dir)) throw new Error("Download folder not approved");
    // An offline copy of a server song lands in its own library folder, added once.
    if (!dir && typeof track?.id === "string" && downloads.SERVER_SONG.test(track.id)) {
      const offline = downloads.offlineDir();
      await fs.promises.mkdir(offline, { recursive: true });
      approveDir(offline);
      const folders = (locallib.readLocalLibrary().folders as (string | { path: string })[]).map((f) => (typeof f === "string" ? f : f.path));
      if (!folders.some((f) => samePath(f, offline))) {
        const res = await locallib.addLibraryFolders([offline]);
        libraryFoldersChanged(res.lib);
      }
    }
    return downloads.enqueueDownload(track, dir);
  });
  ipc.handle("download:cancel", (_e, id: string) => downloads.cancelDownload(String(id ?? "")));
  ipc.handle("download:queue", () => downloads.queueSnapshot());
  // The check at start (lib/keptListsWatch.ts): which offline copies are gone from the disk.
  // Only paths in approved folders are looked at; anything else is never reported gone.
  ipc.handle("download:missing", async (_e, paths: unknown) => {
    if (!Array.isArray(paths) || paths.length > 100_000) return [];
    const asked = paths.filter((p): p is string => typeof p === "string" && !!p && isApprovedPath(p));
    const gone = await Promise.all(asked.map((p) => fs.promises.access(p).then(() => false, () => true)));
    return asked.filter((_, i) => gone[i]);
  });
  // "Remove download": the copy goes to the recycle bin, and only from the offline copies' folder.
  ipc.handle("download:remove", async (_e, p: unknown) => {
    if (typeof p !== "string" || !downloads.isOfflineCopy(p)) throw new Error("Not an offline copy");
    if (!fs.existsSync(p)) return true;
    await shell.trashItem(path.resolve(p));
    return true;
  });
  downloads.addDownloadListener((e) => {
    try {
      mainWindow?.webContents.send("download:event", e);
    } catch {
      /* window gone */
    }
  });

  ipc.handle("backup:export", () => backupExport(mainWindow));
  ipc.handle("backup:import", () => backupImport(mainWindow));

  // macOS menu checkmarks + the Windows taskbar thumbbar glyph: the renderer
  // pushes playback state; the menu is rebuilt so Shuffle/Repeat/Play-Pause
  // always show the truth, and the thumbbar swaps its play/pause icon.
  ipc.on("menu:push-state", (_e, s: unknown) => {
    if (!s || typeof s !== "object") return;
    const r = (s as { repeat?: unknown }).repeat;
    menuState = {
      playing: (s as { playing?: unknown }).playing === true,
      shuffle: (s as { shuffle?: unknown }).shuffle === true,
      repeat: r === "all" || r === "one" ? r : "off",
    };
    applyMenu();
    applyThumbar();
  });
}

/**
 * Filesystem allowlist: the renderer may only open/reveal/download inside
 * directories the user explicitly chose (native dialog or default downloads
 * location), plus the app's own data. A compromised renderer can't use these
 * IPC channels to launch arbitrary files.
 */
const approvedDirs = new Set<string>();
function approvedFolderInputs(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid folder list");
  return value.map((dir) => {
    if (typeof dir !== "string" || !dir.trim() || !isApprovedPath(dir)) throw new Error("Folder not approved");
    return path.resolve(dir);
  });
}
function approveDir(dir: string): void {
  const resolved = path.resolve(dir);
  if (approvedDirs.has(resolved)) return;
  approvedDirs.add(resolved);
  // Persist so a folder the user once picked survives restarts - otherwise a
  // custom download location would be silently rejected after a restart.
  const stored = (persist.readData("approved-dirs") as string[] | null) ?? [];
  if (!stored.includes(resolved)) void persist.writeData("approved-dirs", [...stored, resolved]);
}
function isApprovedPath(p: string): boolean {
  const resolved = path.resolve(String(p ?? ""));
  // Separator guard: `...\ByTune` must not approve a sibling such as
  // `...\ByTuneX` that merely shares the prefix.
  const userData = app.getPath("userData");
  if (resolved === userData || resolved.startsWith(userData + path.sep)) return true;
  for (const dir of approvedDirs) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return true;
  }
  return false;
}

const gotLock =
  process.env.BYTUNE_ALLOW_MULTI === "1" || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    if (isMac) {
      applyMenu();
      app.setAboutPanelOptions({
        applicationName: "Songsta",
        applicationVersion: app.getVersion(),
        copyright: "Licensed under GPL-3.0",
      });
      if (isDev) {
        // The packaged bundle gets its Dock icon from the .icns in the app
        // bundle; dev runs would otherwise show the stock Electron icon.
        const icon = iconPath();
        if (icon) {
          try {
            app.dock?.setIcon(icon);
          } catch {
            /* cosmetic only */
          }
        }
      }
    } else {
      Menu.setApplicationMenu(null);
    }
    persist.migrateLegacyData();
    watchServerReach();
    pip.bindMainWindowGetter(() => mainWindow);
    const lib = locallib.readLocalLibrary();
    for (const f of lib.folders) approveDir(f.path);
    for (const d of (persist.readData("approved-dirs") as string[] | null) ?? []) {
      if (typeof d === "string") approvedDirs.add(path.resolve(d));
    }

    protocol.handle("ssart", async (req) => {
      const art = await subsonic.artBytes(req.url);
      if (!art) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(art.data), { headers: { "Content-Type": art.mime } });
    });
    protocol.handle("jfart", async (req) => {
      const art = await jellyfin.artBytes(req.url);
      if (!art) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(art.data), { headers: { "Content-Type": art.mime } });
    });
    configureAppUpdate((state) => {
      try {
        mainWindow?.webContents.send("update:state", state);
      } catch {
        /* window gone */
      }
    });
    // Covers the tags lack are filled from the open databases in the background.
    startEnrichment();
    // The lyrics search index catches up once the start is over.
    scheduleLyricsIndex(30_000);
    // So does the sound analysis, a little later; the renderer hears when more songs are measured.
    configureSoundAnalysis({
      onUpdate: () => {
        try {
          mainWindow?.webContents.send("sound:updated");
        } catch {
          /* window gone */
        }
      },
    });
    scheduleSoundAnalysis(90_000);
    // New, changed and deleted files show up without a manual rescan.
    folderWatch.configureFolderWatch({
      onRescanned: (lib) => {
        pushLibrary(lib);
        startEnrichment();
      },
    });
    folderWatch.syncFolderWatchers();

    protocol.handle("localart", (req) => {
      // For localart://<hash>.<ext> the filename lands in `hostname` and
      // `pathname` is "/" — stitch them and trim the dangling separator or
      // the art-name regex below rejects every request. A malformed percent
      // sequence must 404, not throw out of the handler.
      let name: string;
      try {
        const u = new URL(req.url);
        name = decodeURIComponent(u.hostname + u.pathname).replace(/^\/+|\/+$/g, "");
      } catch {
        return new Response("not found", { status: 404 });
      }
      const art = locallib.readArtFile(name);
      if (!art) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(art.data), { headers: { "Content-Type": art.mime } });
    });
    app.on("before-quit", (event) => {
      // Mark the real quit BEFORE the drain: the hide-on-close guard must
      // stand down for any close events that fire during shutdown.
      quitting = true;
      stats.flushSync(); // the listening history's last lines too
      saveLyricsIndexSync();
      saveSoundIndexSync();
      pip.savePipRect();
      discord.stopDiscord();
      void cast.stopAll();
      // Close-time durability: the renderer's last coalesced writes may still
      // be in flight when the window dies.
      // Hold quit for a bounded drain — the final player write lands unless
      // something is genuinely stuck, in which case we quit anyway.
      if (!drainStarted) {
        drainStarted = true;
        event.preventDefault();
        const timeout = setTimeout(() => {
          console.warn("[bytune] shutdown drain timed out; quitting");
          app.exit(0);
        }, 3000).unref();
        transition
          .drainData()
          .then(() => persist.drainWrites())
          .catch((err) => console.warn("[bytune] shutdown drain failed:", err))
          .finally(() => {
            clearTimeout(timeout);
            app.exit(0);
          });
      }
    });
    // Output-device picker: Chromium hides device labels/ids behind a capture
    // permission, and the renderer's one-time getUserMedia unlock is only
    // deterministic if the session approves it — Electron's implicit default
    // made that depend on build flags. Keep Electron's approve-all behavior
    // but pinned explicitly, so the picker works the same everywhere.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler(() => true);
    registerIpc();
    stats.initStats();
    void startStreamProxy().catch((err) => console.warn("[bytune] stream proxy failed:", err));
    createWindow();
    app.on("activate", () => {
      // macOS Dock re-open: bring the hidden main window back, recreate it
      // only if it was actually destroyed (real quit never reaches here).
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });

  app.on("window-all-closed", () => {
    // macOS: the app keeps running when its windows close (close-to-hide
    // above means the main window is hidden, not destroyed) — quit comes
    // from Cmd+Q / Dock → Quit, which goes through before-quit.
    if (!isMac) app.quit();
  });
}
