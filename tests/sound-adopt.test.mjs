// Measurements another device made, taken in (electron/sound-library.ts adoptSounds): a file here gets
// one with its own signature and isn't measured again, a server song keeps what came; only songs that
// are here and not measured yet; what doesn't read is left out; kept on disk.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

const electronDir = fileURLToPath(new URL("../electron/", import.meta.url));
const stubs = {
  transcode: `export const ffmpegStatus = () => ({ path: "C:/stand-in/ffmpeg.exe", version: "stand-in" });`,
  "local-library": `export const readLocalLibrary = () => globalThis.__lib;`,
};
const { outputFiles } = await build({
  entryPoints: [path.join(electronDir, "sound-library.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        for (const [name, contents] of Object.entries(stubs)) {
          b.onLoad({ filter: new RegExp(`[\\\\/]electron[\\\\/]${name}\\.ts$`) }, () => ({ contents, loader: "ts" }));
        }
      },
    },
  ],
});

/** The analysis with a stand-in FFmpeg that reads nothing: what it's started for is noted. */
function load(root, lib) {
  const asked = [];
  const spawn = (_exe, args) => {
    asked.push(args[args.indexOf("-i") + 1]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => child.emit("close", 1));
    return child;
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, console: { ...console, warn() {} }, Buffer, setTimeout, clearTimeout, setImmediate, process,
    require: (name) => (name === "electron" ? { app: { getPath: () => root, isPackaged: false } } : name === "child_process" ? { spawn } : require(name)),
  };
  sandbox.globalThis = sandbox;
  sandbox.__lib = lib;
  vm.runInNewContext(outputFiles[0].text, sandbox);
  return { api: module.exports, asked };
}

const whole = { bpm: 98, key: 8, minor: false, energy: 0.44, loudness: -12.5, introSilence: 0.3, outroSilence: 1.2, headDb: -38, tailDb: -31 };

test("taken in: a file isn't measured again, a server song keeps what came, the odd ones are left out", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-sound-adopt-"));
  try {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify({ state: { soundAnalysisStarted: true, soundAnalysis: true }, version: 0 }));
    const fileA = path.join(root, "A.flac");
    const fileB = path.join(root, "B.flac");
    fs.writeFileSync(fileA, "a");
    fs.writeFileSync(fileB, "b");
    const lib = {
      folders: [],
      tracks: [
        { id: "local:a", path: fileA, mtime: 1000, size: 1, duration: 213, title: "A", artist: "X" },
        { id: "local:b", path: fileB, mtime: 1000, size: 1, duration: 100, title: "B", artist: "X" },
      ],
    };
    const first = load(root, lib);
    const taken = first.api.adoptSounds([
      { id: "local:a", facts: whole },
      { id: "jf:0f3a9c27b1d84e5f9a6b2c1d0e9f8a7b", facts: { ...whole, excerpt: true } },
      { id: "local:not-here", facts: whole },
      { id: "local:b", facts: { ...whole, bpm: 9999 } },
      { id: "../etc", facts: whole },
      null,
      42,
    ]);
    assert.equal(taken, 2);
    const known = first.api.soundFacts();
    assert.equal(known["local:a"].introSilence, 0.3, "a whole measurement with its ends");
    assert.equal(known["jf:0f3a9c27b1d84e5f9a6b2c1d0e9f8a7b"].excerpt, true);
    assert.equal(known["local:b"], undefined);
    assert.equal(first.api.adoptSounds([{ id: "local:a", facts: { ...whole, bpm: 50 } }]), 0, "measured here already: kept as it is");
    assert.equal(first.api.adoptSounds("nonsense"), 0);
    // The analysis: only B is left to measure.
    await first.api.analyseLibrarySound();
    assert.deepEqual([...first.asked], [fileB]);
    first.api.saveSoundIndexSync();

    // The next start: what was taken in is still there, and A still isn't measured.
    const second = load(root, lib);
    assert.equal(second.api.soundFacts()["local:a"].bpm, 98);
    await second.api.analyseLibrarySound();
    assert.ok(!second.asked.includes(fileA));
    // The file changed: measured here after all.
    lib.tracks[0] = { ...lib.tracks[0], mtime: 2000 };
    const third = load(root, lib);
    await third.api.analyseLibrarySound();
    assert.ok(third.asked.includes(fileA), "a changed file is measured here");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
