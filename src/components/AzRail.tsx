/**
 * The A–Z rail beside Explore's lists while they run alphabetically: a letter
 * jumps to the first entry filed under it (that entry carries `data-az`), and
 * a drag along the rail runs through the letters. Letters nothing starts with
 * stay dim.
 */
import { useRef } from "react";
import { T } from "../lib/i18n";

export const AZ_LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];

/** The letter a name files under: its first letter without accents, "#" for digits and signs. */
export function azLetter(name: string): string {
  const first = name.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().charAt(0).toUpperCase();
  return first >= "A" && first <= "Z" ? first : "#";
}

/** The first entry of each letter in the order shown, as entry key → letter. */
export function azFirsts<R>(rows: R[], keyOf: (row: R) => string, nameOf: (row: R) => string): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const letter = azLetter(nameOf(row));
    if (seen.has(letter)) continue;
    seen.add(letter);
    out.set(keyOf(row), letter);
  }
  return out;
}

export function AzRail({ letters }: { letters: ReadonlySet<string> }) {
  const dragging = useRef(false);
  const last = useRef("");
  const jump = (letter: string | null | undefined, smooth: boolean): void => {
    if (!letter || !letters.has(letter) || (letter === last.current && !smooth)) return;
    last.current = letter;
    document.querySelector<HTMLElement>(`[data-az="${letter}"]`)?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  };
  const letterAt = (x: number, y: number): string | undefined =>
    (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-az-letter]")?.dataset.azLetter;
  const stop = (): void => {
    dragging.current = false;
  };
  return (
    <nav
      aria-label={T("Jump to a letter")}
      className="sticky top-4 self-start shrink-0 w-5 flex flex-col items-center select-none touch-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragging.current = true;
        last.current = "";
        e.currentTarget.setPointerCapture?.(e.pointerId);
        jump(letterAt(e.clientX, e.clientY), false);
      }}
      onPointerMove={(e) => {
        if (dragging.current) jump(letterAt(e.clientX, e.clientY), false);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
    >
      {AZ_LETTERS.map((l) => {
        const has = letters.has(l);
        return (
          <button
            key={l}
            type="button"
            data-az-letter={l}
            disabled={!has}
            // The pointer jumps on press; a click from the keyboard (detail 0) jumps smoothly.
            onClick={(e) => {
              if (e.detail === 0) jump(l, true);
            }}
            aria-label={T("Jump to {letter}", { letter: l })}
            className={`h-[17px] w-5 grid place-items-center rounded text-[10.5px] font-extrabold leading-none transition-colors ${
              has ? "text-ink-hi/75 hover:text-accent" : "text-ink-hi/20 cursor-default"
            }`}
          >
            {l}
          </button>
        );
      })}
    </nav>
  );
}
