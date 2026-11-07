/**
 * How far ahead a device plays when several play together: for one that still sounds behind the
 * others however close Songsta gets them, a receiver that works on the sound, say. Both ways, in steps.
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, X } from "lucide-react";
import type { CastDevice } from "../lib/cast";
import { PLAY_AHEAD_MAX_MS, PLAY_AHEAD_STEP_MS } from "../lib/groupSync";
import { T } from "../lib/i18n";
import { useSettings } from "../stores/settings";

export function playAheadText(ms: number): string {
  if (!ms) return T("On time");
  return ms > 0 ? T("{ms} ms earlier", { ms }) : T("{ms} ms later", { ms: -ms });
}

export function TimingDialog({ device, name, onClose }: { device: CastDevice; name: string; onClose: () => void }) {
  const ms = useSettings((s) => s.playAhead[device.id] ?? 0);
  const setPlayAhead = useSettings((s) => s.setPlayAhead);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const to = (value: number): void => setPlayAhead(device.id, Math.max(-PLAY_AHEAD_MAX_MS, Math.min(PLAY_AHEAD_MAX_MS, value)));
  const step = "grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink-hi/[0.08] text-ink-hi transition-colors hover:bg-ink-hi/[0.14] disabled:opacity-35";

  return createPortal(
    <div
      className="fixed inset-0 z-[115] grid place-items-center animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px]" aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={T("Timing of {device}", { device: name })} className="relative w-[min(400px,calc(100vw-48px))] rounded-2xl glass-strong p-5 animate-pop-in">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 font-display text-lg font-bold tracking-tight text-ink-hi">{T("Timing of {device}", { device: name })}</h2>
          <button onClick={onClose} title={T("Close")} aria-label={T("Close")} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-dim transition-colors hover:text-ink-hi">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 text-[13px] leading-snug text-ink-dim">
          {T("When several devices play together and {device} sounds behind the others, play it earlier. If it's ahead, play it later.", { device: name })}
        </p>

        <div className="mt-5 flex items-center gap-3">
          <button className={step} onClick={() => to(ms - PLAY_AHEAD_STEP_MS)} disabled={ms <= -PLAY_AHEAD_MAX_MS} title={T("Later")} aria-label={T("Later")}>
            <Minus className="h-5 w-5" />
          </button>
          <p className="min-w-0 flex-1 text-center text-[17px] font-bold tabular-nums text-ink-hi" aria-live="polite">
            {playAheadText(ms)}
          </p>
          <button className={step} onClick={() => to(ms + PLAY_AHEAD_STEP_MS)} disabled={ms >= PLAY_AHEAD_MAX_MS} title={T("Earlier")} aria-label={T("Earlier")}>
            <Plus className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-1.5 flex justify-between px-1 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-dim" aria-hidden>
          <span>{T("Later")}</span>
          <span>{T("Earlier")}</span>
        </div>

        <p className="mt-4 text-[12px] leading-snug text-ink-dim">{T("Once one device is set, Songsta keeps the group closer together, with a short gap on a device now and then.")}</p>
        {/* Always there, so nothing moves under the pointer after the first step. */}
        <button
          className="mt-3 h-9 w-full rounded-xl text-[13px] font-semibold text-ink-dim transition-colors enabled:hover:bg-ink-hi/[0.08] enabled:hover:text-ink-hi disabled:opacity-35"
          disabled={ms === 0}
          onClick={() => to(0)}
        >
          {T("Back to on time")}
        </button>
      </div>
    </div>,
    document.body
  );
}
