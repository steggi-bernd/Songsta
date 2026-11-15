// Where the window comes back (electron/window-place.ts): the size, place and screen it was left
// with, as long as that screen is still there. Two screens as on a desk: the main one, and a
// smaller one to its left.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../electron/window-place.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  write: false,
});
const { readPlace, placeOn, placeToKeep, screenOf, onAnotherScreen, strayed } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const MAIN = { x: 0, y: 0, width: 2195, height: 1187 };
const LEFT = { x: -1920, y: 0, width: 1920, height: 1032 };
const BOTH = [MAIN, LEFT];

test("what was written down is read as a place, and nonsense as none", () => {
  assert.deepEqual(readPlace({ x: 10.4, y: 20, width: 1280, height: 820, maximized: true }), { x: 10, y: 20, width: 1280, height: 820, maximized: true });
  assert.equal(readPlace(null), null);
  assert.equal(readPlace({ x: 0, y: 0, width: "wide", height: 820 }), null);
  assert.equal(readPlace({ x: 0, y: 0, width: 20, height: 10 }), null);
  assert.equal(readPlace({ x: NaN, y: 0, width: 1280, height: 820 }), null);
});

test("a window left on the second screen comes back there, maximized or not", () => {
  const place = { x: -1800, y: 60, width: 1300, height: 800, maximized: true };
  assert.deepEqual(placeOn(place, BOTH), place);
  assert.equal(screenOf(place, BOTH), LEFT);
  assert.deepEqual(placeOn({ ...place, maximized: false }, BOTH), { ...place, maximized: false });
});

test("its screen unplugged: no place, so it opens as on the first day", () => {
  assert.equal(placeOn({ x: -1800, y: 60, width: 1300, height: 800, maximized: false }, [MAIN]), null);
  assert.equal(placeOn(null, BOTH), null);
});

test("a window larger than today's screen is cut to it, with its top edge in reach", () => {
  const got = placeOn({ x: 100, y: -300, width: 3000, height: 2000, maximized: false }, [MAIN]);
  assert.equal(got.width, MAIN.width);
  assert.equal(got.height, MAIN.height);
  assert.equal(got.y, 0);
  assert.ok(got.x + got.width >= 160 && got.x <= MAIN.width - 160);
});

test("a sliver left on a screen doesn't count as being there", () => {
  assert.equal(placeOn({ x: 2195 - 40, y: 100, width: 1280, height: 820, maximized: false }, [MAIN]), null);
  assert.ok(placeOn({ x: 2195 - 400, y: 100, width: 1280, height: 820, maximized: false }, [MAIN]));
});

test("a window filling the second screen, whose own bounds still lie on the main one, is written down on the second", () => {
  // As a maximized window reports itself: a few pixels over the screen's edges.
  const shown = { x: -1932, y: -12, width: 1944, height: 1056 };
  const kept = placeToKeep({ x: 400, y: 200, width: 1280, height: 820 }, shown, true, BOTH);
  assert.equal(kept.maximized, true);
  assert.equal(screenOf(kept, BOTH), LEFT);
  assert.equal(kept.width, 1280);
  // Its own bounds on the screen it shows on stay as they are.
  const own = { x: -1700, y: 90, width: 1100, height: 700 };
  assert.deepEqual(placeToKeep(own, shown, true, BOTH), { ...own, maximized: true });
  assert.deepEqual(placeToKeep(own, own, false, BOTH), { ...own, maximized: false });
});

test("back from the taskbar on the other screen is told apart from staying", () => {
  const before = { x: -1700, y: 90, width: 1100, height: 700 };
  assert.equal(onAnotherScreen({ x: 300, y: 90, width: 1100, height: 700 }, before, BOTH), true);
  assert.equal(onAnotherScreen({ x: -1600, y: 120, width: 1100, height: 700 }, before, BOTH), false);
  // Where a minimized window is parked shows on no screen: nothing to conclude.
  assert.equal(onAnotherScreen({ x: -32000, y: -32000, width: 160, height: 28 }, before, BOTH), false);
});

test("own bounds reaching over the border into the main screen count as astray and are pulled whole onto the second", () => {
  // The real case of 2026-11-14: rcNormal −1290..3 beside a main screen starting at 0, the window
  // maximized on the second — Windows then minimizes it to the main screen's taskbar.
  const shown = { x: -1932, y: -12, width: 1944, height: 1056 };
  const over = { x: -1290, y: 2, width: 1293, height: 827 };
  assert.equal(strayed(over, shown, true, BOTH), true);
  const kept = placeToKeep(over, shown, true, BOTH);
  assert.equal(kept.maximized, true);
  // The size it was dropped with stays; the place slides left until it's whole on the screen.
  assert.equal(kept.width, 1293);
  assert.equal(kept.x + kept.width <= LEFT.x + LEFT.width, true);
  assert.equal(kept.x >= LEFT.x, true);
  // Not maximized, the same bounds are the user's own business.
  assert.equal(strayed(over, over, false, BOTH), false);
  // Fully inside, nothing is astray.
  assert.equal(strayed({ x: -1700, y: 90, width: 1100, height: 700 }, shown, true, BOTH), false);
});
