// A queue's entries by id (src/lib/queueEntries.ts, part 3 of the protocol rework): the ids follow the
// queue through every change, an edit made on another device's copy comes out as edits of entries, and
// those land where their entries stand by the time they arrive, also when another device edited meanwhile.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/queueEntries.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const q = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const { createEntryBook, lineUp, editsBetween, applyEdits, editsFromList, readOps } = q;

/** A little random that comes out the same every run. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function lcsLength(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

test("lining up two orders finds a longest common run, in order, of equal songs", () => {
  const rnd = seeded(7);
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: Math.floor(rnd() * 30) }, () => "abcdefg"[Math.floor(rnd() * 7)]);
    const b = Array.from({ length: Math.floor(rnd() * 30) }, () => "abcdefg"[Math.floor(rnd() * 7)]);
    const pairs = lineUp(a, b, 100);
    assert.ok(pairs, "within reach");
    for (let k = 0; k < pairs.length; k++) {
      const [i, j] = pairs[k];
      assert.equal(a[i], b[j]);
      if (k) assert.ok(i > pairs[k - 1][0] && j > pairs[k - 1][1], "in order");
    }
    assert.equal(pairs.length, lcsLength(a, b), `round ${round}`);
  }
  assert.equal(lineUp(["a", "b", "c", "d"], ["d", "c", "b", "a"], 2), null, "too far apart for so few edits");
});

const keysOf = (list) => list.map((x) => x.split("#")[0]);

test("an entry keeps its id through a removal, a move, songs put in and a shuffle; of a song twice, the one taken out goes", () => {
  const book = createEntryBook();
  const list = ["a", "x#1", "b", "x#2", "c", "d"];
  book.follow(keysOf(list), 0);
  const id = Object.fromEntries(list.map((name, i) => [name, book.ids()[i]]));
  const session = book.session();
  // The first X goes: the second keeps its id.
  book.follow(["a", "b", "x", "c", "d"], 0);
  assert.deepEqual(book.ids(), [id.a, id.b, id["x#2"], id.c, id.d]);
  // D moved to the front of what comes.
  book.follow(["a", "d", "b", "x", "c"], 0);
  assert.deepEqual(book.ids(), [id.a, id.d, id.b, id["x#2"], id.c]);
  // Two songs put in: new ids, the others keep theirs.
  book.follow(["a", "d", "n", "o", "b", "x", "c"], 0);
  assert.equal(book.ids()[1], id.d);
  assert.equal(new Set(book.ids()).size, 7);
  // Shuffled: everything keeps its id.
  const before = new Map(["a", "d", "n", "o", "b", "x", "c"].map((k, i) => [k, book.ids()[i]]));
  const shuffled = ["a", "c", "o", "x", "d", "b", "n"];
  book.follow(shuffled, 0);
  assert.deepEqual(book.ids(), shuffled.map((k) => before.get(k)));
  assert.equal(book.session(), session, "all along the same list");
  // Another list altogether: a new session.
  book.follow(["p", "q", "r"], 0);
  assert.notEqual(book.session(), session);
});

test("a shuffle of a long queue keeps every entry's id", () => {
  const book = createEntryBook();
  const keys = Array.from({ length: 1200 }, (_, i) => `s${i}`);
  book.follow(keys, 0);
  const id = new Map(keys.map((k, i) => [k, book.ids()[i]]));
  const rnd = seeded(3);
  const rest = keys.slice(1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const session = book.session();
  book.follow([keys[0], ...rest], 0);
  assert.deepEqual(book.ids(), [keys[0], ...rest].map((k) => id.get(k)));
  assert.equal(book.session(), session);
});

/** A device playing a plain list, the way the stores apply edits (minus their rules for the line and branches). */
function playerOf(list, index = 0) {
  const book = createEntryBook();
  const state = { queue: [...list], index };
  const sync = () => book.follow(state.queue, state.index);
  sync();
  const player = {
    index: () => state.index,
    lineEnd: () => state.index + 1,
    songs: (tracks) => tracks.map((t) => (t.id === "missing" ? undefined : t.id)),
    key: (song) => song,
    remove(at) {
      state.queue.splice(at, 1);
      if (at < state.index) state.index -= 1;
      sync();
    },
    move(from, to) {
      const [x] = state.queue.splice(from, 1);
      state.queue.splice(to, 0, x);
      sync();
    },
    insert(songs, at) {
      state.queue.splice(Math.max(state.index + 1, at), 0, ...songs);
      sync();
    },
    clear() {
      state.queue.length = state.index + 1;
      sync();
    },
    clearLine() {},
  };
  return { book, state, player };
}

/** A device following it: its copy, with the ids the playing one said. */
function copyOf(playing) {
  const book = createEntryBook();
  book.seed([...playing.state.queue], playing.state.index, playing.book.ids(), playing.book.session());
  return { book, queue: [...playing.state.queue] };
}

/** An edit on a copy, as the edits to send: ids after the edit by the copy's book. */
function edit(copy, change) {
  const before = copy.book.ids();
  change(copy.queue);
  copy.book.follow([...copy.queue], 0);
  return editsBetween(before, copy.book.ids(), (j) => ({ id: copy.queue[j], title: copy.queue[j], artist: "", duration: 1 }));
}

test("two devices take out two songs of a 1,200-song queue at once, a third puts a song in behind place 1,000: all of it stays, in one order", () => {
  const list = Array.from({ length: 1200 }, (_, i) => `s${i}`);
  const playing = playerOf(list);
  const one = copyOf(playing);
  const two = copyOf(playing);
  const three = copyOf(playing);
  const first = edit(one, (queue) => queue.splice(queue.indexOf("s2"), 1));
  const second = edit(two, (queue) => queue.splice(queue.indexOf("s800"), 1));
  const third = edit(three, (queue) => queue.splice(1001, 0, "new"));
  assert.deepEqual(first.map((op) => op.op), ["remove"]);
  for (const ops of [second, first, third]) assert.equal(applyEdits(playing.book, ops, playing.player), "done");
  const expected = list.filter((s) => s !== "s2" && s !== "s800");
  expected.splice(expected.indexOf("s1000") + 1, 0, "new");
  assert.deepEqual(playing.state.queue, expected);
});

test("of a song in the queue twice, only the entry chosen goes; an entry gone meanwhile finds nothing", () => {
  const playing = playerOf(["a", "x", "b", "x", "c"]);
  const copy = copyOf(playing);
  const ops = edit(copy, (queue) => queue.splice(3, 1));
  assert.equal(applyEdits(playing.book, ops, playing.player), "done");
  assert.deepEqual(playing.state.queue, ["a", "x", "b", "c"]);
  assert.equal(applyEdits(playing.book, ops, playing.player), "partial", "the same entry again: already gone");
  assert.deepEqual(playing.state.queue, ["a", "x", "b", "c"]);
});

test("a move and songs put in land behind the entries they were put behind, wherever those are by then", () => {
  const playing = playerOf(["p", "a", "b", "c", "d", "e"]);
  const copy = copyOf(playing);
  // Here: E right behind A, and N, O behind C.
  const ops = edit(copy, (queue) => {
    queue.splice(queue.indexOf("e"), 1);
    queue.splice(queue.indexOf("a") + 1, 0, "e");
    queue.splice(queue.indexOf("c") + 1, 0, "n", "o");
  });
  // Meanwhile there: B went, D moved to the front of what comes.
  playing.player.remove(2);
  playing.player.move(3, 1);
  assert.deepEqual(playing.state.queue, ["p", "d", "a", "c", "e"]);
  assert.equal(applyEdits(playing.book, ops, playing.player), "done");
  assert.deepEqual(playing.state.queue, ["p", "d", "a", "e", "c", "n", "o"]);
});

test("an entry playing by the time a removal arrives plays on; the one playing where the edit was made may go", () => {
  const playing = playerOf(["a", "b", "c"]);
  const copy = copyOf(playing);
  const ops = edit(copy, (queue) => queue.splice(1, 1));
  playing.state.index = 1;
  playing.book.follow(playing.state.queue, 1);
  assert.equal(applyEdits(playing.book, ops, playing.player), "partial");
  assert.deepEqual(playing.state.queue, ["a", "b", "c"]);
  assert.equal(applyEdits(playing.book, ops, playing.player, playing.book.ids()[1]), "done");
  assert.deepEqual(playing.state.queue, ["a", "c"]);
});

test("songs put in on another device carry the ids it named, so its next edit finds them", () => {
  const playing = playerOf(["a", "b"]);
  const copy = copyOf(playing);
  const ops = edit(copy, (queue) => queue.push("n"));
  applyEdits(playing.book, ops, playing.player);
  const named = copy.book.ids()[2];
  assert.equal(playing.book.ids()[2], named);
  assert.equal(applyEdits(playing.book, edit(copy, (queue) => queue.pop()), playing.player), "done");
  assert.deepEqual(playing.state.queue, ["a", "b"]);
});

test("an edit from an older app that sends the whole list is lined up with the state it saw: another device's removal meanwhile stays", () => {
  const list = Array.from({ length: 1200 }, (_, i) => `s${i}`);
  const playing = playerOf(list);
  // Another device took out s800 already; this app saw the list before that, up to s800, and took out s2.
  playing.player.remove(800);
  const sent = list.slice(1, 801).filter((s) => s !== "s2");
  const ops = editsFromList(playing.book, sent, { ahead: 800, anchor: "s800" }, (j) => ({ id: sent[j], title: "", artist: "", duration: 1 }));
  assert.deepEqual(ops.map((op) => op.op), ["remove"]);
  applyEdits(playing.book, ops, playing.player);
  assert.deepEqual(playing.state.queue, list.filter((s) => s !== "s2" && s !== "s800"));
  assert.equal(editsFromList(playing.book, [], { ahead: 800 }, () => undefined), null, "nothing at all: a clear, taken as before");
  assert.equal(editsFromList(playing.book, ["z1", "z2", "z3"].concat(Array.from({ length: 200 }, (_, i) => `y${i}`)), { ahead: 800 }, () => undefined), null, "nothing like any state: taken as before");
});

test("edits read from another device: what isn't one is left out, songs stay with their ids", () => {
  const ops = readOps([
    { op: "remove", entry: "e1" },
    { op: "remove" },
    { op: "move", entry: "e2", after: ["e3", 4] },
    { op: "move", entry: "e2", after: ["e3", "e4", "e5", "e6"] },
    { op: "insert", after: [], tracks: [{ id: "a" }, null, { id: "c" }], entries: ["n1", "n2", "n3"] },
    { op: "clear" },
    "clearLine",
    null,
  ]);
  assert.deepEqual(ops, [
    { op: "remove", entry: "e1" },
    { op: "move", entry: "e2", after: ["e3", "e4", "e5"] },
    { op: "insert", after: [], tracks: [{ id: "a" }, { id: "c" }], entries: ["n1", "n3"] },
    { op: "clear" },
  ]);
  assert.deepEqual(readOps("nope"), []);
});

/* ------------------------------------------------------------- two devices' changes to one order (plan section 5) */

test("two devices' changes to one order both stay: moves either way, a song liked and one taken out", () => {
  const { mergeOrder } = q;
  const m = (base, mine, theirs) => mergeOrder([...base], [...mine], [...theirs]).join("");
  assert.equal(m("ABCD", "ABDC", "BACD"), "BADC", "C/D swapped here, A/B there");
  assert.equal(m("ABCD", "BACD", "ABDC"), "BADC", "the other way round, the same");
  assert.equal(m("ABCD", "ABD", "XABCD"), "XABD", "taken out here, liked there");
  assert.equal(m("ABCD", "XABCD", "ABD"), "XABD", "liked here, taken out there");
  assert.equal(m("ABCD", "ABCD", "DCBA"), "DCBA", "nothing changed here: theirs");
  assert.equal(m("ABCDE", "BCADE", "DABCE"), "DBCAE", "moved down here behind C, D moved up there");
  assert.equal(m("ABC", "CAB", "BAC"), "CBA", "put at the very top here: at the top there too");
  assert.equal(m("ABCD", "BCAD", "BCDA"), "BCAD", "the same song moved on both: where it was put here");
  assert.equal(m("ABCD", "BCDA", "BACD"), "BCDA", "put at the very end here: at the end there too");
});
