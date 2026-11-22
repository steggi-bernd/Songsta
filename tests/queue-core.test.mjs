// The queue's rules (src/lib/queueCore.ts), one copy for the computer's and the phone's stores: each rule
// on its own, with the computer's way of knowing a song by several copies (`key`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/queueCore.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const rules = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const t = (id) => ({ id });
const songs = (...ids) => ids.map(t);
const ids = (list) => list.map((s) => s.id);
const state = (queue, more = {}) => ({ queue: songs(...queue), index: 0, lineEnd: 0, unshuffled: null, branches: [], ...more });
// On the computer "local:x" and "jf:x" are the same song x.
const key = (id) => id.replace(/^(local|jf):/, "");

test("asked for by hand: first come, first played; one already in the line stays, one further down comes up", () => {
  let s = state(["a", "b", "c", "d"]);
  const first = rules.enqueue(s, songs("x"));
  s = { ...s, ...first.state };
  assert.deepEqual(ids(s.queue), ["a", "x", "b", "c", "d"]);
  s = { ...s, ...rules.enqueue(s, songs("y", "x")).state };
  assert.deepEqual(ids(s.queue), ["a", "x", "y", "b", "c", "d"], "x stays where it was, y comes behind it");
  s = { ...s, ...rules.enqueue(s, songs("d")).state };
  assert.deepEqual(ids(s.queue), ["a", "x", "y", "d", "b", "c"], "d comes up instead of playing twice");
  assert.equal(s.lineEnd, 4);
});

test("on the computer another copy of a song is the same song", () => {
  const s = state(["local:a", "local:b", "local:c"]);
  const next = rules.enqueue(s, songs("jf:c"), key).state;
  assert.deepEqual(ids(next.queue), ["local:a", "jf:c", "local:b"], "the server's copy comes up, the local one doesn't play twice");
  const sameId = rules.enqueue(s, songs("jf:c")).state;
  assert.equal(sameId.queue.length, 4, "without the key they're two songs");
});

test("a branch goes behind the line and takes back what it took out; from the song playing, its list plays on", () => {
  let s = state(["a", "b", "c", "d"], { lineEnd: 2, queue: songs("a", "x", "b", "c", "d") });
  const { undo, startsHere, state: branched } = rules.branchOff(s, songs("c", "e"), "Mix");
  assert.equal(startsHere, false);
  s = { ...s, ...branched };
  assert.deepEqual(ids(s.queue), ["a", "x", "c", "e", "b", "d"], "behind x, and c only once");
  assert.deepEqual(s.branches.map((b) => b.name), ["Mix"]);
  s = { ...s, ...rules.takeBack(s, s.branches[0], undo) };
  assert.deepEqual(ids(s.queue), ["a", "x", "b", "c", "d"], "c back where it was");
  assert.deepEqual(s.branches, []);
  const here = rules.branchOff(state(["a", "b"]), songs("a", "f", "g"), "Album");
  assert.equal(here.startsHere, true);
  assert.deepEqual(ids(here.state.queue), ["a", "f", "g", "b"]);
});

test("an entry out stays out of the list's own order and its branch; moved, the line follows", () => {
  const s = state(["a", "b", "c", "d"], { index: 1, lineEnd: 3, unshuffled: songs("a", "b", "c", "d"), branches: [{ name: "Mix", trackId: "c", started: false, ids: ["c"] }] });
  const out = rules.removeEntry(s, 2);
  assert.deepEqual(ids(out.queue), ["a", "b", "d"]);
  assert.equal(out.lineEnd, 2);
  assert.deepEqual(ids(out.unshuffled), ["a", "b", "d"]);
  assert.deepEqual(out.branches, [], "a branch left with none goes");
  assert.equal(rules.removeEntry(s, 0).index, 0, "one before the song playing: the index follows");
  const playing = rules.removeEntry(state(["a", "b"], { index: 1 }), 1);
  assert.equal(playing.index, 0, "the song playing itself: the index stays in the list");
  const moved = rules.moveEntry(s, 3, 2);
  assert.deepEqual(ids(moved.queue), ["a", "b", "d", "c"]);
  assert.equal(moved.lineEnd, 4, "moved into the line, the line grows");
  assert.equal(rules.moveEntry(s, 1, 3).index, 3, "the song playing moved: the index goes with it");
});

test("shuffle keeps what was asked for next, and off brings the list's own order back from the song playing", () => {
  const s = state(["a", "x", "b", "c", "d"], { lineEnd: 2 });
  const on = { ...s, ...rules.shuffleOn(s, (list) => [...list].reverse()) };
  assert.deepEqual(ids(on.queue), ["a", "x", "d", "c", "b"]);
  assert.deepEqual(ids(on.unshuffled), ["a", "x", "b", "c", "d"]);
  const off = rules.shuffleOff({ ...on, unshuffled: songs("a", "b", "c", "d") }, (id) => id === "c");
  assert.deepEqual(ids(off.queue), ["a", "x", "b", "d"], "behind the line, without the muted c");
  assert.equal(off.unshuffled, null);
});

test("cleared, or the hand-made part cleared: shuffle off brings none of it back", () => {
  const s = state(["a", "x", "c", "b"], { lineEnd: 2, unshuffled: songs("a", "x", "b", "c"), branches: [{ name: "Mix", trackId: "c", started: false, ids: ["c"] }] });
  const cleared = { ...s, ...rules.clearComing(s) };
  assert.deepEqual(ids(cleared.queue), ["a"]);
  assert.deepEqual(cleared.branches, []);
  assert.deepEqual(ids(rules.shuffleOff(cleared, () => false).queue), ["a"]);
  const handMade = { ...s, ...rules.clearHandMade(s) };
  assert.deepEqual(ids(handMade.queue), ["a", "c", "b"]);
  assert.deepEqual(ids(handMade.unshuffled), ["a", "b", "c"], "x is out of the order too");
});

test("turning shuffle off after branching from the current song restores the album tail", () => {
  const original = state(["a", "b", "c", "d"], { index: 1 });
  const mixed = { ...original, ...rules.shuffleOn(original, (tail) => [...tail].reverse()) };
  const branched = { ...mixed, ...rules.branchOff(mixed, songs("b", "x"), "Mix").state };
  assert.deepEqual(ids(branched.queue), ["a", "b", "x", "d", "c"]);
  assert.deepEqual(ids(rules.shuffleOff(branched, () => false).queue), ["a", "b", "x", "c", "d"]);
});

test("edited on another device: what it took out stays out, the rest after the cut stays, nothing at all is a clear", () => {
  const s = state(["a", "b", "c", "d", "e"], { unshuffled: songs("a", "b", "c", "d", "e"), branches: [{ name: "Mix", trackId: "c", started: false, ids: ["c", "d"] }] });
  const edit = rules.replaceComing(s, songs("b", "d"), 0, 4);
  assert.equal(edit.cleared, false);
  assert.deepEqual(ids(edit.state.queue), ["a", "b", "d", "e"], "e after the cut stays");
  assert.deepEqual(ids(edit.state.unshuffled), ["a", "b", "d", "e"], "c out of the order");
  assert.deepEqual(edit.state.branches[0].ids, ["d"], "and out of its branch");
  const clear = rules.replaceComing(s, [], 0, undefined);
  assert.equal(clear.cleared, true);
  assert.deepEqual(ids(clear.state.queue), ["a"]);
  assert.deepEqual(ids(clear.state.unshuffled), ["a"]);
});

test("shuffled, a branch from the very song playing: the song keeps its place in the list's own order, the branch right behind it", () => {
  // The album's own order a, cur, b, c, d; shuffled, d comes next. Branching off from cur, with e and f after it.
  const s = state(["a", "cur", "d", "b", "c"], { index: 1, unshuffled: songs("a", "cur", "b", "c", "d") });
  const { state: branched } = rules.branchOff(s, songs("cur", "e", "f"), "Mix");
  assert.deepEqual(ids(branched.queue), ["a", "cur", "e", "f", "d", "b", "c"]);
  assert.deepEqual(ids(branched.unshuffled), ["a", "cur", "e", "f", "b", "c", "d"], "cur stays where it was, the branch behind it");
  const off = rules.shuffleOff({ ...s, ...branched }, () => false);
  assert.deepEqual(ids(off.queue), ["a", "cur", "e", "f", "b", "c", "d"], "shuffle off: the branch, then the list's own order");
});

test("shuffled, a branch behind songs asked for by hand: those stay ahead of it in the list's own order too, one taken by the branch moves with it", () => {
  const s = state(["a", "cur", "x", "y", "d", "b"], { index: 1, lineEnd: 4, unshuffled: songs("a", "cur", "x", "y", "b", "d") });
  const { state: branched } = rules.branchOff(s, songs("y", "e"), "Mix");
  assert.deepEqual(ids(branched.queue), ["a", "cur", "x", "y", "e", "d", "b"]);
  assert.deepEqual(ids(branched.unshuffled), ["a", "cur", "x", "y", "e", "b", "d"], "x asked for by hand first, then the branch with y");
  assert.equal(new Set(ids(branched.unshuffled)).size, branched.unshuffled.length, "no song twice");
});

test("shuffled, one of two copies of a song taken out: shuffle off keeps the other", () => {
  const s = state(["a", "x", "b", "x", "c"]);
  const on = { ...s, ...rules.shuffleOn(s, (list) => [...list].reverse()) };
  assert.deepEqual(ids(on.queue), ["a", "c", "x", "b", "x"]);
  const out = { ...on, ...rules.removeEntry(on, ids(on.queue).indexOf("x")) };
  assert.equal(ids(out.queue).filter((id) => id === "x").length, 1, "one x taken out, one left");
  assert.deepEqual(ids(rules.shuffleOff(out, () => false).queue), ["a", "b", "x", "c"], "shuffle off: the other x stays, in the list's own order");
});

test("moved across the song playing: the line is counted from where it stands now, never past the end", () => {
  // A-B with B playing, X and Y asked for by hand; A moved behind Y.
  const moved = rules.moveEntry(state(["a", "b", "x", "y"], { index: 1, lineEnd: 4 }), 0, 3);
  assert.deepEqual(ids(moved.queue), ["b", "x", "y", "a"]);
  assert.equal(moved.index, 0);
  assert.equal(moved.lineEnd, 3, "x and y asked for by hand, a not");
  // The song playing moved past its line: what was asked for is behind it now.
  const past = rules.moveEntry(state(["b", "x", "y", "c"], { lineEnd: 3 }), 0, 2);
  assert.deepEqual(ids(past.queue), ["x", "y", "b", "c"]);
  assert.equal(past.index, 2);
  assert.equal(past.lineEnd, 0);
  // Within the line and out of it, as before.
  assert.equal(rules.moveEntry(state(["cur", "x", "y", "c"], { lineEnd: 3 }), 1, 2).lineEnd, 3, "x behind y: still both asked for");
  assert.equal(rules.moveEntry(state(["cur", "x", "y", "c"], { lineEnd: 3 }), 1, 3).lineEnd, 2, "x behind c: out of the line");
});

/* ------------------------------------------------------------- shuffle off with two copies (Codex, section 15) */

test("shuffle off with the list's own order read back, its copies no longer one of a kind: the copy as many times in as it's been heard", () => {
  const order = songs("a", "x", "b", "x", "c");
  const s = state(["a", "x", "b", "x", "c"], { index: 3, unshuffled: order });
  assert.deepEqual(ids(rules.shuffleOff(s, () => false).queue), ["a", "x", "b", "x", "c"]);
  const first = state(["a", "x", "b", "x", "c"], { index: 1, unshuffled: order });
  assert.deepEqual(ids(rules.shuffleOff(first, () => false).queue), ["a", "x", "b", "x", "c"]);
});

test("shuffle on makes the list's entries one of a kind, the one playing left as it is", () => {
  const x = { id: "x" };
  const list = [{ id: "a" }, x, { id: "b" }, x];
  const on = rules.shuffleOn({ queue: list, index: 3, lineEnd: 0 }, (rest) => rest);
  assert.equal(on.queue[3], x, "the entry playing is the same object");
  assert.notEqual(on.unshuffled[1], on.unshuffled[3], "the other copy is one of its own");
  assert.equal(on.unshuffled[1].id, "x");
});
