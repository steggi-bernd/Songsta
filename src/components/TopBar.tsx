/**
 * Top bar — Spotify's three-cluster layout on a glass strip.
 *
 *  - Left: history chevrons + the brand mark (28dp), like Spotify's logo
 *    beside the back/forward buttons.
 *  - Centre: a centred floating search field, max 560px, on a glass pill.
 *  - Right: the library sources — Local Music, and Jellyfin / Navidrome once
 *    connected, each with a dot for whether it can be reached — then the
 *    settings gear.
 *
 * The bar itself is `chrome-glass` (rgba(0,0,0,0.72) + blur(24) saturate(140%),
 * per index.css) — the same recipe the mobile status bar uses.
 */
import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Disc3,
  FolderOpen,
  History,
  Home,
  Minus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import { useAvailability } from "../stores/availability";
import { useCatalog } from "../stores/catalog";
import { isMac } from "../lib/platform";
import { useUI } from "../stores/ui";
import { useRecents } from "../stores/recents";
import brandLogo from "../assets/brand/songsta-logo.svg";
import { T } from "../lib/i18n";
import { useNewerVersion } from "../lib/newVersionWatch";

/** A completion under the search field. */
interface SearchSuggestion {
  text: string;
}

/** The brand mark alone — no wordmark beside it. The SVG is pure white and
    sits directly on the dark `chrome-glass` bar. Imported as an asset so Vite
    hashes it and rewrites the URL relative to the bundle (base: "./"), which
    is what makes it resolve under file:// in the packaged app — a string like
    "/brand/x.svg" only works on the dev server. */
function BrandHeader() {
  return <img src={brandLogo} alt={T("Songsta")} className="h-7 w-auto block" />;
}

/** A round 40px button of the right cluster; `dot` marks a source as reachable (true) or away (false). */
function ClusterButton({
  icon: Icon,
  label,
  active,
  dot,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  dot?: boolean | null;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`relative w-10 h-10 grid place-items-center rounded-full transition-colors ${
        active ? "bg-ink-hi/[0.16] text-ink-hi" : "text-ink-hi/70 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
      }`}
    >
      <Icon className="w-[19px] h-[19px]" />
      {dot !== undefined && dot !== null && (
        <span
          aria-hidden
          className={`absolute bottom-[7px] right-[7px] w-2 h-2 rounded-full ring-2 ring-[#0b0b0b] ${dot ? "bg-emerald-400" : "bg-red-400"}`}
        />
      )}
    </button>
  );
}

/** The library sources and the settings gear (where the profile avatar used to sit). */
function SourcesAndSettings() {
  const view = useUI((s) => s.view);
  const navigate = useUI((s) => s.navigate);
  const offlineFolders = useAvailability((s) => s.offlineFolders.length);
  const jellyfinConnected = useAvailability((s) => s.jellyfinConnected);
  const subsonicConnected = useAvailability((s) => s.subsonicConnected);
  const jellyfin = useAvailability((s) => s.jellyfin);
  const subsonic = useAvailability((s) => s.subsonic);
  const reach = (up: boolean | null): string => (up === false ? " — can't be reached" : up ? " — connected" : "");
  const newer = useNewerVersion();
  return (
    <div className="app-no-drag ml-1 mr-2 flex items-center gap-0.5">
      <ClusterButton
        icon={FolderOpen}
        label={offlineFolders ? T("Local Music — {offlineFolders} {value} can't be reached", { offlineFolders, value: offlineFolders === 1 ? T("folder") : T("folders") }) : T("Local Music")}
        active={view.name === "local"}
        dot={offlineFolders ? false : null}
        onClick={() => navigate({ name: "local" })}
      />
      {jellyfinConnected && (
        <ClusterButton
          icon={Server}
          label={T("Jellyfin{reach}", { reach: reach(jellyfin) })}
          active={view.name === "jellyfin"}
          dot={jellyfin}
          onClick={() => navigate({ name: "jellyfin" })}
        />
      )}
      {subsonicConnected && (
        <ClusterButton
          icon={Disc3}
          label={T("Navidrome{reach}", { reach: reach(subsonic) })}
          active={view.name === "subsonic"}
          dot={subsonic}
          onClick={() => navigate({ name: "subsonic" })}
        />
      )}
      <ClusterButton
        icon={Settings}
        label={newer ? T("Settings — Songsta {version} is out", { version: newer }) : T("Settings")}
        active={view.name === "settings"}
        dot={newer ? true : null}
        onClick={() => navigate({ name: "settings" })}
      />
    </div>
  );
}

/**
 * A vinyl record — rim, two grooves and a solid label around the spindle
 * hole — for Explore. Drawn here: lucide has no record, and its Disc3 is
 * already Navidrome's button.
 */
function VinylIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 5.5a6.5 6.5 0 0 1 6.5 6.5" strokeWidth="1.5" />
      <path d="M12 18.5a6.5 6.5 0 0 1-6.5-6.5" strokeWidth="1.5" />
      <path
        d="M12 8.6a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8Zm0 2.4a1 1 0 1 1 0 2a1 1 0 1 1 0-2Z"
        fill="currentColor"
        fillRule="evenodd"
        stroke="none"
      />
    </svg>
  );
}

/** Windows caption buttons, drawn by the renderer so they match the theme:
    #242424 hover on min/max, Windows red on close. macOS renders native
    traffic lights instead (hiddenInset) and this component is not mounted. */
export function CaptionButtons() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    window.bytune?.isMaximized().then(setMaximized).catch(() => undefined);
    const off = window.bytune?.onMaximizeChange(setMaximized);
    return () => off?.();
  }, []);

  const base =
    "app-no-drag w-[46px] h-full grid place-items-center text-ink-hi/85 transition-colors";
  return (
    <div className="app-no-drag h-full flex items-stretch">
      <button
        onClick={() => window.bytune?.windowMinimize()}
        title={T("Minimize")}
        aria-label={T("Minimize")}
        className={`${base} hover:bg-ink-hi/[0.08]`}
      >
        <Minus className="w-4 h-4" />
      </button>
      <button
        onClick={() => window.bytune?.windowMaximizeToggle()}
        title={maximized ? T("Restore") : T("Maximize")}
        aria-label={maximized ? T("Restore") : T("Maximize")}
        className={`${base} hover:bg-ink-hi/[0.08]`}
      >
        {maximized ? <Copy className="w-[13px] h-[13px]" /> : <Square className="w-[13px] h-[13px]" />}
      </button>
      <button
        onClick={() => window.bytune?.windowClose()}
        title={T("Close")}
        aria-label={T("Close")}
        className={`${base} hover:bg-[#c42b1c] hover:text-white`}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function TopBar() {
  const query = useUI((s) => s.searchQuery);
  const setQuery = useUI((s) => s.setSearchQuery);
  const view = useUI((s) => s.view);
  const navigate = useUI((s) => s.navigate);
  const goBack = useUI((s) => s.goBack);
  const goForward = useUI((s) => s.goForward);
  const canBack = useUI((s) => s.navPast.length > 0);
  const canForward = useUI((s) => s.navFuture.length > 0);
  const recents = useRecents((s) => s.searches);
  const removeSearch = useRecents((s) => s.removeSearch);
  const clearSearches = useRecents((s) => s.clearSearches);

  // Typing only feeds the dropdown — the page behind it stays put. The
  // results page is where songs get chosen; navigation happens on Enter or
  // a completion click, and the dropdown closes either way.

  // Type-ahead dropdown — BitChord mobile's model: plain text completions
  // only, no artwork rows while typing. Row 0 offers the typed query itself.
  const [suggests, setSuggests] = useState<SearchSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  /** keyboard highlight: 0 = the typed-query row, 1..n = completions, -1 = none */
  const [activeIdx, setActiveIdx] = useState(-1);
  const suggestSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** the field + both dropdowns — blur is ignored while focus stays inside */
  const searchClusterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!fieldFocused || q.length < 2) {
      setSuggests([]);
      setSuggestOpen(false);
      setActiveIdx(-1);
      return;
    }
    const seq = ++suggestSeq.current;
    // Completions come from the user's own library (artists, albums, titles
    // that start with the typed text) — there is no catalogue to ask.
    const timer = window.setTimeout(() => {
      void Promise.resolve(useCatalog.getState().tracks)
        .then((tracks) => {
          if (suggestSeq.current !== seq) return; // a newer keystroke won
          const lower = q.toLowerCase();
          const seen = new Set<string>([lower]);
          const items: SearchSuggestion[] = [];
          for (const t of tracks) {
            for (const text of [t.artist, t.album ?? "", t.title]) {
              const key = text.toLowerCase();
              if (!key.startsWith(lower) || seen.has(key)) continue;
              seen.add(key);
              items.push({ text });
            }
            if (items.length >= 8) break;
          }
          setSuggests(items);
          setSuggestOpen(items.length > 0);
          setActiveIdx(-1);
        })
        .catch(() => undefined);
    }, 160);
    return () => window.clearTimeout(timer);
  }, [query, fieldFocused]);

  const closeDropdown = (): void => {
    setSuggestOpen(false);
    setActiveIdx(-1);
  };

  /** Going home always lands clean — a stale query left in the field would
      read as "a search is still active" while the feed shows behind it. */
  const goHome = (): void => {
    setQuery("");
    closeDropdown();
    setSuggests([]);
    setFieldFocused(false);
    inputRef.current?.blur();
    navigate({ name: "home" });
  };

  /** Mobile model: an empty focused field drops the recent-searches panel. */
  const historyOpen = fieldFocused && suggestOpen === false && recents.length > 0 && query.trim().length === 0;

  /** Run a search: commit the text, close the dropdown, blur the field. */
  const submitSearch = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    setQuery(t);
    closeDropdown();
    setFieldFocused(false);
    inputRef.current?.blur();
    navigate({ name: "search" });
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDropdown();
      setFieldFocused(false);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown" && suggestOpen && suggests.length > 0) {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggests.length));
    } else if (e.key === "ArrowUp" && suggestOpen) {
      e.preventDefault();
      setActiveIdx((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Keyboard-highlighted completion runs itself; anything else runs the
      // typed query. Either way the dropdown goes away.
      const pick = suggestOpen && activeIdx >= 1 ? suggests[activeIdx - 1]?.text : query;
      submitSearch(pick);
    }
  };

  // Refresh is route-aware: Home drops its feed caches and re-orchestrates
  // (its own central mechanism); every other view gets its data lifecycle
  // re-run in place — App keys the view container on viewReloadNonce, so the
  // bump remounts the page and its fetch effects, with route and params
  // untouched. Never navigates: a refresh on Search stays on Search.
  const [feedRefreshing, setFeedRefreshing] = useState(false);
  const refreshCurrentView = (): void => {
    if (feedRefreshing) return;
    setFeedRefreshing(true);
    useUI.getState().bumpViewReload();
    window.setTimeout(() => setFeedRefreshing(false), 800);
  };

  return (
    /* The bar runs to the window edge: Windows draws renderer caption
       buttons top-right; macOS reserves the top-left strip for the native
       traffic lights (hiddenInset) — 84px clears the three lights plus
       breathing room, so the brand mark starts where they end. The bar owns
       the 12px breathing strip under it (App's shell no longer adds one),
       so its content centres in the full 68px — equal space above and below. */
    <div
      className={`app-drag relative h-[68px] shrink-0 flex items-center gap-3 chrome-glass z-20 ${
        isMac ? "pl-[84px]" : "pl-[30px]"
      }`}
    >
      {/* Left cluster — the brand, then the history + refresh controls
          (Spotify's top-bar model: 32px circular buttons, 16px glyphs). Off
          the Mac the mark starts at 36px (30px + its button's 6px) and stays
          there whether the library is open or folded: open, the covers' left
          edge is there (see the list in Sidebar.tsx); folded,
          the 24px mark sits on the 80px rail's centre (48px). */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={goHome}
          className="app-no-drag flex items-center justify-center px-1.5 h-10 rounded-full hover:bg-ink-hi/[0.06] transition-colors"
          title={T("Songsta")}
        >
          <BrandHeader />
        </button>
        <button
          onClick={() => goBack()}
          title={T("Go back")}
          aria-label={T("Go back")}
          disabled={!canBack}
          className={`app-no-drag w-9 h-9 grid place-items-center rounded-full transition-colors ${
            canBack
              ? "text-ink-hi/90 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
              : "text-ink-hi/30 pointer-events-none"
          }`}
        >
          <ChevronLeft className="w-5 h-5" strokeWidth={2.5} />
        </button>
        <button
          onClick={() => goForward()}
          title={T("Go forward")}
          aria-label={T("Go forward")}
          disabled={!canForward}
          className={`app-no-drag w-9 h-9 grid place-items-center rounded-full transition-colors ${
            canForward
              ? "text-ink-hi/90 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
              : "text-ink-hi/30 pointer-events-none"
          }`}
        >
          <ChevronRight className="w-5 h-5" strokeWidth={2.5} />
        </button>
        <button
          onClick={refreshCurrentView}
          title={T("Refresh")}
          aria-label={T("Refresh")}
          className="app-no-drag w-9 h-9 grid place-items-center rounded-full text-ink-hi/60 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${feedRefreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Centre cluster — home button beside the search field, Spotify-style:
          pinned to the true window centre (not balanced between the side
          clusters), centred on the bar's vertical midline. */}
      <div className="absolute left-1/2 top-0 h-full -translate-x-1/2 flex items-center gap-3">
        <button
          onClick={goHome}
          title={T("Home")}
          aria-label={T("Home")}
          aria-current={view.name === "home" ? "page" : undefined}
          className={`app-no-drag w-12 h-12 shrink-0 grid place-items-center rounded-full transition-colors ${
            view.name === "home"
              ? "bg-elevated text-ink-hi"
              : "bg-panel text-ink-hi/75 hover:text-ink-hi hover:bg-ink-hi/[0.06]"
          }`}
        >
          <Home className="w-5 h-5" />
        </button>
        <div ref={searchClusterRef} className="app-no-drag relative w-[min(474px,36vw)]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 text-ink-hi/55 pointer-events-none" />
          <input
            id="global-search"
            ref={inputRef}
            type="text"
            value={query}
            maxLength={200}
            placeholder={T("What do you want to play?")}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => {
              setFieldFocused(true);
              if (suggests.length > 0) setSuggestOpen(true);
            }}
            onBlur={(e) => {
              // Close the moment focus genuinely leaves the cluster — no
              // timer. Dropdown rows keep focus on the field with
              // onMouseDown preventDefault, so a click on a row never blurs
              // here; and if focus moves INTO the dropdown (keyboard Tab),
              // the popover stays open for it. A pending blur timeout used
              // to fire after a quick re-focus and hide the popover while
              // the field was focused again.
              const next = e.relatedTarget as Node | null;
              if (next && searchClusterRef.current?.contains(next)) return;
              setFieldFocused(false);
              setSuggestOpen(false);
              setActiveIdx(-1);
            }}
            onKeyDown={onSearchKeyDown}
            className={`w-full h-12 pl-12 rounded-full bg-panel border border-transparent text-[16px] text-ink-hi placeholder:text-ink-hi/45 outline-none hover:bg-ink-hi/[0.06] focus:border-ink-hi/25 focus:bg-ink-hi/[0.06] transition-all duration-150 ${
              query.trim() !== "" ? "pr-[104px]" : "pr-[72px]"
            }`}
          />
          {/* Type-ahead dropdown — BitChord mobile's model: the typed query
              plus plain text completions, no artwork rows while typing. */}
          {suggestOpen && suggests.length > 0 && (
            <div
              className="absolute left-0 right-0 top-full mt-2 z-50 glass-strong-solid rounded-2xl p-1.5 shadow-float max-h-[420px] overflow-y-auto animate-pop-in"
              role="listbox"
              aria-label={T("Search suggestions")}
            >
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => submitSearch(query)}
                className={`w-full flex items-center gap-3 px-2.5 h-11 rounded-lg text-left transition-colors ${
                  activeIdx === 0 ? "bg-ink-hi/[0.08]" : "hover:bg-ink-hi/[0.06]"
                }`}
              >
                <Search className="w-4 h-4 text-ink-hi/55 shrink-0" />
                <span className="text-[14px] font-medium text-ink-hi truncate">{T("Search “{trim}”", { trim: query.trim() })}</span>
              </button>
              {suggests.map((s, i) => (
                <button
                  key={`${s.text}-${i}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => submitSearch(s.text)}
                  className={`w-full flex items-center gap-3 px-2.5 h-11 rounded-lg text-left transition-colors ${
                    activeIdx === i + 1 ? "bg-ink-hi/[0.08]" : "hover:bg-ink-hi/[0.06]"
                  }`}
                >
                  <Search className="w-4 h-4 text-ink-hi/55 shrink-0" />
                  <span className="min-w-0 flex-1 text-[14px] text-ink-hi truncate">{s.text}</span>
                  <CornerDownLeft className="w-4 h-4 text-ink-hi/35 shrink-0" />
                </button>
              ))}
            </div>
          )}
          {/* Recent searches — BitChord mobile's model: an empty focused field
              drops the history list, with a clear-all in the header and a
              per-row ✕. Choosing a row runs that search. */}
          {historyOpen && (
            <div
              className="absolute left-0 right-0 top-full mt-2 z-50 glass-strong-solid rounded-2xl p-1.5 shadow-float max-h-[420px] overflow-y-auto animate-pop-in"
              role="listbox"
              aria-label={T("Recent searches")}
            >
              <div className="flex items-center justify-between pl-3 pr-1.5 h-9">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-hi/45">{T("Recent searches")}</span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearSearches}
                  className="px-2 h-6 rounded-full text-[11.5px] text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
                >{T("Clear all")}</button>
              </div>
              {recents.map((q) => (
                <div
                  key={q}
                  /* Whole row is the click target: the inner button only spans
                     its content height, so the rest of the highlighted row
                     showed the arrow cursor and ate clicks. */
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => submitSearch(q)}
                  className="group w-full flex cursor-pointer items-center gap-3 pl-2.5 pr-1.5 h-11 rounded-lg hover:bg-ink-hi/[0.06] transition-colors"
                >
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      submitSearch(q);
                    }}
                    className="min-w-0 flex-1 flex items-center gap-3 text-left cursor-pointer"
                  >
                    <History className="w-4 h-4 text-ink-hi/55 shrink-0" />
                    <span className="text-[14px] text-ink-hi truncate">{q}</span>
                  </button>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSearch(q);
                    }}
                    title={T("Remove")}
                    aria-label={T("Remove \"{q}\" from recent searches", { q })}
                    className="p-1.5 rounded-full text-ink-hi/35 hover:text-ink-hi hover:bg-ink-hi/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Spotify's right side of the field: clear (once there's text), a
              hairline divider, and the Explore button — the whole library as
              sortable lists of albums, artists and genres. Clearing from the
              results view would leave the empty search shell behind, so it
              hops home instead; from any other view it just wipes the field
              and stays put. */}
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2.5">
            {query.trim() !== "" && (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery("");
                  closeDropdown();
                  setSuggests([]);
                  setFieldFocused(false);
                  inputRef.current?.blur();
                  if (view.name === "search") navigate({ name: "home" });
                }}
                title={T("Clear search")}
                aria-label={T("Clear search")}
                className="p-1.5 rounded-full text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
              >
                <X className="w-[18px] h-[18px]" />
              </button>
            )}
            <div className="h-6 w-px bg-ink-hi/20" />
            <button
              onClick={() => navigate({ name: "explore" })}
              title={T("Explore your library")}
              aria-label={T("Explore")}
              className={`p-1.5 rounded-full transition-colors ${
                view.name === "explore" || view.name === "genre"
                  ? "text-ink-hi bg-ink-hi/[0.10]"
                  : "text-ink-hi/70 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
              }`}
            >
              <VinylIcon className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>

      {/* Right cluster — the library sources and the settings gear, then
          (Windows only) the renderer-drawn caption buttons flush to the
          window edge. macOS uses the native traffic lights, so nothing is
          drawn there. */}
      <div className="ml-auto h-full flex items-center gap-1 shrink-0">
        <SourcesAndSettings />
        {!isMac && <CaptionButtons />}
      </div>
    </div>
  );
}
