/**
 * The notes, as on the phone (the user's pick from the mockups, "Hinweise A", 2026-11-17): a calm dark
 * card in the middle of the page, just above the player. The text, at most one action in the accent,
 * and a thin bar only where a real deadline runs (a device switching off). A green, red or amber dot
 * says success, a problem or a warning; nothing glows. A newer note pushes the older ones behind it,
 * smaller; pointing at the stack fans it out and holds the notes' own countdowns.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useUI, type Toast } from "../stores/ui";
import { T } from "../lib/i18n";

const DOT: Record<Toast["kind"], string | null> = { info: null, success: "#34d399", error: "#f87171", warning: "#fbbf24" };
/** How much of an older note peeks out above the newer one, and the room between them fanned out. */
const PEEK = 9;
const GAP = 8;

/** The middle of the page and its foot: the notes stand there, whatever the side panels take. */
function usePageSpot(): { x: number; bottom: number } {
  const [spot, setSpot] = useState(() => ({ x: window.innerWidth / 2, bottom: 110 }));
  useEffect(() => {
    const main = document.querySelector("main");
    const measure = (): void => {
      const r = main?.getBoundingClientRect();
      const next = r && r.width > 0 ? { x: Math.round(r.left + r.width / 2), bottom: Math.max(16, Math.round(window.innerHeight - r.bottom + 18)) } : { x: Math.round(window.innerWidth / 2), bottom: 110 };
      setSpot((old) => (old.x === next.x && old.bottom === next.bottom ? old : next));
    };
    measure();
    const watch = main ? new ResizeObserver(measure) : null;
    if (main) watch?.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      watch?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return spot;
}

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  const spot = usePageSpot();
  const [fanned, setFanned] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  useEffect(() => {
    if (!toasts.length) setFanned(false);
  }, [toasts.length]);
  if (!toasts.length) return null;

  // Newest first: it stands in front, at the foot; the older ones above and behind it.
  const shown = [...toasts].reverse();
  let above = 0;
  return (
    <div
      className="fixed z-[110] pointer-events-none"
      style={{ left: spot.x, bottom: spot.bottom }}
      aria-live="polite"
      onMouseEnter={() => setFanned(true)}
      onMouseLeave={() => setFanned(false)}
    >
      {shown.map((toast, depth) => {
        const y = fanned ? above : depth * PEEK;
        above += (heights[toast.id] ?? 46) + GAP;
        return (
          <NoteCard
            key={toast.id}
            toast={toast}
            depth={depth}
            lift={y}
            fanned={fanned}
            onHeight={(h) => setHeights((old) => (old[toast.id] === h ? old : { ...old, [toast.id]: h }))}
            onDone={() => dismiss(toast.id)}
          />
        );
      })}
    </div>
  );
}

function NoteCard({ toast, depth, lift, fanned, onHeight, onDone }: { toast: Toast; depth: number; lift: number; fanned: boolean; onHeight: (h: number) => void; onDone: () => void }) {
  const dot = DOT[toast.kind];
  // A real deadline counts down whatever the pointer does: the device goes off then anyway.
  const [startedLeft] = useState(() => (toast.endsAt ? Math.max(0, toast.endsAt - Date.now()) : 0));
  const deadline = !!toast.endsAt;
  const duration = deadline ? startedLeft : (toast.duration ?? 4600);
  const total = deadline ? Math.max(startedLeft, toast.duration ?? startedLeft) : duration;
  const held = fanned && !deadline;
  const [leaving, setLeaving] = useState(false);
  const remaining = useRef(duration);
  const startedAt = useRef(0);
  const closing = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (box.current) onHeight(box.current.offsetHeight);
  });

  const close = (): void => {
    if (closing.current) return;
    closing.current = true;
    setLeaving(true);
    window.setTimeout(onDone, 260);
  };

  // The countdown banks what's left whenever pointing at the stack holds it.
  useEffect(() => {
    if (held || closing.current) return;
    startedAt.current = performance.now();
    const t = window.setTimeout(close, remaining.current);
    return () => {
      window.clearTimeout(t);
      remaining.current -= performance.now() - startedAt.current;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held]);

  // Folded, an older note is a sliver behind the newer one; fanned out, each stands on its own.
  const behind = !fanned && depth > 0;
  const scale = behind ? Math.max(0.86, 1 - depth * 0.05) : 1;
  return (
    <div
      ref={box}
      role="status"
      className={`note-card group absolute bottom-0 left-0 flex items-center gap-3.5 min-w-[280px] max-w-[460px] w-max px-[18px] py-3 rounded-[14px] pointer-events-auto ${toast.action ? "" : "justify-center"} ${leaving ? "note-out" : "note-in"}`}
      style={{
        transform: `translate(-50%, ${-lift}px) scale(${scale})`,
        transformOrigin: "50% 100%",
        opacity: behind ? (depth > 2 ? 0 : 0.5) : 1,
        zIndex: 20 - depth,
        transition: "transform 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease",
      }}
    >
      {/* Without an action the text (with its dot) stands in the very middle of the card (the user's
          wish, 2026-11-17); with one, the text goes left and the action right, as on the phone. */}
      {toast.action ? (
        <>
          {dot && <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />}
          <p className="flex-1 min-w-0 text-left text-[13.5px] font-semibold text-white leading-snug select-none">{toast.message}</p>
          <button
            onClick={() => {
              toast.action?.run();
              close();
            }}
            className="shrink-0 text-[13.5px] font-extrabold text-accent hover:brightness-110 transition-[filter]"
          >
            {toast.action.label}
          </button>
        </>
      ) : (
        <span className="flex items-center justify-center gap-2.5 min-w-0">
          {dot && <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />}
          <p className="min-w-0 text-center text-[13.5px] font-semibold text-white leading-snug select-none">{toast.message}</p>
        </span>
      )}
      {/* The cross sits on the card's corner, so it takes no room from the text. */}
      <button
        onClick={close}
        className="note-close absolute -top-2 -right-2 w-5 h-5 rounded-full grid place-items-center text-white/60 hover:text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        title={T("Dismiss")}
        aria-label={T("Dismiss notification")}
      >
        <X className="w-3 h-3" strokeWidth={2.6} />
      </button>
      {deadline && (
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[14px] overflow-hidden">
          <span
            className="absolute bottom-0 left-0 right-0 h-[3px] origin-left bg-accent"
            style={{ transform: `scaleX(${total ? startedLeft / total : 0})`, animation: `toast-bar ${startedLeft}ms linear forwards` }}
          />
        </span>
      )}
    </div>
  );
}
