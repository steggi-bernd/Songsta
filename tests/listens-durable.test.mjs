// The computer's listening journal (electron/listens.ts) keeps a play only once it's written (Codex's review,
// 2026-11-20): other devices' plays that couldn't be written make the call fail, so the reader asks for them
// again, and this computer's own plays wait for the next flush instead of being dropped.
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

async function load() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-journal-"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/listens.ts", import.meta.url))],
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
  return { api: module.exports, file: path.join(root, "data", "listens.jsonl"), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const block = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.kept`);
  fs.mkdirSync(file);
};
const unblock = (file) => {
  fs.rmdirSync(file);
  if (fs.existsSync(`${file}.kept`)) fs.renameSync(`${file}.kept`, file);
};
const shared = (n, device = "phone-1") => ({ device, at: 1_700_000_000_000 + n * 1000, id: `jf:${n}`, title: `Song ${n}`, artist: "Band", ms: 200_000 });
const devices = { "phone-1": { name: "Pixel", kind: "phone" } };

test("other devices' plays that couldn't be written fail the call and are new again next time", async () => {
  const h = await load();
  try {
    assert.equal((await h.api.noteRemoteListens([shared(1)], devices)).length, 1);
    block(h.file);
    await assert.rejects(h.api.noteRemoteListens([shared(2), shared(2)], devices), "a failed write fails the call");
    unblock(h.file);
    const again = Array.from(await h.api.noteRemoteListens([shared(2), shared(2)], devices));
    assert.equal(again.length, 1, "new now, once although it came twice");
    assert.equal(Array.from(await h.api.noteRemoteListens([shared(2)], devices)).length, 0, "and known from then on");
    const page = await h.api.readListens(undefined, 10);
    assert.deepEqual(Array.from(page.listens, (l) => l.title), ["Song 2", "Song 1"]);
  } finally {
    h.close();
  }
});

test("this computer's own plays wait for the next flush when a write fails", async () => {
  const h = await load();
  try {
    h.api.noteListen({ id: "a", title: "Song a", artist: "Band", album: "LP", duration: 200 }, 1_000);
    await h.api.flushListens();
    block(h.file);
    h.api.noteListen({ id: "b", title: "Song b", artist: "Band", album: "LP", duration: 200 }, 2_000);
    await h.api.flushListens();
    unblock(h.file);
    h.api.noteListen({ id: "c", title: "Song c", artist: "Band", album: "LP", duration: 200 }, 3_000);
    await h.api.flushListens();
    const page = await h.api.readListens(undefined, 10);
    assert.deepEqual(Array.from(page.listens, (l) => l.id), ["c", "b", "a"], "b came back in front of c");
  } finally {
    h.close();
  }
});

test("a line cut short doesn't swallow the next play, and lines written twice count once", async () => {
  const h = await load();
  try {
    assert.equal((await h.api.noteRemoteListens([shared(1)], devices)).length, 1);
    const once = fs.readFileSync(h.file, "utf8");
    // A broken write left half a line, and a part of a batch stood twice after another try.
    fs.appendFileSync(h.file, `${once}{"at":17`);
    const fresh = await load();
    // The same folder, read again by a fresh start of the module.
    fs.mkdirSync(path.dirname(fresh.file), { recursive: true });
    fs.copyFileSync(h.file, fresh.file);
    try {
      block(fresh.file);
      await assert.rejects(fresh.api.noteRemoteListens([shared(3)], devices));
      unblock(fresh.file);
      assert.equal(Array.from(await fresh.api.noteRemoteListens([shared(3)], devices)).length, 1);
      const page = await fresh.api.readListens(undefined, 10);
      assert.deepEqual(Array.from(page.listens, (l) => l.title), ["Song 3", "Song 1"]);
    } finally {
      fresh.close();
    }
  } finally {
    h.close();
  }
});
