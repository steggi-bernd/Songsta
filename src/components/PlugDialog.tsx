/**
 * Where a device is plugged in: which receiver, chosen first and already chosen when there's only one,
 * then which of its inputs. A TV can also be paired here, so it goes off along with the rest.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Crosshair, X } from "lucide-react";
import { canSwitchOff, inputCode, inputName, looksLikeTv, RECEIVER_INPUTS } from "../lib/devicePower";
import { pairTv, plugInto, plugIntoWhereItIs, unplug } from "../lib/deviceSwitchOff";
import { T } from "../lib/i18n";
import type { CastDevice } from "../lib/cast";
import { useSettings } from "../stores/settings";

export function PlugDialog({ device, devices, nameOf, onClose }: { device: CastDevice; devices: CastDevice[]; nameOf: (d: CastDevice) => string; onClose: () => void }) {
  const receivers = devices.filter((d) => canSwitchOff(d.model));
  const link = useSettings((s) => s.deviceLinks).find((l) => l.device === device.id);
  const paired = useSettings((s) => s.pairedTvs).includes(device.id);
  const [receiverId, setReceiverId] = useState(link?.receiver ?? receivers[0]?.id ?? "");
  const receiver = receivers.find((r) => r.id === receiverId);
  const chosen = link && link.receiver === receiverId ? inputCode(link.input) : null;
  const inputs = [...RECEIVER_INPUTS];
  if (chosen && !inputs.some((i) => i.code === chosen)) inputs.push({ code: chosen, name: inputName(chosen) });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const row = "flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[13.5px] text-ink-hi transition-colors hover:bg-ink-hi/[0.08]";
  const take = (input: string): void => {
    if (receiver) plugInto(device.id, receiver.id, input);
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[115] grid place-items-center animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px]" aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={T("Plugged into a receiver")} className="relative max-h-[calc(100vh-64px)] w-[min(420px,calc(100vw-48px))] overflow-y-auto rounded-2xl glass-strong p-5 animate-pop-in">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 font-display text-lg font-bold tracking-tight text-ink-hi">{T("Where is {device} plugged in?", { device: nameOf(device) })}</h2>
          <button onClick={onClose} title={T("Close")} aria-label={T("Close")} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-dim transition-colors hover:text-ink-hi">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-dim">{T("Receiver")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {receivers.map((r) => (
            <button
              key={r.id}
              onClick={() => setReceiverId(r.id)}
              aria-pressed={r.id === receiverId}
              className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${r.id === receiverId ? "bg-primary text-on-primary" : "bg-ink-hi/[0.08] text-ink-hi hover:bg-ink-hi/[0.14]"}`}
            >
              {r.id === receiverId && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
              {nameOf(r)}
            </button>
          ))}
        </div>

        <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-dim">{T("Input")}</p>
        <div className="mt-1">
          <button
            className={row}
            onClick={() => {
              if (receiver) void plugIntoWhereItIs(device.id, receiver.id);
              onClose();
            }}
          >
            <Crosshair className="h-4 w-4 shrink-0 text-ink-dim" />
            {T("The input it's on right now")}
          </button>
          {inputs.map((i) => (
            <button key={i.code} className={row} onClick={() => take(i.code)}>
              <span className="grid h-4 w-4 shrink-0 place-items-center">{chosen === i.code && <Check className="h-4 w-4 text-accent" strokeWidth={3} />}</span>
              <span className={chosen === i.code ? "font-semibold text-accent" : ""}>{i.name}</span>
            </button>
          ))}
        </div>

        {looksLikeTv(device) && (
          <div className="mt-3 flex items-center gap-3 border-t border-ink-hi/[0.08] pt-3">
            <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-dim">
              {paired ? T("{device} goes off along with the receiver.", { device: nameOf(device) }) : T("Pair {device} once, and it goes off along with the receiver.", { device: nameOf(device) })}
            </p>
            <button
              className="h-8 shrink-0 rounded-full bg-ink-hi/[0.08] px-3.5 text-[12.5px] font-semibold text-ink-hi transition-colors hover:bg-ink-hi/[0.14]"
              onClick={() => {
                onClose();
                void pairTv(device);
              }}
            >
              {paired ? T("Pair again") : T("Pair")}
            </button>
          </div>
        )}

        {link && (
          <button
            className="mt-3 h-9 w-full rounded-xl text-[13px] font-semibold text-ink-dim transition-colors hover:bg-ink-hi/[0.08] hover:text-ink-hi"
            onClick={() => {
              unplug(device.id);
              onClose();
            }}
          >
            {T("Not plugged in there")}
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
