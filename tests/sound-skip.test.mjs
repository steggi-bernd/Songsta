// A local file FFmpeg can't read (electron/sound-library.ts): kept as "can't be measured" with the file's
// signature, so it isn't tried at every start, the count gets to its end, and it's tried again once the
// file changes. A file that isn't there (a drive away) is only left for this session.
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

/** The library with a stand-in FFmpeg that can't read anything; counts how often it's started. */
function load(root, lib) {
  const asked = [];
  const spawn = (_exe, args) => {
    asked.push(args[args.indexOf("-i") + 1]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("Invalid data found when processing input"));
      child.emit("close", 1);
    });
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
  return { api: module.exports, asked, sandbox };
}

test("a file FFmpeg can't read is left until it changes, and counted; a file that isn't there only for now", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-sound-skip-"));
  try {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify({ state: { soundAnalysisStarted: true, soundAnalysis: true }, version: 0 }));
    const broken = path.join(root, "Broken.m4a");
    fs.writeFileSync(broken, "not really audio");
    const lib = {
      folders: [],
      tracks: [
        { id: "local:broken", path: broken, mtime: 1000, size: 16, duration: 200, title: "Broken", artist: "A" },
        { id: "local:gone", path: path.join(root, "on-a-drive-away.flac"), mtime: 1000, size: 99, duration: 200, title: "Gone", artist: "A" },
      ],
    };
    const first = load(root, lib);
    await first.api.analyseLibrarySound();
    assert.deepEqual([...first.asked].sort(), [broken, lib.tracks[1].path].sort(), "both tried once");
    assert.deepEqual([...first.api.skippedSongs()].map((s) => s.id), ["local:broken"], "the one that's there can't be measured; the other may be back later");
    // Asked again in this session: neither is tried.
    await first.api.analyseLibrarySound();
    assert.equal(first.asked.length, 2);
    first.api.saveSoundIndexSync();

    // The next start: the unreadable file still isn't tried, the one away is.
    const second = load(root, lib);
    await second.api.analyseLibrarySound();
    assert.deepEqual([...second.asked], [lib.tracks[1].path]);
    assert.deepEqual([...second.api.skippedSongs()].map((s) => s.id), ["local:broken"]);

    // The file changed (another copy put in its place): tried again.
    lib.tracks[0] = { ...lib.tracks[0], mtime: 2000, size: 20 };
    const third = load(root, lib);
    await third.api.analyseLibrarySound();
    assert.ok(third.asked.includes(broken), "a changed file is tried again");

    // Why: the file can't be read.
    assert.deepEqual([...third.api.skippedSongs()].map((s) => s.reason), ["unreadable"]);
    // "Try again": tried at once, whatever its mark said.
    const before = third.asked.length;
    third.api.retrySkipped();
    await third.api.analyseLibrarySound();
    assert.ok(third.asked.length > before, "tried again on asking");

    // Gone from the library: its mark goes too.
    lib.tracks = [lib.tracks[1]];
    const fourth = load(root, lib);
    await fourth.api.analyseLibrarySound();
    assert.deepEqual([...fourth.api.skippedSongs()].map((s) => s.id), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
