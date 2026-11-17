// Where Songsta keeps its data (electron/data-place.ts): a move you ask for is copied at the next start,
// caches and locks left behind; the old copy stays until you remove it; back to the usual folder works;
// a move that can't work leaves everything where it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL("../electron/data-place.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
const place = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

function folders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-place-"));
  const usual = path.join(root, "Songsta");
  fs.mkdirSync(path.join(usual, "data"), { recursive: true });
  fs.writeFileSync(path.join(usual, "data", "library.json"), '{"liked":["a"]}');
  fs.writeFileSync(path.join(usual, "Local State"), "{}");
  fs.mkdirSync(path.join(usual, "Cache"), { recursive: true });
  fs.writeFileSync(path.join(usual, "Cache", "big"), "x".repeat(1000));
  fs.writeFileSync(path.join(usual, "lockfile"), "");
  fs.writeFileSync(path.join(usual, "data", "half.json.123.tmp"), "");
  return { root, usual, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const caches = (folder) => [path.join(folder, "data", "open-metadata.json"), path.join(folder, "lyrics-cache")];

test("where a move may go", () => {
  const { root, usual, close } = folders();
  try {
    assert.equal(place.whyNot("relative/path", usual, usual), "Choose a whole folder");
    assert.equal(place.whyNot(usual, usual, usual), "Your data is there already");
    assert.equal(place.whyNot(path.join(usual, "inside"), usual, usual), "That folder holds your data folder, or lies inside it");
    assert.equal(place.whyNot(root, usual, usual), "That folder holds your data folder, or lies inside it");
    fs.mkdirSync(path.join(root, "full"));
    fs.writeFileSync(path.join(root, "full", "x"), "");
    assert.equal(place.whyNot(path.join(root, "full"), usual, usual), "Choose an empty folder, or make a new one");
    assert.equal(place.whyNot(path.join(root, "new"), usual, usual), null, "a new folder");
  } finally {
    close();
  }
});

test("a move asked for happens at the next start: everything but caches and locks, the old copy kept", () => {
  const { root, usual, close } = folders();
  try {
    const target = path.join(root, "Elsewhere", "Songsta data");
    place.writeNote(usual, { moveTo: target });
    const { folder, note } = place.settlePlace(usual, caches);
    assert.equal(folder, target);
    assert.equal(fs.readFileSync(path.join(target, "data", "library.json"), "utf8"), '{"liked":["a"]}');
    assert.ok(fs.existsSync(path.join(target, "Local State")), "the key Chromium seals logins with comes along");
    assert.ok(!fs.existsSync(path.join(target, "Cache")) && !fs.existsSync(path.join(target, "lockfile")) && !fs.existsSync(path.join(target, "data", "half.json.123.tmp")));
    assert.deepEqual(note, { path: target, leftover: usual, moveTo: undefined, failed: undefined, clearCaches: undefined });
    // The next start: the same folder, nothing copied again.
    assert.equal(place.settlePlace(usual, caches).folder, target);
    // The old copy goes when asked; the note in the usual folder stays.
    place.removeLeftover(usual, usual);
    assert.deepEqual(fs.readdirSync(usual), [place.NOTE]);
  } finally {
    close();
  }
});

test("back to the usual folder: its stale copy gives way to the data in use", () => {
  const { root, usual, close } = folders();
  try {
    const target = path.join(root, "Elsewhere");
    place.writeNote(usual, { moveTo: target });
    place.settlePlace(usual, caches);
    // Used there for a while.
    fs.writeFileSync(path.join(target, "data", "library.json"), '{"liked":["a","b"]}');
    fs.writeFileSync(path.join(usual, "data", "only-old.json"), "{}");
    place.writeNote(usual, { ...place.readNote(usual), moveTo: usual });
    const { folder, note } = place.settlePlace(usual, caches);
    assert.equal(folder, usual);
    assert.equal(fs.readFileSync(path.join(usual, "data", "library.json"), "utf8"), '{"liked":["a","b"]}');
    assert.ok(!fs.existsSync(path.join(usual, "data", "only-old.json")), "the old copy's leftovers don't come back");
    assert.equal(note.path, undefined);
    assert.equal(note.leftover, target);
  } finally {
    close();
  }
});

test("a move that can't work leaves everything where it was, and says why", () => {
  const { root, usual, close } = folders();
  try {
    const full = path.join(root, "full");
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, "someone else's"), "");
    place.writeNote(usual, { moveTo: full });
    const { folder, note } = place.settlePlace(usual, caches);
    assert.equal(folder, usual);
    assert.equal(note.failed, "Choose an empty folder, or make a new one");
    assert.ok(fs.existsSync(path.join(usual, "data", "library.json")));
  } finally {
    close();
  }
});

test("the caches go at the next start when asked; nothing else does", () => {
  const { usual, close } = folders();
  try {
    fs.writeFileSync(path.join(usual, "data", "open-metadata.json"), "{}");
    fs.mkdirSync(path.join(usual, "lyrics-cache"));
    fs.writeFileSync(path.join(usual, "lyrics-cache", "a.json"), "{}");
    place.writeNote(usual, { clearCaches: true });
    place.settlePlace(usual, caches);
    assert.ok(!fs.existsSync(path.join(usual, "data", "open-metadata.json")) && !fs.existsSync(path.join(usual, "lyrics-cache")));
    assert.ok(fs.existsSync(path.join(usual, "data", "library.json")));
    assert.ok(!fs.existsSync(path.join(usual, place.NOTE)), "a note with nothing left in it goes");
  } finally {
    close();
  }
});
