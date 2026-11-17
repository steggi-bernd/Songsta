// The listening history (electron/listens.ts): one line per listen, written when the listen
// counts as a play (electron/stats.ts), stamped with when it began — read newest first a page
// at a time, exported as a spreadsheet, kept on this computer.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

async function load(entry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-listens-"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(`../electron/${entry}.ts`, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    write: false,
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, Buffer, setTimeout, clearTimeout,
    require: (name) => (name === "electron" ? { app: { getPath: () => root } } : require(name)),
  });
  return { api: module.exports, root, file: path.join(root, "data", "listens.jsonl"), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
// Arrays made inside the module's sandbox carry its own prototype: compare plain copies.
const ids = (page) => Array.from(page.listens, (l) => l.id);
const track = (id, extra = {}) => ({ id, title: `Song ${id}`, artist: "Band", album: "LP", duration: 200, thumb: "", ...extra });

test("listens read back newest first, a page at a time", async () => {
  const h = await load("listens");
  try {
    h.api.noteListen(track("a"), 1_000);
    h.api.noteListen(track("b"), 3_000);
    h.api.noteListen(track("c"), 2_000);
    const first = await h.api.readListens(undefined, 2);
    assert.deepEqual(ids(first), ["b", "c"]);
    assert.equal(first.more, true);
    assert.equal(first.total, 3);
    const next = await h.api.readListens(first.listens[1].at, 2);
    assert.deepEqual(ids(next), ["a"]);
    assert.equal(next.more, false);
    // A line cut by a crash costs only that line.
    fs.appendFileSync(h.file, '{"at":4000,"id":"broken","tit\n');
    h.api.noteListen(track("d"), 5_000);
    assert.deepEqual(ids(await h.api.readListens()), ["d", "b", "c", "a"]);
  } finally {
    h.close();
  }
});

test("the spreadsheet: oldest first, quoted where needed, no formula ever runs", async () => {
  const h = await load("listens");
  try {
    h.api.noteListen(track("x", { title: 'Hello, "World"', artist: "=HYPERLINK(1)", album: "" }), Date.UTC(2026, 9, 31, 12, 0, 0));
    h.api.noteListen(track("y", { title: "First" }), Date.UTC(2026, 9, 30, 8, 0, 0));
    const { csv, count } = await h.api.listensCsv();
    assert.equal(count, 2);
    assert.ok(csv.startsWith("\ufeffListened at (UTC),Title,Artist,Album,Length (s),Device\r\n"), "with the device a play came from, empty for this computer's");
    const rows = csv.slice(1).trim().split("\r\n");
    assert.equal(rows[1], "2026-10-30T08:00:00.000Z,First,Band,LP,200,");
    assert.equal(rows[2], `2026-10-31T12:00:00.000Z,"Hello, ""World""",'=HYPERLINK(1),,200,`);
  } finally {
    h.close();
  }
});

test("clearing forgets every listen, written or waiting", async () => {
  const h = await load("listens");
  try {
    h.api.noteListen(track("a"), 1_000);
    await h.api.flushListens();
    h.api.noteListen(track("b"), 2_000);
    await h.api.clearListens();
    assert.equal(fs.existsSync(h.file), false);
    assert.equal((await h.api.readListens()).total, 0);
  } finally {
    h.close();
  }
});

test("a listen is written once, when it counts as a play, stamped with its start", async () => {
  const h = await load("stats");
  try {
    h.api.initStats();
    const t = track("song", { duration: 60 }); // counts at 30 s
    const before = Date.now();
    h.api.recordListening(t, 20_000);
    h.api.flushSync();
    assert.equal(fs.existsSync(h.file), false, "20 s is not a play yet");
    h.api.recordListening(t, 15_000);
    h.api.recordListening(t, 20_000); // more of the same listen: still one play
    h.api.flushSync();
    let lines = fs.readFileSync(h.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, "song");
    assert.equal(lines[0].title, "Song song");
    assert.equal(lines[0].duration, 60);
    // It began 35 s before it counted.
    assert.ok(Math.abs(lines[0].at - (before - 35_000)) < 2_000, `start ${lines[0].at - before}`);
    // Played again from the start: a second listen.
    h.api.noteTrackStart("song");
    h.api.recordListening(t, 31_000);
    h.api.flushSync();
    lines = fs.readFileSync(h.file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    // A reset drops what hasn't been written.
    h.api.noteTrackStart("song");
    h.api.recordListening(t, 31_000);
    h.api.resetStats();
    h.api.flushSync();
    assert.equal(fs.readFileSync(h.file, "utf8").trim().split("\n").length, 2);
  } finally {
    h.api.resetStats();
    h.close();
  }
});

test("the shared history: another device's plays come in once, with their device; only this computer's go out", async () => {
  const h = await load("listens");
  try {
    h.api.noteListen(track("mine"), 2_000_000_000_000);
    const theirs = [
      { n: 1, device: "phone-1", at: 1_999_000_000_000, id: "jf:1", title: "Song 1", artist: "Band", album: "LP", ms: 180_000 },
      { n: 2, device: "phone-1", at: 2_000_500_000_000, id: "jf:2", title: "Song 2", artist: "Band", ms: 200_000 },
    ];
    const fresh = await h.api.noteRemoteListens(theirs, { "phone-1": { name: "Pixel", kind: "phone" } });
    assert.equal(fresh.length, 2);
    assert.equal((await h.api.noteRemoteListens(theirs, {})).length, 0, "the same plays again: left out");
    const page = await h.api.readListens();
    assert.deepEqual(ids(page), ["jf:2", "mine", "jf:1"]);
    assert.equal(page.listens[0].deviceName, "Pixel");
    assert.equal(page.listens[0].deviceKind, "phone", "and what it is, for its sign in a narrow window");
    assert.equal(page.listens[0].duration, 200, "the length in seconds, as the history keeps it");
    assert.equal(page.listens[1].device, undefined, "this computer's own carries no device");
    const pending = await h.api.ownListensFrom(0, 100);
    assert.deepEqual(Array.from(pending.listens, (l) => l.id), ["mine"], "only this computer's plays go out");
    assert.equal(pending.total, 1);
    assert.equal((await h.api.ownListensFrom(1, 100)).listens.length, 0, "nothing after the ones sent");
  } finally {
    h.close();
  }
});

test("this computer's plays go out in the order they counted, whatever their clock said", async () => {
  const h = await load("listens");
  try {
    // A clock that ran a day ahead for one play, then was put right.
    h.api.noteListen(track("first"), 2_000_000_000_000);
    h.api.noteListen(track("ahead"), 2_000_000_000_000 + 86_400_000);
    const sent = await h.api.ownListensFrom(0, 100);
    assert.deepEqual(Array.from(sent.listens, (l) => l.id), ["first", "ahead"]);
    h.api.noteListen(track("after the fix"), 2_000_000_000_000 + 60_000);
    const next = await h.api.ownListensFrom(sent.total, 100);
    assert.deepEqual(Array.from(next.listens, (l) => l.id), ["after the fix"], "the play after it isn't held back");
    assert.deepEqual(Array.from((await h.api.ownListensFrom(1, 1)).listens, (l) => l.id), ["ahead"], "a page of one");
  } finally {
    h.close();
  }
});

test("played together: neighbours in the same session count, the nearer the more; another session doesn't", async () => {
  const h = await load("listens");
  try {
    const at = (min) => 2_000_000_000_000 + min * 60_000;
    const l = (id, min) => ({ at: at(min), id, title: id, artist: "Band", album: "LP", duration: 180 });
    const listens = [
      // One evening: a b SEED c d e
      l("a", 0), l("b", 3), l("seed", 6), l("c", 9), l("d", 12), l("e", 15),
      // Three hours later, another session: SEED-copy f
      l("seed-file", 200), l("f", 203),
      // Far away in the session: g is five songs after
      l("x1", 206), l("x2", 209), l("x3", 212), l("g", 215),
    ];
    const scores = h.api.scoreTogether(listens, ["seed", "seed-file"], at(300));
    const score = (id) => scores.find((s) => s.id === id)?.score ?? 0;
    assert.ok(score("b") > score("a"), "next to it counts more than two away");
    assert.ok(score("c") > score("d") && score("d") > score("e"));
    assert.ok(score("f") > 0, "the file's copy of the song counts as the song");
    assert.equal(score("g"), 0, "more than four songs away");
    assert.ok(!scores.some((s) => s.id === "seed" || s.id === "seed-file"), "not the song itself");
  } finally {
    h.close();
  }
});

test("played together: another device playing at the same time wasn't the same session", async () => {
  const h = await load("listens");
  try {
    const at = (min) => 2_000_000_000_000 + min * 60_000;
    const l = (id, min, device) => ({ at: at(min), id, title: id, artist: "Band", album: "LP", duration: 180, ...(device ? { device, deviceName: "Pixel", deviceKind: "phone" } : {}) });
    const listens = [
      // This computer: a SEED b
      l("a", 0), l("seed", 3), l("b", 6),
      // The phone in the car, the same minutes: p1 p2 p3
      l("p1", 1, "phone-1"), l("p2", 4, "phone-1"), l("p3", 7, "phone-1"),
      // And on the phone, the song in a session of its own there: q SEED r
      l("q", 100, "phone-1"), l("seed", 103, "phone-1"), l("r", 106, "phone-1"),
    ];
    const scores = h.api.scoreTogether(listens, ["seed"], at(300));
    const ids = Array.from(scores, (s) => s.id).sort();
    assert.deepEqual(ids, ["a", "b", "q", "r"], "the phone's car songs weren't played with the computer's");
  } finally {
    h.close();
  }
});
