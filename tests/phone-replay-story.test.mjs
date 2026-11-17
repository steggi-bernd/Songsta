// The phone's Replay story (mobile/src/replayStory.ts): new to you, mostly which genre, how it sounded
// and where it came from, as the computer's slides say it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const mobile = fileURLToPath(new URL("../mobile/src/", import.meta.url));
const out = await build({ stdin: { contents: `export * from "./replayStory";`, resolveDir: mobile, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, external: ["./stores/listens"] });
const { storyFacts, shareParts, pulseRows } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
const l = (id, day, ms = 200_000) => ({ id, at: T0 + day * DAY, ms, title: id, artist: "Band" });

test("new to you: the songs first played in the period, most played first; one heard before isn't", () => {
  const listens = [l("old", -10), l("old", 3), l("new1", 2), l("new2", 4), l("new2", 5), l("later", 40)];
  const f = storyFacts(listens, T0, T0 + 30 * DAY, () => undefined);
  assert.deepEqual(Array.from(f.fresh, (x) => x.id), ["new2", "new1"]);
  assert.equal(f.freshCount, 2);
  assert.equal(f.fresh[0].plays, 2);
});

test("genres, formats and sources, by time listened", () => {
  const facts = {
    "jf:a": { genre: "Rock; Indie", codec: "FLAC", bitsPerSample: 24, sampleRate: 96000 },
    "jf:b": { genre: "Jazz", codec: "FLAC", bitsPerSample: 16, sampleRate: 44100 },
    "local:c": { genre: "Rock", codec: "MPEG 1 Layer 3" },
  };
  const listens = [l("jf:a", 1, 300_000), l("jf:b", 2, 100_000), l("local:c", 3, 200_000), l("ss:d", 4, 50_000)];
  const f = storyFacts(listens, T0, T0 + 30 * DAY, (id) => facts[id]);
  assert.deepEqual(Array.from(f.genres, ([g, ms]) => [g, ms]), [["Rock", 500_000], ["Jazz", 100_000]], "a song's first genre counts");
  assert.equal(f.genreTotal, 600_000);
  assert.deepEqual({ ...f.formats }, { hires: 300_000, lossless: 100_000, lossy: 200_000 });
  assert.deepEqual({ ...f.sources }, { local: 200_000, jf: 400_000, ss: 50_000 });
});

test("a share bar: four parts and the rest", () => {
  const parts = shareParts([["a", 40], ["b", 30], ["c", 10], ["d", 10], ["e", 5], ["f", 5]], 100, "Other");
  assert.deepEqual(Array.from(parts, (p) => [p.label, p.share]), [["a", 0.4], ["b", 0.3], ["c", 0.1], ["d", 0.1], ["Other", 0.1]]);
  assert.deepEqual(Array.from(shareParts([], 0, "Other")), []);
});

test("the pulse: every day of this month up to today, quiet days included, with the day's longest song", () => {
  const now = new Date(2026, 10, 16, 20, 0);
  const at = (month, day, hour = 12) => new Date(2026, month, day, hour).getTime();
  const listens = [
    { id: "a", at: at(10, 3), ms: 100_000, title: "A", artist: "Band", thumb: "a.jpg" },
    { id: "b", at: at(10, 3, 18), ms: 300_000, title: "B", artist: "Band" },
    { id: "a", at: at(10, 9), ms: 50_000, title: "A", artist: "Band" },
    { id: "old", at: at(9, 30), ms: 999_000, title: "Old", artist: "Band" },
  ];
  const rows = pulseRows(listens, "month", now);
  assert.equal(rows.length, 16, "the 1st to the 16th");
  assert.ok(rows.every((r) => r.unit === "day"));
  assert.equal(rows[2].ms, 400_000);
  assert.equal(rows[2].top.id, "b", "the song played longest that day");
  assert.equal(rows[8].ms, 50_000);
  assert.equal(rows[0].ms, 0, "a quiet day stays in");
  assert.equal(rows[0].top, undefined);
  const last = pulseRows(listens, "lastMonth", now);
  assert.equal(last.length, 31, "all of October");
  assert.equal(last[29].ms, 999_000);
});

test("the pulse of a year goes by month; of all of it, the last twelve months", () => {
  const now = new Date(2026, 10, 16);
  const listens = [
    { id: "a", at: new Date(2026, 1, 10).getTime(), ms: 60_000, title: "A", artist: "Band" },
    { id: "a", at: new Date(2024, 5, 1).getTime(), ms: 60_000, title: "A", artist: "Band" },
  ];
  const year = pulseRows(listens, "year", now);
  assert.equal(year.length, 11, "January to November");
  assert.ok(year.every((r) => r.unit === "month"));
  assert.equal(year[1].ms, 60_000);
  const all = pulseRows(listens, "all", now);
  assert.equal(all.length, 12);
  assert.equal(new Date(all[0].at).getMonth(), 11, "from last December on");
  assert.equal(pulseRows([], "all", now).length, 1, "nothing played: this month alone");
});
