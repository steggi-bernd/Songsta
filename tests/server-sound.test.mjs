// Server songs' sound (src/lib/serverSound.ts measures a short stretch, electron/sound-library.ts keeps
// it): what's measured for a Jellyfin or Navidrome song is kept beside the local songs' facts and
// handed back after a restart. A pattern that had lost its backslash once turned every real server id
// away, so nothing measured on a server was ever kept.
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

async function load(root) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/sound-library.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    write: false,
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, Buffer, setTimeout, clearTimeout, setImmediate, process,
    require: (name) => (name === "electron" ? { app: { getPath: () => root, isPackaged: false }, net: {} } : require(name)),
  });
  return module.exports;
}

const facts = { bpm: 121.4, key: 9, minor: true, energy: 0.62, loudness: -11.2 };

test("a server song's measurement is kept, by the ids Jellyfin and Navidrome really use", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-server-sound-"));
  try {
    const lib = await load(root);
    // Jellyfin: 32 hex characters; Navidrome: letters and digits, MD5 or base62.
    for (const id of ["jf:0f3a9c27b1d84e5f9a6b2c1d0e9f8a7b", "jf:4F3A9C27-B1D8-4E5F-9A6B-2C1D0E9F8A7B", "ss:3Kf9aZq0WvXc81LmNp2RsT", "ss:al-1b2c3d.mp3"]) {
      assert.equal(lib.keepServerSound(id, facts), true, id);
    }
    assert.deepEqual([...lib.measuredServerSongs()].sort(), ["jf:0f3a9c27b1d84e5f9a6b2c1d0e9f8a7b", "jf:4F3A9C27-B1D8-4E5F-9A6B-2C1D0E9F8A7B", "ss:3Kf9aZq0WvXc81LmNp2RsT", "ss:al-1b2c3d.mp3"].sort());
    const kept = lib.soundFacts()["jf:0f3a9c27b1d84e5f9a6b2c1d0e9f8a7b"];
    assert.equal(kept.bpm, 121.4);
    assert.equal(kept.excerpt, true, "marked as measured from a stretch");
    assert.equal(lib.soundStatus().server, 4);

    // Kept on disk: a restart hands them back.
    lib.saveSoundIndexSync();
    const again = await load(root);
    assert.equal(again.soundFacts()["ss:3Kf9aZq0WvXc81LmNp2RsT"].key, 9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a song that can't be measured is kept as such, counted, and tried again in a month", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-server-sound-"));
  try {
    const lib = await load(root);
    const short = "jf:00000000000000000000000000000abc";
    assert.equal(lib.skipServerSound(short, "short"), true);
    assert.deepEqual([...lib.skippedSongs()].map((s) => s.reason), ["short"], "and why");
    assert.deepEqual([...lib.skippedSongs()].map((s) => s.id), [short]);
    for (const id of ["local:abc", "jf:../x", 7, null]) assert.equal(lib.skipServerSound(id), false, String(id));
    // One measured already isn't marked.
    lib.keepServerSound("jf:11111111111111111111111111111111", facts);
    assert.equal(lib.skipServerSound("jf:11111111111111111111111111111111"), false);
    // Kept across a start.
    lib.saveSoundIndexSync();
    const again = await load(root);
    assert.deepEqual([...again.skippedSongs()].map((s) => s.id), [short]);
    // Measured after all (another try): no longer skipped.
    again.keepServerSound(short, facts);
    assert.deepEqual([...again.skippedSongs()].map((s) => s.id), []);
    // A mark older than a month is dropped at the start: tried again.
    const file = path.join(root, "analysis-cache", "sound.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.skipped = { "jf:22222222222222222222222222222222": `server@${Date.now() - 31 * 86_400_000}`, "jf:33333333333333333333333333333333": `server@${Date.now() - 86_400_000}`, "local:old": `1:2@${Date.now() - 5000}` };
    fs.writeFileSync(file, JSON.stringify(saved));
    const later = await load(root);
    assert.deepEqual([...later.skippedSongs()].map((s) => s.id).sort(), ["jf:33333333333333333333333333333333", "local:old"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("and nothing that isn't a server song's id or a measurement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-server-sound-"));
  try {
    const lib = await load(root);
    for (const id of ["local:abc", "jf:", "jf:../../etc", "jf:a b", "xx:123", 42]) assert.equal(lib.keepServerSound(id, facts), false, String(id));
    assert.equal(lib.keepServerSound("jf:abc", { ...facts, bpm: Number.NaN }), false);
    assert.equal(lib.keepServerSound("jf:abc", { ...facts, energy: 3 }), false);
    assert.equal(lib.keepServerSound("jf:abc", null), false);
    assert.equal(lib.measuredServerSongs().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
