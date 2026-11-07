// While music plays, the app should rest: the seek bar paints when its fill can visibly move, and the little bars
// aren't a CSS animation, which would keep the graphics process drawing at the screen's full rate.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/seekBarPace.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { LONGEST_WAIT_MS, nextLook, smallestMove } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

/** Plays a song of `seconds` on a bar of `px` pixels for `playMs`, the way the slider does it. */
function play({ seconds, px, ratio = 1, playMs = 60_000, clock = (t) => t / (seconds * 1000) }) {
  const smallest = smallestMove(px, ratio);
  let now = 0;
  let shown = Number.NaN;
  let shownAt = 0;
  let wait = 0;
  let paints = 0;
  let looks = 0;
  let worstError = 0;
  let longestWait = 0;
  while (now < playMs) {
    const v = clock(now);
    const moved = Math.abs(v - shown);
    if (!Number.isNaN(moved)) worstError = Math.max(worstError, moved * px * ratio);
    const step = nextLook(moved, smallest, now - shownAt, wait);
    wait = step.waitMs;
    longestWait = Math.max(longestWait, wait);
    looks++;
    if (step.paint) {
      paints++;
      shown = v;
      shownAt = now;
    }
    // Waiting, then the next frame.
    now += wait + 16;
  }
  return { paints, looks, worstError, longestWait, perSecond: paints / (playMs / 1000), shown, shownAt };
}

test("a whole song on a normal bar: a few paints a second, instead of one every frame", () => {
  const { perSecond, worstError } = play({ seconds: 240, px: 500 });
  assert.ok(perSecond >= 2 && perSecond <= 5, `${perSecond} a second`);
  assert.ok(worstError < 1.5, `it stays within a pixel or so of the clock, ${worstError}`);
});

test("a short song moves faster and gets more paints: as smooth as it was", () => {
  const { perSecond, worstError } = play({ seconds: 20, px: 500 });
  assert.ok(perSecond >= 20, `${perSecond} a second`);
  assert.ok(worstError < 2, `${worstError}`);
});

test("a sharper screen shows smaller moves", () => {
  const normal = play({ seconds: 240, px: 500 }).perSecond;
  const sharp = play({ seconds: 240, px: 500, ratio: 2 }).perSecond;
  assert.ok(sharp > normal * 1.5, `${normal} → ${sharp}`);
});

test("it never waits longer than a quarter of a second", () => {
  assert.ok(play({ seconds: 3600, px: 500 }).longestWait <= LONGEST_WAIT_MS);
});

test("a jump shows at the next look, however slow the song", () => {
  let jumped = false;
  const r = play({
    seconds: 3600,
    px: 500,
    playMs: 5300,
    clock: (t) => {
      if (t > 5000) jumped = true;
      return jumped ? 0.5 + t / 3_600_000 : t / 3_600_000;
    },
  });
  assert.ok(r.shown > 0.5, "within a quarter of a second and a frame, the bar shows the new place");
});

test("a clock standing still paints nothing more", () => {
  const { paints, longestWait } = play({ seconds: 240, px: 500, clock: () => 0.25 });
  assert.equal(paints, 1, "the first one");
  assert.equal(longestWait, LONGEST_WAIT_MS, "and it looks less and less often");
});

test("the first look always paints, and starts the next one right away", () => {
  assert.deepEqual(nextLook(Number.NaN, 0.001, 0, 0), { paint: true, waitMs: 0 });
});

test("the little bars in the list aren't a CSS animation", () => {
  const css = fs.readFileSync(fileURLToPath(new URL("../src/index.css", import.meta.url)), "utf8");
  const rule = /\.eq-bar\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(rule, "the rule is there");
  assert.doesNotMatch(rule, /animation/);
});
