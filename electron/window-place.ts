/**
 * Where the main window stood when it was last used: its size, its place, its screen, and whether
 * it filled that screen (electron/main.ts). The next start puts it back there, when that place
 * still exists: a screen unplugged since means the window opens centred on the main one, as on
 * the first day.
 */
export interface WindowPlace {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** This much of the window has to show on a screen for the place to count as still there. */
const SEEN_WIDTH = 160;
const SEEN_HEIGHT = 100;

/** What was written down, when it is a place at all. */
export function readPlace(raw: unknown): WindowPlace | null {
  const p = raw as Partial<WindowPlace> | null;
  if (!p || typeof p !== "object") return null;
  const numbers = [p.x, p.y, p.width, p.height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((p.width as number) < SEEN_WIDTH || (p.height as number) < SEEN_HEIGHT) return null;
  return { x: Math.round(p.x as number), y: Math.round(p.y as number), width: Math.round(p.width as number), height: Math.round(p.height as number), maximized: p.maximized === true };
}

function shared(a: Area, b: Area): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** The screen (its work area) a window at this place is on: the one showing the most of it, or null when none shows enough. */
export function screenOf(place: Area, screens: Area[]): Area | null {
  let best: Area | null = null;
  let most = 0;
  for (const screen of screens) {
    const { width, height } = shared(place, screen);
    if (width < Math.min(SEEN_WIDTH, place.width) || height < Math.min(SEEN_HEIGHT, place.height)) continue;
    if (width * height > most) {
      most = width * height;
      best = screen;
    }
  }
  return best;
}

/**
 * The saved place on today's screens. As it was when enough of it shows on one of them, no larger
 * than that screen and with its top edge on it (the bar the window is moved by); null when its
 * screen is gone.
 */
export function placeOn(place: WindowPlace | null, screens: Area[]): WindowPlace | null {
  if (!place) return null;
  const screen = screenOf(place, screens);
  if (!screen) return null;
  const width = Math.min(place.width, screen.width);
  const height = Math.min(place.height, screen.height);
  const x = Math.min(Math.max(place.x, screen.x - width + SEEN_WIDTH), screen.x + screen.width - SEEN_WIDTH);
  const y = Math.min(Math.max(place.y, screen.y), screen.y + screen.height - SEEN_HEIGHT);
  return { x, y, width, height, maximized: place.maximized };
}

const touches = (a: Area, b: Area): boolean => {
  const s = shared(a, b);
  return s.width > 0 && s.height > 0;
};

/**
 * A maximized window's own bounds aren't at home on the screen it fills: they lie mostly on
 * another one, or an edge reaches into one (a window dropped at a screen's border and maximized
 * there — seen as rcNormal −1290..3 beside a screen starting at 0). Windows goes by those bounds
 * when the window leaves for the taskbar: it animates to the other screen's taskbar and comes
 * back there, so they have to lie fully on the screen the window shows on.
 */
function astray(normal: Area, on: Area, screens: Area[]): boolean {
  return screenOf(normal, screens) !== on || screens.some((s) => s !== on && touches(normal, s));
}

/**
 * What to write down for a window: its own bounds (the ones it has when it doesn't fill a screen),
 * and whether it fills one. A window filling a screen its own bounds aren't fully on gets bounds on
 * the screen it shows on, so the next start, a minimize and a return from the taskbar find it there.
 */
export function placeToKeep(normal: Area, shown: Area, maximized: boolean, screens: Area[], own?: { width: number; height: number }): WindowPlace {
  const on = screenOf(shown, screens);
  if (maximized && on && astray(normal, on, screens)) {
    if (screenOf(normal, screens) === on) {
      // Mostly here already, one edge over the border: pulled whole onto this screen, its size kept.
      const width = Math.min(normal.width, on.width);
      const height = Math.min(normal.height, on.height);
      const x = Math.round(Math.min(Math.max(normal.x, on.x), on.x + on.width - width));
      const y = Math.round(Math.min(Math.max(normal.y, on.y), on.y + on.height - height));
      return { x, y, width, height, maximized };
    }
    // The size it last had as a window of its own, where known: what Windows reports for a window
    // maximized across screens of different scaling isn't to be trusted.
    const width = Math.min(own?.width ?? normal.width, on.width);
    const height = Math.min(own?.height ?? normal.height, on.height);
    return { x: Math.round(on.x + (on.width - width) / 2), y: Math.round(on.y + (on.height - height) / 2), width, height, maximized };
  }
  return { x: normal.x, y: normal.y, width: normal.width, height: normal.height, maximized };
}

/** A maximized window whose own bounds aren't fully at home on the screen it fills: minimized, Windows would take it to the wrong taskbar. */
export function strayed(normal: Area, shown: Area, maximized: boolean, screens: Area[]): boolean {
  const on = screenOf(shown, screens);
  return maximized && !!on && astray(normal, on, screens);
}

/** Whether two places are on different screens: a window that came back from the taskbar somewhere else. */
export function onAnotherScreen(now: Area, before: Area, screens: Area[]): boolean {
  const a = screenOf(now, screens);
  const b = screenOf(before, screens);
  return !!a && !!b && a !== b;
}
