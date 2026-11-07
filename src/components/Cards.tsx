import { useDrag } from "../lib/dnd";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers } from "../stores/ui";
import { Artwork, PlayOverlay } from "./primitives";
import type { Track } from "../types";
import type { KeyboardEvent } from "react";

/** Keyboard activation for div-based cards (button semantics, kept clickable). */
function activateOnKey(open: () => void) {
  return (e: KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
}

/* Shelf tile: artwork-first, square cover over title/subtitle — the card is
   transparent at rest; hovering fades in Spotify's translucent tile around
   it. 8px inset keeps Spotify's proportion at this size; width grows to
   keep the cover at its tuned 168px. */
const CARD =
  "group w-[184px] shrink-0 text-left cursor-pointer active:scale-[0.98] rounded-xl p-2 transition-colors duration-200 hover:bg-ink-hi/[0.08]";

const CARD_TITLE = "text-[15px] font-semibold text-ink-hi truncate leading-snug";
const CARD_SUB = "text-[13px] text-ink-dim truncate mt-0.5";

export function TrackCard({ track }: { track: Track }) {
  const playTrack = usePlayer((s) => s.playTrack);
  const drag = useDrag({ track });
  const open = (): void => playTrack(track);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={activateOnKey(open)}
      {...tintHoverHandlers(track.thumb)}
      {...drag.props}
      className={`${CARD} select-none ${drag.dragging ? "opacity-40" : ""}`}
    >
      <div className="relative overflow-hidden rounded-xl">
        <Artwork src={track.thumb} className="w-full aspect-square rounded-xl transition-transform duration-300 ease-out origin-top group-hover:scale-[1.05]" iconClassName="w-7 h-7" />
        <PlayOverlay onClick={() => playTrack(track)} />
      </div>
      <div className="mt-2.5">
        <div className={CARD_TITLE}>{track.title}</div>
        <div className={CARD_SUB}>{track.artist}</div>
      </div>
    </div>
  );
}
