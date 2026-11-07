/** Transient UI state: navigation, panels, toasts, context menu, dialogs. */
import type { LucideIcon } from "lucide-react";
import { create } from "zustand";

export type ViewName =
  | "home"
  | "explore"
  | "genre"
  | "search"
  | "library"
  | "playlists"
  | "playlist"
  | "album"
  | "artist"
  | "artistliked"
  | "local"
  | "jellyfin"
  | "subsonic"
  | "mix"
  | "smart"
  | "replay"
  | "check"
  | "loose"
  | "spotify"
  | "settings";

export interface View {
  name: ViewName;
  /** playlist id / album id / etc. */
  param?: string;
}

/** One history slot: the view plus the content scroll it was left at, so
    back/forward can put the user exactly where they were (Settings → local
    folder → back must not land at the top of Settings again). */
export interface NavEntry {
  view: View;
  /** scrollTop of the #view-scroll container when this view was left */
  scroll: number;
}

export interface MenuItem {
  label?: string;
  icon?: LucideIcon;
  /** extra classes for the icon (e.g. fill-accent for a filled pin) */
  iconClassName?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  /** section label — rendered as a non-interactive caption */
  header?: boolean;
  /** nested menu — opens on hover/click, one at a time */
  children?: MenuItem[];
  action?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
  /** treat y as the BOTTOM edge — the menu opens upward (playbar buttons) */
  above?: boolean;
  /** treat x as the RIGHT edge — the menu right-aligns to it (settings selects) */
  alignRight?: boolean;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "error" | "warning";
  /** ms before auto-dismiss. The Toasts layer owns the timer (hover pauses it)
      and plays the exit animation before calling dismissToast. */
  duration?: number;
  /** one button on the toast ("Branch off"); the toast closes after it */
  action?: { label: string; run: () => void };
}

/** A modal request — replaces browser prompt()/confirm() with the ByTune dialog. */
export interface DialogRequest {
  title: string;
  body?: string;
  /** when set, the dialog shows a text input pre-filled with this value */
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: (value: string) => void;
  /** Left without an answer. */
  onCancel?: () => void;
}

export interface UIState {
  view: View;
  navPast: NavEntry[];
  navFuture: NavEntry[];
  /** Scroll offset to restore into #view-scroll on the next back/forward
      render — set by goBack/goForward, consumed by App's layout effect. */
  pendingScroll: number | null;
  searchQuery: string;
  /** Right panel mode: song details (default), the Queue sheet or the devices. */
  rightPanel: "details" | "queue" | "devices";
  /** Synced lyrics rendered in the centre pane over the current view. */
  lyricsCenter: boolean;
  nowPlayingOpen: boolean;
  /** Plain OS fullscreen (F11): the window covers the screen and the taskbar
      is gone; the app's own top bar stays visible. Mirrored from the main
      process — the renderer never writes it. */
  osFullscreen: boolean;
  toasts: Toast[];
  contextMenu: ContextMenuState | null;
  dialog: DialogRequest | null;
  /** Artwork URL the pointer is hovering — drives the middle panel's wash.
      null = at rest, the wash wears the playing track's colour. */
  tintThumb: string | null;
  /** Bumped to re-run the CURRENT view's data lifecycle: App keys the view
      container on it, so a bump remounts the page and its fetch effects. */
  viewReloadNonce: number;

  navigate(view: View): void;
  goBack(): void;
  goForward(): void;
  setSearchQuery(q: string): void;
  toggleQueue(): void;
  toggleLyrics(): void;
  toggleNowPlaying(): void;
  setOsFullscreen(fs: boolean): void;
  closePanels(): void;
  toast(message: string, kind?: Toast["kind"], duration?: number, action?: Toast["action"]): void;
  dismissToast(id: number): void;
  setTintThumb(url: string | null): void;
  openContextMenu(x: number, y: number, items: MenuItem[], options?: { above?: boolean; alignRight?: boolean }): void;
  closeContextMenu(): void;
  openDialog(req: DialogRequest): void;
  closeDialog(): void;
  bumpViewReload(): void;
  clearPendingScroll(): void;
}

let toastSeq = 1;

/**
 * The wash follows the pointer only once it rests: sweeping across a list
 * used to start a cover read + colour extraction + crossfade for every row
 * the pointer merely crossed. Entering waits a beat; leaving waits a little
 * longer, so moving from one card to the next never flashes back in between.
 */
const TINT_ENTER_MS = 140;
const TINT_LEAVE_MS = 200;
let tintTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTint(thumb: string | null, delay: number): void {
  if (tintTimer !== null) clearTimeout(tintTimer);
  tintTimer = setTimeout(() => {
    tintTimer = null;
    useUI.getState().setTintThumb(thumb);
  }, delay);
}

function cancelTint(): void {
  if (tintTimer !== null) clearTimeout(tintTimer);
  tintTimer = null;
}

/**
 * Spread onto any card or row that represents playable art (song, album,
 * artist, playlist): while the pointer rests on it, the middle panel's wash
 * borrows that artwork's colour (see TintWash in App.tsx). Leaving the card
 * hands the wash back to the playing track.
 */
export function tintHoverHandlers(thumb: string | null | undefined) {
  return {
    onMouseEnter: (): void => scheduleTint(thumb ?? null, TINT_ENTER_MS),
    onMouseLeave: (): void => scheduleTint(null, TINT_LEAVE_MS),
  };
}

function sameView(a: View, b: View): boolean {
  return a.name === b.name && a.param === b.param;
}

/** The content scroller lives outside React (App's #view-scroll); the nav
    stack reads its offset here so every navigate/back/forward site gets
    scroll memory without each caller passing it along. */
function readViewScroll(): number {
  try {
    return document.getElementById("view-scroll")?.scrollTop ?? 0;
  } catch {
    return 0;
  }
}

export const useUI = create<UIState>((set, get) => ({
  // A local player: home is built from the library.
  view: { name: "home" },
  navPast: [],
  navFuture: [],
  pendingScroll: null,
  searchQuery: "",
  rightPanel: "details" as "details" | "queue" | "devices",
  lyricsCenter: false,
  nowPlayingOpen: false,
  osFullscreen: false,
  toasts: [],
  contextMenu: null,
  dialog: null,
  tintThumb: null,
  viewReloadNonce: 0,

  navigate(view) {
    const { view: current, navPast, lyricsCenter } = get();
    if (sameView(current, view)) {
      // Same destination — but a lyrics overlay may still be hiding it.
      if (lyricsCenter) set({ lyricsCenter: false });
      return;
    }
    // Any navigation reveals the clicked content: the lyrics overlay must
    // not keep covering views the user explicitly navigated to. The wash
    // hover also dies with the pointer's card — React doesn't fire
    // mouseleave on unmount, so clear it here (and drop a pending one).
    cancelTint();
    set({
      view,
      navPast: [...navPast.slice(-40), { view: current, scroll: readViewScroll() }],
      navFuture: [],
      lyricsCenter: false,
      tintThumb: null,
    });
  },

  goBack() {
    const { navPast, navFuture, view } = get();
    const prev = navPast[navPast.length - 1];
    if (!prev) return;
    set({
      view: prev.view,
      navPast: navPast.slice(0, -1),
      navFuture: [{ view, scroll: readViewScroll() }, ...navFuture.slice(0, 40)],
      pendingScroll: prev.scroll,
      lyricsCenter: false,
    });
  },

  goForward() {
    const { navPast, navFuture, view } = get();
    const next = navFuture[0];
    if (!next) return;
    set({
      view: next.view,
      navPast: [...navPast, { view, scroll: readViewScroll() }],
      navFuture: navFuture.slice(1),
      pendingScroll: next.scroll,
      lyricsCenter: false,
    });
  },

  setSearchQuery(searchQuery) {
    set({ searchQuery });
  },

  toggleQueue() {
    set({ rightPanel: get().rightPanel === "queue" ? "details" : "queue" });
  },

  toggleLyrics() {
    set({ lyricsCenter: !get().lyricsCenter });
  },

  toggleNowPlaying() {
    set({ nowPlayingOpen: !get().nowPlayingOpen });
  },

  setOsFullscreen(osFullscreen) {
    set({ osFullscreen });
  },

  closePanels() {
    set({ rightPanel: "details", lyricsCenter: false, nowPlayingOpen: false });
  },

  toast(message, kind = "info", duration = 4600, action) {
    // No self-removal timer here — ToastCard runs the countdown so hover can
    // pause it and the lift-out animation plays before dismissToast.
    const toast: Toast = { id: toastSeq++, message, kind, duration, action };
    set({ toasts: [...get().toasts, toast].slice(-4) });
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  setTintThumb(tintThumb) {
    // A direct set (a list that just changed under the pointer) wins over a pending hover.
    if (tintThumb === null) cancelTint();
    if (get().tintThumb === tintThumb) return;
    set({ tintThumb });
  },

  openContextMenu(x, y, items, options) {
    set({ contextMenu: { x, y, items, above: options?.above, alignRight: options?.alignRight } });
  },

  closeContextMenu() {
    set({ contextMenu: null });
  },

  openDialog(req) {
    set({ dialog: req });
  },

  closeDialog() {
    set({ dialog: null });
  },

  bumpViewReload() {
    set({ viewReloadNonce: get().viewReloadNonce + 1 });
  },

  clearPendingScroll() {
    if (get().pendingScroll !== null) set({ pendingScroll: null });
  },
}));
