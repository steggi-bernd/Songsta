/**
 * Slide by slide (Replay, views/ReplayView.tsx): one turn of the wheel, one swipe on the touchpad or one
 * Page Up/Down goes to the next slide in a single smooth move; what comes after the last slide (the
 * listening history) scrolls as any page does. The browser's own snapping (scroll-snap) moved in two
 * steps, a bit of scroll and then the snap, which the user found bumpy, and held on to the history too.
 *
 *  - A mouse wheel's notches each count; one more waits while a move runs, and a notch the other way
 *    turns it round at once.
 *  - A touchpad sends a stream: it counts once per swipe, and its tail (the glide after the fingers
 *    lift) goes by, until a pause or a fresh push starts the next swipe.
 *  - A drag of the scrollbar, a press beside it or a touch screen settles on the nearest slide once it stops.
 *  - The arrow keys and Space stay Songsta's (volume, seeking, play and pause).
 */

/** What a wheel event says, as far as paging cares. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  /** Chromium's old wheelDeltaY: 120 a notch for a notched wheel */
  wheelDeltaY?: number;
}

/** A notched wheel's turn, each a step of its own, unlike a touchpad's or a free-spinning wheel's stream. */
export function isNotched(e: WheelLike): boolean {
  if (e.deltaMode === 1 || e.deltaMode === 2) return true;
  const w = e.wheelDeltaY ?? 0;
  return w !== 0 && w % 120 === 0;
}

/** What one event of a touchpad's stream does: a move, a part of a swipe already used, or not yet enough. */
export type SwipeStep = "move" | "tail" | "wait";

/** How far a swipe goes before it counts, in pixels of wheel delta. */
const SWIPE_DISTANCE = 30;
/** A pause this long between events ends a swipe. */
const SWIPE_PAUSE_MS = 160;

/**
 * Tells a touchpad's swipes apart in its stream of wheel events. Pure, for tests: `at` is the event's
 * moment in ms.
 */
export function createSwipeGate() {
  let lastAt = -Infinity;
  let recent: number[] = [];
  let open = true;
  let sum = 0;
  /**
   * A new swipe while the last one still glides: the glide was dying down (not the same swipe building
   * up), and this push is clearly stronger than anything in it.
   */
  const isPush = (size: number): boolean => {
    if (recent.length < 3) return false;
    const [a, b, c] = recent.slice(-3);
    const dyingDown = b <= a + 1 && c <= b + 1;
    return dyingDown && size > Math.max(12, Math.max(...recent) * 2.5);
  };
  const note = (size: number, at: number): void => {
    lastAt = at;
    recent = [...recent, size].slice(-4);
  };
  return {
    /** An event over the slides. */
    feed(deltaY: number, at: number): SwipeStep {
      const size = Math.abs(deltaY);
      const fresh = at - lastAt > SWIPE_PAUSE_MS || isPush(size);
      note(size, at);
      if (fresh) {
        open = true;
        sum = 0;
      }
      if (!open) return "tail";
      if (sum !== 0 && Math.sign(sum) !== Math.sign(deltaY)) sum = 0;
      sum += deltaY;
      if (Math.abs(sum) < SWIPE_DISTANCE) return "wait";
      open = false;
      sum = 0;
      return "move";
    },
    /**
     * An event where the page scrolls freely: true while it's the glide of the swipe that made the last
     * move (it's swallowed, so landing on the history doesn't run on into it); else the gate lets go.
     */
    gliding(deltaY: number, at: number): boolean {
      const size = Math.abs(deltaY);
      const fresh = open || at - lastAt > SWIPE_PAUSE_MS || isPush(size);
      note(size, at);
      if (fresh) {
        open = true;
        sum = 0;
        return false;
      }
      return true;
    },
    /** A move was made otherwise (a notch, a stop at the history's top): what still comes of this stream is its tail. */
    used(at: number): void {
      lastAt = at;
      open = false;
      sum = 0;
    },
  };
}

/** Fast at first, gentle at the end. */
const ease = (t: number): number => 1 - Math.pow(1 - t, 4);
/** A whole slide's move; shorter hops are quicker. */
const MOVE_MS = 640;
/** After the scroll stops (a drag of the scrollbar, a touch screen), the nearest slide is settled on. */
const SETTLE_MS = 160;

/**
 * Pages the slides (`[data-slide]`) of `page` inside `scroller`; the element marked `[data-slide-end]`
 * is the last stop, and from there on the page scrolls freely. Returns the way to stop.
 */
export function pageSlides(scroller: HTMLElement, page: HTMLElement, opts: { instant: () => boolean }): () => void {
  let move: { from: number; to: number; frame: number } | null = null;
  let queued = 0;
  let index = 0;
  let pointerDown = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const gate = createSwipeGate();

  /** Where each slide starts in the scroller, and last where the free part starts. */
  const stops = (): number[] => {
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const marks = [...page.querySelectorAll<HTMLElement>("[data-slide], [data-slide-end]")];
    return marks.map((el) => Math.max(0, Math.min(max, Math.round(el.getBoundingClientRect().top - base))));
  };
  const nearest = (y: number, list: number[]): number => {
    let best = 0;
    for (let i = 1; i < list.length; i++) if (Math.abs(list[i] - y) < Math.abs(list[best] - y)) best = i;
    return best;
  };
  /** Slides taller than the panel (a very low window) scroll as a page does. */
  const tooTall = (): boolean => (page.querySelector<HTMLElement>("[data-slide]")?.offsetHeight ?? 0) > scroller.clientHeight + 4;

  const finished = (): void => {
    move = null;
    if (!queued) return;
    const dir = queued;
    queued = 0;
    go(dir);
  };
  const glideTo = (to: number): void => {
    if (move) cancelAnimationFrame(move.frame);
    const from = scroller.scrollTop;
    if (opts.instant() || Math.abs(to - from) < 1) {
      scroller.scrollTop = to;
      finished();
      return;
    }
    const length = Math.min(MOVE_MS, Math.max(280, Math.abs(to - from) * 0.8));
    const started = performance.now();
    const step = (now: number): void => {
      if (!move) return;
      // A frame's time can lie a little before the move began (the frame started before the wheel
      // event was handled): never below the start, or the page twitches back first.
      const t = Math.min(1, Math.max(0, (now - started) / length));
      scroller.scrollTop = from + (to - from) * ease(t);
      if (t < 1) move.frame = requestAnimationFrame(step);
      else finished();
    };
    move = { from, to, frame: requestAnimationFrame(step) };
  };
  function go(dir: number): void {
    const list = stops();
    if (!list.length) return;
    const from = nearest(move ? move.to : scroller.scrollTop, list);
    index = Math.max(0, Math.min(list.length - 1, from + dir));
    glideTo(list[index]);
  }
  /** A move asked for while one runs: the same way waits (one at most), the other way turns at once. */
  const ask = (dir: number): void => {
    if (!move) return go(dir);
    if (move.to > move.from === dir > 0) queued = dir;
    else {
      queued = 0;
      go(dir);
    }
  };

  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY) || tooTall()) return;
    const notched = isNotched(e as WheelEvent & { wheelDeltaY?: number });
    if (!move) {
      const list = stops();
      const end = list[list.length - 1] ?? 0;
      const y = scroller.scrollTop;
      // The free part scrolls as any page; from its very top, up goes back to the last slide.
      if (y >= end - 2 && (e.deltaY > 0 || y > end + 2)) {
        if (!notched && gate.gliding(e.deltaY, e.timeStamp)) {
          e.preventDefault();
          return;
        }
        // Up through the free part stops at its top; the next turn goes on to the last slide.
        if (e.deltaY < 0 && y + e.deltaY < end) {
          e.preventDefault();
          gate.used(e.timeStamp);
          index = list.length - 1;
          glideTo(end);
        }
        return;
      }
    }
    e.preventDefault();
    if (notched) gate.used(e.timeStamp);
    else if (gate.feed(e.deltaY, e.timeStamp) !== "move") return;
    ask(e.deltaY > 0 ? 1 : -1);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || tooTall()) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const list = stops();
    if (!list.length) return;
    const end = list[list.length - 1];
    const inFree = !move && scroller.scrollTop > end + 2;
    if (e.key === "PageDown" && !inFree) ask(1);
    else if (e.key === "PageUp" && !inFree) ask(-1);
    else if (e.key === "Home") {
      index = 0;
      glideTo(list[0]);
    } else if (e.key === "End" && !inFree) {
      index = list.length - 1;
      glideTo(end);
    } else return;
    e.preventDefault();
  };

  /** A scroll that wasn't a move of this (a drag of the scrollbar, a touch screen) ends on the nearest slide. */
  const settle = (): void => {
    settleTimer = null;
    if (move || pointerDown || tooTall()) return;
    const list = stops();
    const end = list[list.length - 1] ?? 0;
    const y = scroller.scrollTop;
    if (y >= end - 2) return;
    const i = nearest(y, list);
    index = i;
    if (Math.abs(list[i] - y) > 2) glideTo(list[i]);
  };
  const onScroll = (): void => {
    if (move) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  };
  const onPointerDown = (): void => {
    pointerDown = true;
  };
  const onPointerUp = (): void => {
    pointerDown = false;
    onScroll();
  };

  // A new size moves the slides: the one in view stays in view.
  let resizeFrame = 0;
  const seen = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = requestAnimationFrame(() => {
        if (move || tooTall()) return;
        const list = stops();
        const end = list[list.length - 1] ?? 0;
        if (scroller.scrollTop > end + 2 || index >= list.length) return;
        scroller.scrollTop = list[index];
      });
    });
  });
  seen.observe(scroller);

  index = nearest(scroller.scrollTop, stops());
  scroller.addEventListener("wheel", onWheel, { passive: false });
  scroller.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  return () => {
    if (move) cancelAnimationFrame(move.frame);
    move = null;
    if (settleTimer) clearTimeout(settleTimer);
    cancelAnimationFrame(resizeFrame);
    seen.disconnect();
    scroller.removeEventListener("wheel", onWheel);
    scroller.removeEventListener("scroll", onScroll);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
  };
}
