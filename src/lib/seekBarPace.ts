/**
 * How often the seek bar looks at the audio clock. Painting is what keeps the app busy while music plays: a style
 * change every frame had renderer and graphics process working for a fill that moves by a fraction of a pixel. So it
 * paints when the move can show and sleeps until the next one is due: a few times a second over a whole song, as
 * smooth as before, and however often the screen refreshes.
 */

/** in pixels of the screen: less than this doesn't show */
const SMALLEST_MOVE_PX = 0.5;
const FRAME_MS = 16;
/** however slowly it moves, a jump shows after this long at the latest */
export const LONGEST_WAIT_MS = 250;

/** That move as a part of the whole bar. */
export function smallestMove(trackPx: number, pixelRatio: number): number {
  return SMALLEST_MOVE_PX / (Math.max(trackPx, 1) * pixelRatio);
}

/**
 * One look: whether to paint now, and how long until the next look.
 * `moved` is the distance from what the bar shows (NaN when it shows nothing yet), `sinceShownMs` how long that took.
 */
export function nextLook(moved: number, smallest: number, sinceShownMs: number, lastWaitMs: number): { paint: boolean; waitMs: number } {
  if (Number.isNaN(moved)) return { paint: true, waitMs: 0 };
  if (moved >= smallest) {
    // The next visible step takes about as long as this one did.
    return { paint: true, waitMs: Math.min(LONGEST_WAIT_MS, (sinceShownMs * smallest) / moved) };
  }
  return { paint: false, waitMs: Math.min(LONGEST_WAIT_MS, Math.max(FRAME_MS, lastWaitMs * 1.5)) };
}
