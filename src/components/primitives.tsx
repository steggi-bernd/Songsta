/**
 * ByTune design-system primitives.
 *
 * Every view composes from here so spacing, typography, states and surfaces
 * stay consistent across the entire application.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Music2, Pause, Play, Split, X, type LucideIcon } from "lucide-react";
import { upgradeArtwork } from "../lib/artwork";
import { useBranchChosen } from "../stores/player";
import { useUI } from "../stores/ui";

/* ============================================================ layout */

/** Standard padded page container. */
/** On a song chosen to branch off from, until it comes on. */
export function BranchMark({ id }: { id: string }) {
  const chosen = useBranchChosen(id);
  if (!chosen) return null;
  return (
    <span title={T("The branch starts here")} className="shrink-0 text-accent">
      <Split className="h-3.5 w-3.5" aria-label={T("The branch starts here")} />
    </span>
  );
}

/** Section heading for horizontal shelves. */
export function Shelf({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="animate-slide-up">
      <div className="flex items-end justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2 className="font-display text-[21px] font-extrabold tracking-tight text-ink-hi leading-tight">{title}</h2>
          {subtitle && <p className="text-[13px] text-ink-faint mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ============================================================ shelf arrows */

/**
 * Horizontal card row with Spotify-style hover arrows, running from one edge
 * of the content panel to the other: the first cover lines up with the page,
 * the cards go on until the panel ends. Scrolling itself stays native —
 * trackpad, wheel, touch — the arrows are a hover affordance that page
 * through the shelf in card-aligned steps, popping in from the edges only for
 * directions that still have content to show.
 *
 * The wrapper is a named group (`group/shelf`) so the arrows' show/hide
 * variants never bleed into the cards' own `group-hover` states.
 */
export function ShelfScroller({
  children,
  arrowTop = "top-[74px]",
  className = "",
}: {
  children: ReactNode;
  /** Arrow band position — defaults to the cover line's centre for the home cards (8px pad + 168px square). */
  arrowTop?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => {
      const max = el.scrollWidth - el.clientWidth;
      setCanLeft(el.scrollLeft > 2);
      setCanRight(max > 2 && el.scrollLeft < max - 2);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // Card widths are fixed, so the scrollable range only moves when the row
    // itself resizes or items are added/removed.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  /**
   * One press = one page of cards; uniform-width rows land card-aligned: the
   * cards fully in view move out, the one cut off by the panel's edge comes first.
   */
  const page = (dir: 1 | -1): void => {
    const el = ref.current;
    if (!el) return;
    const rects = Array.from(el.children, (c) => (c as HTMLElement).getBoundingClientRect());
    const pitches = rects.slice(1).map((r, i) => r.left - rects[i].left);
    const pitch = pitches.length ? Math.min(...pitches) : 0;
    const uniform = pitch > 0 && Math.max(...pitches) - pitch < 2;
    const gap = uniform ? pitch - rects[0].width : 0;
    const margin = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    const step = uniform
      ? Math.max(1, Math.floor((el.clientWidth - margin + gap) / pitch)) * pitch
      : el.clientWidth * 0.9;
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  const arrow = (dir: 1 | -1) => {
    const can = dir === 1 ? canRight : canLeft;
    const Icon = dir === 1 ? ChevronRight : ChevronLeft;
    return (
      <div
        className={`pointer-events-none absolute z-20 ${
          dir === 1 ? "right-4 translate-x-1" : "left-4 -translate-x-1"
        } ${arrowTop} scale-75 opacity-0 transition-all duration-200 ease-out ${
          can ? "" : "hidden"
        } group-hover/shelf:pointer-events-auto group-hover/shelf:translate-x-0 group-hover/shelf:scale-100 group-hover/shelf:opacity-100 group-focus-within/shelf:pointer-events-auto group-focus-within/shelf:translate-x-0 group-focus-within/shelf:scale-100 group-focus-within/shelf:opacity-100`}
      >
        <button
          type="button"
          aria-label={dir === 1 ? T("Scroll shelf right") : T("Scroll shelf left")}
          onClick={() => page(dir)}
          className="grid h-9 w-9 cursor-pointer place-items-center rounded-full border border-white/10 bg-black/65 text-ink-hi shadow-elev transition-all duration-150 ease-out hover:scale-110 hover:bg-black/85 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <Icon className="h-[18px] w-[18px]" strokeWidth={2.5} />
        </button>
      </div>
    );
  };

  return (
    <div className={`group/shelf relative page-bleed ${className}`}>
      <div ref={ref} className="shelf-row flex gap-4 overflow-x-auto pb-2 shelf-scroll">
        {children}
      </div>
      {arrow(-1)}
      {arrow(1)}
    </div>
  );
}

/* ============================================================ artwork */

/**
 * Artwork with lazy loading and a graceful fallback — never a broken image,
 * never a layout shift.
 */
export function Artwork({
  src,
  alt = "",
  className = "",
  iconClassName = "w-5 h-5",
  rounded = "rounded-lg",
}: {
  src?: string;
  alt?: string;
  className?: string;
  iconClassName?: string;
  rounded?: string;
}) {
  const [failed, setFailed] = useState(false);
  // Original quality even for covers cached before the quality fix — small
  // placeholder URLs heal on sight instead of upscaling a 60px image.
  const displaySrc = upgradeArtwork(src);
  useEffect(() => setFailed(false), [displaySrc]);

  if (!displaySrc || failed) {
    return (
      <div className={`grid place-items-center bg-ink-hi/[0.04] art-hairline ${rounded} ${className}`}>
        <Music2 className={`${iconClassName} text-ink-ghost`} />
      </div>
    );
  }
  return (
    <img
      src={displaySrc}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className={`object-cover bg-ink-hi/[0.04] art-hairline ${rounded} ${className}`}
    />
  );
}

/* ============================================================ buttons */

type BtnVariant = "accent" | "white" | "glass" | "ghost" | "danger";

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 font-medium transition-all duration-150 select-none disabled:opacity-40 disabled:pointer-events-none active:scale-[0.98] cursor-pointer";

const BTN_VARIANTS: Record<BtnVariant, string> = {
  accent: "bg-accent text-on-primary shadow-elev hover:brightness-110 rounded-full",
  white: "bg-primary text-on-primary hover:brightness-110 rounded-full",
  glass: "glass text-ink hover:bg-ink-hi/[0.06] rounded-full",
  ghost: "text-ink-dim hover:text-ink-hi hover:bg-ink-hi/[0.05] rounded-full",
  danger: "border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-xl",
};

const BTN_SIZES = {
  sm: "h-8 px-3.5 text-[13px]",
  md: "h-9 px-4 text-[13px]",
  lg: "h-11 px-5 text-sm",
};

export function Btn({
  variant = "glass",
  size = "md",
  icon: Icon,
  children,
  className = "",
  ...rest
}: {
  variant?: BtnVariant;
  size?: keyof typeof BTN_SIZES;
  icon?: LucideIcon;
  children?: ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`${BTN_BASE} ${BTN_VARIANTS[variant]} ${BTN_SIZES[size]} ${className}`} {...rest}>
      {Icon && <Icon className={size === "lg" ? "w-[18px] h-[18px]" : "w-4 h-4"} />}
      {children}
    </button>
  );
}

/** Square icon-only button with the standard hover treatment. */
export function IconBtn({
  icon: Icon,
  title,
  active,
  danger,
  onClick,
  className = "",
  size = "md",
  type,
  disabled,
}: {
  icon: LucideIcon;
  title: string;
  active?: boolean;
  danger?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  size?: "sm" | "md";
  /** "button" inside a form, where a button otherwise submits it */
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const dim = size === "sm" ? "p-1.5" : "p-2";
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`${dim} rounded-lg transition-all active:scale-90 disabled:opacity-30 disabled:pointer-events-none ${className} ${
        active
          ? "text-accent bg-accent/10"
          : danger
            ? "text-ink-faint hover:text-red-400 hover:bg-ink-hi/[0.06]"
            : "text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.06]"
      }`}
    >
      <Icon className={size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4"} />
    </button>
  );
}

/* ============================================================ pills */

export interface PillOption<K extends string> {
  key: K;
  label: string;
  count?: number;
  icon?: LucideIcon;
}

/**
 * A single glass pill — the "bit of chrome with a label and optional icon"
 * the top bar, right-rail tab strip and library filters all use.
 * Mobile equivalent: `Common.kt:618-646` SignInBanner-style surfaces, the
 * segmented "Show all" / Queue / Lyrics header.
 */
export function Pill({
  active,
  onClick,
  icon: Icon,
  children,
  size = "md",
  className = "",
}: {
  active?: boolean;
  onClick?: () => void;
  icon?: LucideIcon;
  children?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}) {
  const sizing = size === "sm" ? "h-7 px-3 text-[12px]" : "h-8 px-3.5 text-[13px]";
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition-all duration-150 select-none active:scale-[0.97] ${sizing} ${
        active
          ? "bg-primary text-on-primary shadow-elev"
          : "bg-ink-hi/[0.06] text-ink-hi/65 hover:bg-ink-hi/[0.10] hover:text-ink-hi"
      } ${className}`}
    >
      {Icon && <Icon className={size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4"} />}
      {children}
    </button>
  );
}

/** Segmented filter pills (search filters, library tabs). */
export function Pills<K extends string>({
  options,
  value,
  onChange,
  size = "md",
}: {
  options: PillOption<K>[];
  value: K;
  onChange: (k: K) => void;
  size?: "sm" | "md";
}) {
  const sizing = size === "sm" ? "h-8 px-3 text-[13px]" : "h-8 px-3.5 text-[13px]";
  const spacing = "gap-1.5";
  return (
    <div className={`flex items-center ${spacing}`}>
      {options.map((opt) => {
        const active = opt.key === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.key}
            onClick={() => onChange(opt.key)}
            className={`flex items-center ${spacing} ${sizing} rounded-full whitespace-nowrap font-medium transition-all duration-150 active:scale-[0.97] ${
              active
                ? "bg-primary text-on-primary shadow-elev"
                : "text-ink-dim bg-ink-hi/[0.045] hover:bg-ink-hi/[0.09] hover:text-ink"
            }`}
          >
            {Icon && <Icon className="w-4 h-4 shrink-0" />}
            {opt.label}
            {typeof opt.count === "number" && <span className={`ml-1.5 text-xs ${active ? "opacity-60" : "opacity-50"}`}>{opt.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================ states */

/** Designed empty state: icon, explanation, optional next action. */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className = "",
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`py-16 flex flex-col items-center text-center animate-fade-in ${className}`}>
      <div className="relative w-16 h-16 rounded-2xl glass grid place-items-center mb-5 overflow-hidden">
        <div className="absolute inset-0 bg-accent/[0.08]" aria-hidden />
        <Icon className="w-7 h-7 text-accent relative" />
      </div>
      <h3 className="text-[15px] font-semibold text-ink-hi">{title}</h3>
      {body && <p className="text-[13px] text-ink-dim mt-1.5 max-w-sm leading-relaxed">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Human-readable error with a retry path — never raw exceptions. */
export function ErrorState({
  title = T("Something went wrong"),
  body,
  onRetry,
  retryLabel = T("Try again"),
  className = "",
}: {
  title?: string;
  body?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={`py-14 flex flex-col items-center text-center ${className}`}
      role="alert"
    >
      <div className="relative w-16 h-16 rounded-2xl glass grid place-items-center mb-5 overflow-hidden">
        <div className="absolute inset-0 bg-amber-500/[0.08]" aria-hidden />
        <AlertTriangle className="w-7 h-7 text-amber-400 relative" />
      </div>
      <h3 className="text-[15px] font-semibold text-ink-hi">{title}</h3>
      {body && <p className="text-[13px] text-ink-dim mt-1.5 max-w-sm leading-relaxed">{body}</p>}
      {onRetry && (
        <Btn variant="glass" className="mt-5" onClick={onRetry}>
          {retryLabel}
        </Btn>
      )}
    </div>
  );
}

/* ============================================================ skeletons */

export function CardSkeleton({ width = "w-44" }: { width?: string }) {
  return (
    <div className={`${width} shrink-0 rounded-xl bg-ink-hi/[0.03] p-3`}>
      <div className="skeleton w-full aspect-square rounded-lg" />
      <div className="skeleton h-3.5 rounded-md mt-3 w-[85%]" />
      <div className="skeleton h-3 rounded-md mt-2 w-[55%]" />
    </div>
  );
}

export function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 h-[52px] px-3">
      <div className="skeleton w-10 h-10 rounded-lg" />
      <div className="flex-1">
        <div className="skeleton h-3.5 rounded-md w-[38%]" />
        <div className="skeleton h-3 rounded-md w-[22%] mt-2" />
      </div>
      <div className="skeleton h-3 w-10 rounded-md" />
    </div>
  );
}

/* ============================================================ badges */

/* ============================================================ equalizer */

const EQ_CYCLE_MS = 900;
const EQ_STEP_MS = 125;
const eqBars = new Set<HTMLElement>();
let eqTimer: number | undefined;

function moveEqBars(): void {
  if (document.hidden || document.documentElement.classList.contains("reduce-motion")) return;
  const now = performance.now();
  for (const bar of eqBars) {
    const turn = (now - Number(bar.dataset.eqAfter)) / EQ_CYCLE_MS;
    bar.style.transform = `scaleY(${(0.675 - 0.325 * Math.cos(2 * Math.PI * turn)).toFixed(3)})`;
  }
}

/**
 * Animated "now playing" indicator. One timer moves all of them a few times a second: as a CSS
 * animation these tiny bars kept the graphics process drawing at the screen's full rate, which
 * cost more than playing the music.
 */
export function EqBars() {
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const bars = [...(root.current?.children ?? [])] as HTMLElement[];
    for (const bar of bars) eqBars.add(bar);
    eqTimer ??= window.setInterval(moveEqBars, EQ_STEP_MS);
    moveEqBars();
    return () => {
      for (const bar of bars) eqBars.delete(bar);
      if (!eqBars.size) {
        window.clearInterval(eqTimer);
        eqTimer = undefined;
      }
    };
  }, []);
  return (
    <span ref={root} className="flex items-end gap-0.5 h-3.5" aria-label={T("Playing")}>
      <span className="eq-bar w-0.5 h-full rounded-sm bg-accent" data-eq-after="0" />
      <span className="eq-bar w-0.5 h-full rounded-sm bg-accent" data-eq-after="160" />
      <span className="eq-bar w-0.5 h-full rounded-sm bg-accent" data-eq-after="320" />
    </span>
  );
}

/**
 * Accent play button that reveals when hovering its card (parent needs
 * `group`). While hidden it is hit-test-transparent: an invisible button
 * parked over the artwork's corner would otherwise win the pointer on those
 * pixels, so drags started from the corner/edge would hit the control
 * instead of the card and the drag would never start. While its collection
 * plays it shows pause and stays visible, Spotify's way.
 */
export function PlayOverlay({ onClick, title = T("Play"), playing = false }: { onClick: () => void; title?: string; playing?: boolean }) {
  const label = playing ? T("Pause") : title;
  return (
    <button
      title={label}
      aria-label={label}
      data-no-drag
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`absolute bottom-2.5 right-2.5 w-11 h-11 rounded-full bg-primary text-on-primary grid place-items-center shadow-float transition-all duration-200 hover:scale-105 active:scale-95 ${
        playing
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-1.5 pointer-events-none group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:translate-y-0 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:translate-y-0 focus-visible:pointer-events-auto"
      }`}
    >
      {playing ? <Pause className="w-[18px] h-[18px] fill-current" /> : <Play className="w-[18px] h-[18px] fill-current ml-0.5" />}
    </button>
  );
}

/* ============================================================ dialog */

/**
 * Glass modal replacing browser prompt()/confirm().
 * Escape cancels, Enter confirms, backdrop click cancels.
 */
export function Dialog() {
  const req = useUI((s) => s.dialog);
  const closeDialog = useUI((s) => s.closeDialog);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const close = useCallback((): void => closeDialog(), [closeDialog]);
  const cancel = useCallback((): void => {
    useUI.getState().dialog?.onCancel?.();
    closeDialog();
  }, [closeDialog]);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        // One keystroke must not confirm the dialog AND activate whatever
        // control behind it the focus chain reached (e.g. the search field's
        // submit) — the dialog is the topmost layer.
        e.stopPropagation();
        const value = req.initialValue !== undefined ? (inputRef.current?.value ?? req.initialValue) : "";
        req.onConfirm(value);
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // focus the input (or the panel) on open
    const t = window.setTimeout(() => {
      if (req.initialValue !== undefined) inputRef.current?.select();
      else inputRef.current?.focus();
    }, 30);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(t);
    };
  }, [req, close, cancel]);

  if (!req) return null;
  const hasInput = req.initialValue !== undefined;

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px]" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        className="relative w-[min(420px,calc(100vw-48px))] rounded-2xl glass-strong p-6 animate-pop-in"
        tabIndex={-1}
        ref={(el) => {
          if (el && !hasInput) el.focus();
        }}
      >
        <h2 className={`font-display text-lg font-bold tracking-tight ${req.danger ? "text-red-300" : "text-ink-hi"}`}>
          {req.title}
        </h2>
        {req.body && <p className="text-[13px] text-ink-dim mt-1.5 leading-relaxed">{req.body}</p>}

        {hasInput && (
          <input
            ref={inputRef}
            type="text"
            defaultValue={req.initialValue}
            placeholder={req.placeholder}
            className="mt-4 w-full h-10 px-3.5 rounded-xl bg-ink-hi/[0.06] border border-ink-hi/10 text-sm text-ink placeholder:text-ink-ghost outline-none focus:border-accent/60 transition-colors"
          />
        )}

        <div className="flex items-center justify-end gap-2 mt-6">
          <Btn variant="ghost" size="md" className="!rounded-xl" onClick={cancel}>
            {req.cancelLabel ?? T("Cancel")}
          </Btn>
          <button
            onClick={() => {
              const value = hasInput ? (inputRef.current?.value ?? req.initialValue ?? "") : "";
              req.onConfirm(value);
              close();
            }}
            className={`${BTN_BASE} h-9 px-4 text-[13px] rounded-xl ${
              req.danger
                ? "bg-red-500 text-ink-hi hover:bg-red-400"
                : "bg-accent text-on-primary hover:brightness-110"
            }`}
          >
            {req.confirmLabel ?? (req.danger ? T("Delete") : T("Confirm"))}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ palette hook */

import { useArtworkPalette as usePageArtworkPalette } from "../lib/palette";
import { T } from "../lib/i18n";
export { usePageArtworkPalette as useArtworkPaletteV2 };

/** Per-page ArtworkPalette (delegates to lib/palette.ts). Returns the new
 *  mobile-faithful palette shape; kept for any view that wants to consume it
 *  directly. Old call sites using `Palette` from `lib/ambient` still work. */
export function useArtworkPalette(url: string | undefined | null) {
  return usePageArtworkPalette(url ?? null);
}

/** The X at the end of a search field. The field needs room for it on its right. */
export function SearchClear({ value, onClear }: { value: string; onClear: () => void }) {
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      title={T("Clear the search")}
      aria-label={T("Clear the search")}
      className="absolute right-2 top-1/2 -translate-y-1/2 grid h-6 w-6 place-items-center rounded-full text-ink-dim transition-colors hover:bg-ink-hi/[0.08] hover:text-ink-hi"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}
