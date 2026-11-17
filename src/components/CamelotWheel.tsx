/**
 * The Camelot wheel (Klingt wie), to touch: a key picked aims the matches at it, the wheel turning it to
 * the top by the shorter way round, its neighbours lit softly; pointed at, a key lifts and the middle
 * says its name and how many songs are in it. The song's own key keeps a mark when the matches aim
 * elsewhere. Correcting, the next key picked is the song's (src/stores/keyEdits.ts). Arrow keys walk the
 * wheel (left and right round it, up and down between the rings), Enter picks. Still with "Reduce
 * animation" or the system's reduced motion.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { plural } from "../lib/format";
import { T } from "../lib/i18n";
import { ringSlice } from "../lib/ringSlice";
import { camelotLabel, keyLabel, keyOfCamelot, keyStep, sameCamelot, type Camelot } from "../lib/soundMatch";
import { useSettings } from "../stores/settings";

const MID = 180;
// The rings meet: the room between them, as between the slices, comes from ringSlice's gap.
const RINGS: Record<Camelot["ring"], [number, number]> = { A: [65, 120], B: [120, 177] };


/** The angle `to` reached from `from` by the shorter way round, in degrees. */
export const turnTo = (from: number, to: number): number => from + ((((to - from) % 360) + 540) % 360) - 180;

interface Slice {
  c: Camelot;
  label: string;
  d: string;
  /** the middle of the slice, its angle (radians) and where its label sits */
  mid: number;
  tx: number;
  ty: number;
  index: number;
}

/** The 24 places, drawn once: 1 at the top, round clockwise; A inside, B outside. */
const SLICES: Slice[] = (() => {
  const out: Slice[] = [];
  for (let i = 0; i < 12; i++) {
    const a1 = (i / 12) * Math.PI * 2 - Math.PI / 2 - Math.PI / 12;
    const a2 = a1 + Math.PI / 6;
    const mid = (a1 + a2) / 2;
    for (const ring of ["A", "B"] as const) {
      const [r1, r2] = RINGS[ring];
      const rm = (r1 + r2) / 2;
      const c: Camelot = { n: i + 1, ring };
      out.push({ c, label: camelotLabel(c), d: ringSlice(MID, MID, r1, r2, a1, a2, 7, 4.5), mid, tx: MID + rm * Math.cos(mid), ty: MID + rm * Math.sin(mid), index: out.length });
    }
  }
  return out;
})();

function useReducedMotion(): boolean {
  const setting = useSettings((s) => s.reduceAnimation);
  const [system, setSystem] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const hear = (): void => setSystem(query.matches);
    query.addEventListener("change", hear);
    return () => query.removeEventListener("change", hear);
  }, []);
  return setting || system;
}

export interface CamelotWheelProps {
  /** the song's own key, as the library knows it now */
  songKey: Camelot | null;
  /** the key the matches aim at; the song's own when null */
  aim: Camelot | null;
  /** a place picked: aim there, or (correcting) set the song's key */
  onPick(c: Camelot): void;
  /** measured songs per key ("8A" → 23), said when a key is pointed at */
  counts?: Record<string, number>;
  /** the next pick sets the song's key */
  correcting?: boolean;
  /** the key pointed at now (hovered or focused), null when none: the view shows songs to hear it by */
  onPoint?(c: Camelot | null): void;
  size: number;
}

export function CamelotWheel({ songKey, aim, onPick, counts, correcting, onPoint, size }: CamelotWheelProps) {
  const reduce = useReducedMotion();
  const lit = correcting ? songKey : (aim ?? songKey);
  const [pointed, setPointed] = useState<Camelot | null>(null);
  // Correcting begins with the question, not with a key still pointed at.
  useEffect(() => setPointed(null), [correcting]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onPoint?.(pointed), [pointed?.n, pointed?.ring]);
  // The lit key turns to the top.
  const [angle, setAngle] = useState(() => (lit ? -(lit.n - 1) * 30 : 0));
  useEffect(() => {
    if (lit) setAngle((a) => turnTo(a, -(lit.n - 1) * 30));
  }, [lit?.n]);
  const refs = useRef(new Map<string, SVGGElement>());
  const spin = reduce ? "none" : "transform 750ms cubic-bezier(0.22, 0.9, 0.24, 1)";
  const shown = pointed ?? lit;
  const shownKey = shown ? keyOfCamelot(shown) : null;
  const shownCount = shown ? (counts?.[camelotLabel(shown)] ?? 0) : 0;
  const away = !!aim && !!songKey && !sameCamelot(aim, songKey) && !correcting;

  const walk = (from: Camelot, e: KeyboardEvent<SVGGElement>): void => {
    let next: Camelot | null = null;
    if (e.key === "ArrowRight") next = { n: (from.n % 12) + 1, ring: from.ring };
    else if (e.key === "ArrowLeft") next = { n: ((from.n + 10) % 12) + 1, ring: from.ring };
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") next = { n: from.n, ring: from.ring === "A" ? "B" : "A" };
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(from);
      return;
    }
    if (!next) return;
    e.preventDefault();
    refs.current.get(camelotLabel(next))?.focus();
  };

  const songMark = useMemo(() => {
    if (!songKey) return null;
    const s = SLICES.find((x) => sameCamelot(x.c, songKey));
    if (!s) return null;
    const r = RINGS[songKey.ring][1] - 9;
    return { x: MID + r * Math.cos(s.mid), y: MID + r * Math.sin(s.mid) };
  }, [songKey]);
  const litSlice = lit ? SLICES.find((x) => sameCamelot(x.c, lit)) : undefined;

  return (
    <svg
      viewBox="0 0 360 360"
      width={size}
      height={size}
      role="group"
      aria-label={correcting ? T("Pick the song's key on the Camelot wheel") : T("The Camelot wheel: pick a key to find songs that fit it")}
      className={`shrink-0 select-none ${correcting ? "camelot-correcting" : ""}`}
    >
      <circle cx={MID} cy={MID} r={178} fill="none" stroke={correcting ? "rgb(var(--accent))" : "transparent"} strokeWidth={2} strokeDasharray="6 7" className={correcting && !reduce ? "camelot-dash" : ""} />
      <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${MID}px ${MID}px`, transformBox: "view-box", transition: spin }}>
        {SLICES.map((s) => {
          const step = lit ? keyStep(lit, s.c) : 2;
          const isPointed = sameCamelot(pointed, s.c);
          const isSong = sameCamelot(songKey, s.c);
          const fill = correcting
            ? isPointed
              ? "rgb(var(--accent))"
              : isSong
                ? "rgb(var(--accent) / 0.45)"
                : "rgba(255,255,255,0.08)"
            : step === 0
              ? "rgb(var(--accent))"
              : step === 1
                ? "rgb(var(--accent) / 0.35)"
                : isPointed
                  ? "rgba(255,255,255,0.18)"
                  : "rgba(255,255,255,0.07)";
          const ink = (correcting ? isPointed : step === 0) ? "#0b0b0d" : step === 1 || isPointed || (correcting && isSong) ? "#fff" : "rgba(255,255,255,0.5)";
          const lift = isPointed ? 5 : 0;
          const key = keyOfCamelot(s.c);
          const count = counts?.[s.label] ?? 0;
          return (
            <g
              key={s.label}
              ref={(el) => {
                if (el) refs.current.set(s.label, el);
                else refs.current.delete(s.label);
              }}
              role="button"
              tabIndex={0}
              aria-pressed={sameCamelot(s.c, lit)}
              aria-label={`${s.label} · ${keyLabel(key.key, key.minor)} · ${plural(count, T("song"), T("songs"))}`}
              className={`camelot-slice ${reduce ? "" : "camelot-slice-in"}`}
              style={{ animationDelay: reduce ? undefined : `${s.index * 14}ms`, cursor: "pointer" }}
              onClick={() => onPick(s.c)}
              onKeyDown={(e) => walk(s.c, e)}
              onMouseEnter={() => setPointed(s.c)}
              onMouseLeave={() => setPointed((p) => (sameCamelot(p, s.c) ? null : p))}
              onFocus={() => setPointed(s.c)}
              onBlur={() => setPointed((p) => (sameCamelot(p, s.c) ? null : p))}
            >
              <g style={{ transform: `translate(${(Math.cos(s.mid) * lift).toFixed(2)}px, ${(Math.sin(s.mid) * lift).toFixed(2)}px)`, transition: reduce ? "none" : "transform 180ms ease" }}>
                <path d={s.d} style={{ fill, transition: reduce ? "none" : "fill 320ms ease" }} />
                <text
                  x={s.tx}
                  y={s.ty + 4}
                  textAnchor="middle"
                  fontSize={s.c.ring === "A" ? 12 : 13}
                  fontWeight={800}
                  fill={ink}
                  style={{ transform: `rotate(${-angle}deg)`, transformOrigin: `${s.tx}px ${s.ty}px`, transformBox: "view-box", transition: spin, pointerEvents: "none" }}
                >
                  {s.label}
                </text>
              </g>
            </g>
          );
        })}
        {/* The lit key breathes; the song's own keeps a mark while the matches aim elsewhere. */}
        {/* No outline: the lit key brightens and settles, softly. */}
        {litSlice && !correcting && !reduce && <path d={litSlice.d} fill="#fff" className="camelot-glow" style={{ pointerEvents: "none" }} />}
        {away && songMark && <circle cx={songMark.x} cy={songMark.y} r={4.5} fill="#fff" stroke="#0b0b0d" strokeWidth={2} style={{ pointerEvents: "none" }} />}
      </g>
      <circle cx={MID} cy={MID} r={63} fill="#0b0b0d" />
      <g key={correcting && !pointed ? "correct" : shown ? camelotLabel(shown) : "none"} className={reduce ? "" : "camelot-center-in"} style={{ pointerEvents: "none" }}>
        {correcting && !pointed ? (
          <>
            <text x={MID} y={176} textAnchor="middle" fontSize={18} fontWeight={800} fill="#fff">
              {T("Which key?")}
            </text>
            <text x={MID} y={199} textAnchor="middle" fontSize={13} fill="rgba(255,255,255,0.65)">
              {T("Pick the right one")}
            </text>
          </>
        ) : shown && shownKey ? (
          <>
            <text x={MID} y={172} textAnchor="middle" fontSize={32} fontWeight={900} fill="#fff">
              {camelotLabel(shown)}
            </text>
            <text x={MID} y={196} textAnchor="middle" fontSize={15} fontWeight={700} fill="rgba(255,255,255,0.8)">
              {keyLabel(shownKey.key, shownKey.minor)}
            </text>
            {counts && (
              <text x={MID} y={216} textAnchor="middle" fontSize={13} fill="rgba(255,255,255,0.55)">
                {plural(shownCount, T("song"), T("songs"))}
              </text>
            )}
          </>
        ) : null}
      </g>
    </svg>
  );
}
