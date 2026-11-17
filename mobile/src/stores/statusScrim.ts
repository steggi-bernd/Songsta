/**
 * The dark shade under the status bar (App.tsx) keeps the clock readable over pages that scroll under it.
 * A screen with a field of colour of its own up there, the Replay story, puts it away while it shows.
 */
import { useEffect } from "react";
import { create } from "zustand";

/** How many screens want the shade away just now. */
export const useStatusScrim = create<{ away: number }>(() => ({ away: 0 }));

/** For as long as the calling screen shows: no shade under the status bar. */
export function useNoStatusScrim(): void {
  useEffect(() => {
    useStatusScrim.setState((s) => ({ away: s.away + 1 }));
    return () => useStatusScrim.setState((s) => ({ away: Math.max(0, s.away - 1) }));
  }, []);
}
