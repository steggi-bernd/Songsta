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

/** Load the real stats module against a real persist layer. Reuses `dir` when given. */
async function loadStats(dir) {
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bytune-history-"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/stats.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false,
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, Buffer, setTimeout, clearTimeout,
    require: (name) => name === "electron" ? { app: { getPath: () => root } } : require(name),
  });
  const storeFile = () => path.join(root, "data", "listening-history.json");
  return {
    api: module.exports, dir: root, storeFile,
    // resetStats first: it clears the debounced flush timer, so a later test
    // never sees a write land in a directory this test already removed.
    close: () => { module.exports.resetStats(); if (!dir) fs.rmSync(root, { recursive: true, force: true }); },
  };
}
const track = (id, extra = {}) => ({ id, title: `t-${id}`, artist: "Artist", duration: 60, thumb: "", ...extra });
const bucket = (month, ms, extra = {}) => ({
  month,
  tracks: { a: { title: "t-a", artist: "Artist", thumb: "", ms, plays: 1, lastAt: 1 } },
  artists: { artist: { name: "Artist", ms, plays: 1 } },
  albums: {},
  hours: new Array(24).fill(0),
  days: { [`${month}-01`]: ms },
  ...extra,
});

test("listening lands in the listening-history store, not loose stats files", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(track("x"), 30_000);
    h.api.flushSync();
    assert.equal(fs.existsSync(path.join(h.dir, "data", "stats")), false);
    const raw = JSON.parse(fs.readFileSync(h.storeFile(), "utf-8"));
    assert.equal(raw.state.buckets.length, 1);
    assert.equal(raw.state.buckets[0].tracks.x.ms, 30_000);
  } finally { h.close(); }
});

test("Replay survives a reload", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(track("x"), 45_000);
    h.api.flushSync();
    // A fresh module instance over the same userData — what an app restart sees.
    const again = await loadStats(h.dir);
    try {
      again.api.initStats();
      assert.equal(again.api.summary("month").totalMs, 45_000);
      assert.equal(again.api.summary("month").plays, 1);
    } finally { again.close(); }
  } finally { h.close(); }
});

test("importAll (backup import) replaces every bucket", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(track("old"), 10_000);
    h.api.importAll([bucket("2098-12", 7_000)]);
    assert.deepEqual([...h.api.summary("all").months].map(String), ["2098-12"]);
    h.api.flushSync();
    const writtenMonths = JSON.parse(fs.readFileSync(h.storeFile(), "utf-8")).state.buckets.map((b) => String(b.month));
    assert.deepEqual(writtenMonths, ["2098-12"]);
  } finally { h.close(); }
});
test("legacy monthly stats files are recovered into the store once, then consumed", async () => {
  const h = await loadStats();
  try {
    const legacyDir = path.join(h.dir, "data", "stats");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "2026-09.json"), JSON.stringify(bucket("2026-09", 12_345)));
    fs.writeFileSync(path.join(legacyDir, "2026-08.json"), JSON.stringify(bucket("2026-08", 6_789)));
    fs.writeFileSync(path.join(legacyDir, "broken.json"), "{not json");
    h.api.initStats();
    assert.equal(h.api.summary("all").totalMs, 12_345 + 6_789);
    assert.deepEqual([...h.api.summary("all").months].map(String), ["2026-08", "2026-09"]);
    h.api.flushSync();
    // Consumed: a later reset that empties the store must not resurrect them.
    assert.equal(fs.existsSync(legacyDir), false);
    const again = await loadStats(h.dir);
    try {
      again.api.initStats();
      assert.equal(again.api.summary("all").totalMs, 12_345 + 6_789, "the store holds the recovered months");
    } finally { again.close(); }
  } finally { h.close(); }
});

test("live months win over an older legacy snapshot", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(track("fresh"), 1_000);
    h.api.flushSync();
    // A legacy file for an older month, with a much larger total. A fresh
    // module over the same userData is what the next launch sees.
    const legacyDir = path.join(h.dir, "data", "stats");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "2026-09.json"), JSON.stringify(bucket("2026-09", 999_999)));
    const again = await loadStats(h.dir);
    try {
      again.api.initStats();
      assert.equal(again.api.summary("month").totalMs, 1_000, "the live month is not regressed");
      assert.equal(again.api.summary("all").totalMs, 1_000 + 999_999, "the older month is still recovered");
      assert.equal(fs.existsSync(legacyDir), false, "consumed once imported");
    } finally { again.close(); }
  } finally { h.close(); }
});

test("a nested legacy snapshot from an older userData layout is recovered too", async () => {
  const h = await loadStats();
  try {
    const nested = path.join(h.dir, "data", "data", "stats");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "2026-07.json"), JSON.stringify(bucket("2026-07", 4_000)));
    h.api.initStats();
    assert.equal(h.api.summary("all").totalMs, 4_000);
    assert.equal(fs.existsSync(nested), false);
  } finally { h.close(); }
});

test("listening records cover art for albums", async () => {
  const h = await loadStats();
  try {
    h.api.initStats();
    h.api.recordListening(
      { id: "s1", title: "S", artist: "Adele", album: "30", duration: 60, thumb: "https://x/song.jpg", artistImage: "https://x/adele.jpg" },
      40_000
    );
    h.api.recordListening({ id: "s2", title: "S2", artist: "Adele", album: "30", duration: 60, thumb: "https://x/song2.jpg" }, 40_000);
    const all = h.api.summary("all");
    assert.equal(all.albums[0].thumb, "https://x/song.jpg", "first seen cover wins");
    // Round-trips through the store.
    h.api.flushSync();
    const again = await loadStats(h.dir);
    try {
      again.api.initStats();
      assert.equal(again.api.summary("all").albums[0].thumb, "https://x/song.jpg");
    } finally { again.close(); }
  } finally { h.close(); }
});
