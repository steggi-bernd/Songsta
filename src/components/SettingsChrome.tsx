/**
 * Settings chrome (views/SettingsView.tsx, views/PrivacySettings.tsx): inset cards of rows. An uppercase
 * group header, a rounded card, glyph + title + optional subtitle on the left, a value/switch or chevron
 * on the right, and hairline dividers inset to the text column.
 */
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

const GROUP_INSET = "px-0"; // page padding comes from the view container
export const ROW_INSET = "px-4";
export const TEXT_INSET = "pl-[52px]"; // icon (22) + gap (14) + row inset (16)

export function SettingsGroup({ header, footer, children }: { header?: string; footer?: string; children: ReactNode }) {
  return (
    <section className="animate-slide-up" data-settings-group={header ?? ""}>
      {header && <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim px-1 pt-7 pb-2">{header}</h2>}
      {!header && <div className="pt-7" />}
      <div className={`rounded-[calc(14px*var(--radius-scale))] bg-panel overflow-hidden ${GROUP_INSET}`}>{children}</div>
      {footer && <p className="text-[12.5px] text-ink-dim px-1 pt-2 leading-relaxed">{footer}</p>}
    </section>
  );
}

export function Divider() {
  return <div className={`settings-divider h-px bg-ink-hi/[0.08] ${TEXT_INSET}`} />;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className={`relative shrink-0 w-[42px] h-[26px] rounded-full transition-colors duration-200 disabled:opacity-40 ${checked ? "bg-accent" : "bg-ink-hi/[0.16]"}`}
    >
      <span className={`absolute top-[3px] w-[20px] h-[20px] rounded-full transition-all duration-200 ${checked ? "left-[19px] bg-on-primary" : "left-[3px] bg-white"}`} />
    </button>
  );
}

export function Chevron() {
  return <ChevronRight className="w-5 h-5 text-ink-dim/70 shrink-0" />;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-ink-hi/90 rounded-[5px] bg-ink-hi/[0.16] px-1.5 py-0.5">{children}</span>;
}

/**
 * A row with buttons: they go under its text, so the text keeps its width in a narrow window; a switch
 * stays on the right. `breakAnywhere` lets a long path or address wrap anywhere.
 */
export function ActionRow({
  icon: Icon,
  title,
  subtitle,
  actions,
  trailing,
  breakAnywhere,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  trailing?: ReactNode;
  breakAnywhere?: boolean;
}) {
  return (
    <div data-search={`${title} ${subtitle ?? ""}`.toLowerCase()} className={`flex items-start min-h-[52px] py-3 ${ROW_INSET}`}>
      <Icon className="w-[22px] h-[22px] shrink-0 text-ink-hi mt-0.5" />
      <div className="flex-1 min-w-0 ml-[14px]">
        <div className="text-[14px] text-ink-hi">{title}</div>
        {subtitle && <div className={`text-[12.5px] text-ink-dim mt-0.5 leading-snug ${breakAnywhere ? "[overflow-wrap:anywhere]" : ""}`}>{subtitle}</div>}
        {actions && <div className="mt-2 flex flex-wrap gap-1.5">{actions}</div>}
      </div>
      {trailing && <div className="shrink-0 ml-3 self-center">{trailing}</div>}
    </div>
  );
}

export function SettingsRow({
  icon: Icon,
  title,
  subtitle,
  value,
  badge,
  disabled,
  onClick,
  onPointerDown,
  trailing,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  value?: string;
  badge?: string;
  disabled?: boolean;
  /** receives the event so rows can anchor a dropdown to themselves */
  onClick?: (e: React.MouseEvent) => void;
  /** dropdown rows stop the press here — the open menu survives until the
      click, letting the same row toggle it closed (playbar "+" pattern) */
  onPointerDown?: (e: React.PointerEvent) => void;
  trailing?: ReactNode;
}) {
  const interactive = onClick && !disabled;
  return (
    <div
      data-search={`${title} ${subtitle ?? ""}`.toLowerCase()}
      onPointerDown={onPointerDown}
      onClick={interactive ? (e) => onClick(e) : undefined}
      className={`flex items-center min-h-[52px] py-3 ${ROW_INSET} ${interactive ? "cursor-pointer hover:bg-ink-hi/[0.04] active:bg-ink-hi/[0.07] transition-colors" : ""} ${disabled ? "opacity-45" : ""}`}
    >
      <Icon className="w-[22px] h-[22px] shrink-0 text-ink-hi" />
      <div className="flex-1 min-w-0 ml-[14px]">
        <div className="flex items-center">
          {/* A long title wraps rather than losing its end (half a screen, German). */}
          <span className="min-w-0 text-[14px] text-ink-hi [overflow-wrap:anywhere]">{title}</span>
          {badge && <Badge>{badge}</Badge>}
        </div>
        {subtitle && <div className="text-[12.5px] text-ink-dim mt-0.5 leading-snug">{subtitle}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0 ml-3">
        {trailing ?? (
          <>
            {value && <span className="text-[14px] text-ink-dim">{value}</span>}
            {onClick && <Chevron />}
          </>
        )}
      </div>
    </div>
  );
}
