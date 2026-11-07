/**
 * Slider — the player's scrubbers and volume bars, Spotify's model: a 12px
 * hit area around a thin line, the fill ending exactly under the handle (the
 * handle overhangs the line's ends instead of eating into it), and the
 * handle showing on hover, focus and while dragging.
 *
 * Smoothness is the point of owning this instead of an <input type=range>:
 *  - dragging is pointer-captured and paints straight onto the DOM — no React
 *    render per pointer move, and no snapping to an input's step grid
 *  - `live` lets the seek bar follow the audio clock instead of the store's
 *    ~4 Hz position updates, so the fill glides instead of ticking. It only
 *    paints when the fill has moved by a part of a pixel that can show: over a
 *    whole song that's a few times a second, and the app rests in between
 *  - keyboard steps stop propagation, so the global seek/volume shortcuts
 *    never act a second time on the same key
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { nextLook, smallestMove } from "../lib/seekBarPace";

interface SliderProps {
  /** 0..1 */
  value: number;
  /** 0..1 — buffered region behind the fill (seek bars) */
  buffered?: number;
  /** every pointer move while dragging, and every keyboard step */
  onChange?: (v: number) => void;
  /** once on release, and on every keyboard step */
  onCommit?: (v: number) => void;
  /** the drag position while dragging, null once released (time labels follow it) */
  onScrub?: (v: number | null) => void;
  /** read while set, as often as the fill can visibly move — it follows this (the audio clock) */
  live?: () => number;
  label: string;
  valueText?: string;
  /** keyboard step, 0..1 */
  step?: number;
  size?: "bar" | "mini";
  disabled?: boolean;
  className?: string;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function Slider({
  value,
  buffered,
  onChange,
  onCommit,
  onScrub,
  live,
  label,
  valueText,
  step = 0.02,
  size = "bar",
  disabled = false,
  className = "",
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  /** the drag position, null while not dragging */
  const dragRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const paint = (v: number): void => {
    const pct = `${clamp01(v) * 100}%`;
    if (fillRef.current) fillRef.current.style.width = pct;
    if (thumbRef.current) thumbRef.current.style.left = pct;
  };

  // At rest the fill shows `value`; a live clock paints it instead while set.
  useLayoutEffect(() => {
    if (dragRef.current === null && !live) paint(value);
  });

  useEffect(() => {
    if (!live) return;
    let raf = 0;
    let timer = 0;
    let shown = Number.NaN;
    let shownAt = 0;
    let wait = 0;
    const look = (now: number): void => {
      if (dragRef.current === null) {
        const v = live();
        const step = nextLook(Math.abs(v - shown), smallestMove(trackRef.current?.clientWidth ?? 0, window.devicePixelRatio), now - shownAt, wait);
        wait = step.waitMs;
        if (step.paint) {
          paint(v);
          shown = v;
          shownAt = now;
        }
      }
      timer = window.setTimeout(() => {
        raf = window.requestAnimationFrame(look);
      }, wait);
    };
    raf = window.requestAnimationFrame(look);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(raf);
    };
  }, [live]);

  const at = (clientX: number): number => {
    const r = trackRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? clamp01((clientX - r.left) / r.width) : 0;
  };

  const move = (v: number): void => {
    dragRef.current = v;
    paint(v);
    onScrub?.(v);
    onChange?.(v);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return;
    // preventDefault also keeps the click from focusing the slider: the
    // arrow keys stay with the global seek/volume shortcuts (keyboard users
    // reach it with Tab, and then the arrows move it).
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    move(at(e.clientX));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    const v = at(e.clientX);
    if (v !== dragRef.current) move(v);
  };

  const end = (commit: boolean): void => {
    const v = dragRef.current;
    if (v === null) return;
    dragRef.current = null;
    setDragging(false);
    onScrub?.(null);
    if (commit) onCommit?.(v);
    else paint(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const current = dragRef.current ?? value;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = current + step;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = current - step;
        break;
      case "PageUp":
        next = current + 0.1;
        break;
      case "PageDown":
        next = current - 0.1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const v = clamp01(next);
    onChange?.(v);
    onCommit?.(v);
  };

  const line = size === "mini" ? "h-[3px]" : "h-1";
  const knob = size === "mini" ? "h-2.5 w-2.5" : "h-3 w-3";
  const knobShown = dragging ? "opacity-100 scale-100" : "opacity-0 scale-50 group-hover/slider:opacity-100 group-hover/slider:scale-100 group-focus-visible/slider:opacity-100 group-focus-visible/slider:scale-100";

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamp01(value) * 100)}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => end(true)}
      onKeyDown={onKeyDown}
      className={`group/slider relative flex h-3 items-center touch-none select-none outline-none ${
        disabled ? "pointer-events-none opacity-40" : "cursor-pointer"
      } ${className}`}
    >
      <div ref={trackRef} className={`relative w-full ${line} rounded-full bg-white/30`}>
        {buffered !== undefined && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white/20"
            style={{ width: `${clamp01(buffered) * 100}%` }}
          />
        )}
        <div ref={fillRef} className="absolute inset-y-0 left-0 rounded-full bg-white" />
      </div>
      <div
        ref={thumbRef}
        className={`pointer-events-none absolute top-1/2 ${knob} -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.5)] transition-[opacity,transform] duration-100 ${knobShown}`}
      />
    </div>
  );
}
