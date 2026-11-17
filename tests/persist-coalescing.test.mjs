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

/** Load the REAL coalescing storage adapter with a counting backing store. */
async function loadCoalescedStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-coalesce-"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../src/lib/persist.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["zustand/middleware"],
  });
  const writes = [];
  const windowStub = {
    bytune: {
      readData: async () => null,
      writeData: async (name, data) => { writes.push({ name, data, at: Date.now() }); },
    },
    addEventListener(type, fn) { (windowStub[type] = windowStub[type] || []).push(fn); },
    removeEventListener() {},
  };
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    window: windowStub,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    require: (name) => require(name),
  });
  const { lazyJSONStorage, storage } = module.exports;
  return {
    lazyJSONStorage, plainStorage: storage, writes,
    firePagehide: () => { for (const fn of windowStub.pagehide ?? []) fn(); },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// The stores persist through lazyJSONStorage: its writes go through the coalescer tested here.
test("coalesced storage: a 4Hz burst writes to disk at most once per 2s window, last value wins", async () => {
  const h = await loadCoalescedStorage();
  try {
    const lazy = h.lazyJSONStorage();
    // Simulate 8 seconds of 4Hz library updates (download progress storm).
    for (let i = 0; i < 32; i++) {
      lazy.setItem("library", { state: { rev: i }, version: 0 });
      await new Promise((r) => setTimeout(r, 250));
    }
    // The uncoalesced adapter would have written 32 times; coalesced must be
    // far fewer (≤ once per 2s window + drain timing slack).
    assert.ok(h.writes.length <= 6, `expected ≤6 writes for a 32-event storm, got ${h.writes.length}`);
    // The last value must land once the window closes.
    await new Promise((r) => setTimeout(r, 2100));
    const last = h.writes.at(-1);
    assert.equal(last.data.state.rev, 31, "the newest value must be the one persisted");
  } finally { h.cleanup(); }
});

test("coalesced storage: pending writes flush on pagehide and removals are immediate", async () => {
  const h = await loadCoalescedStorage();
  try {
    const lazy = h.lazyJSONStorage();
    lazy.setItem("player", { state: { position: 42 }, version: 0 });
    assert.equal(h.writes.length, 1, "first write lands immediately (idle before it)");
    lazy.setItem("player", { state: { position: 99 }, version: 0 });
    lazy.setItem("library", { state: { downloads: 1 }, version: 0 });
    assert.equal(h.writes.length, 1, "burst inside the window must NOT hit disk yet");
    h.firePagehide();
    assert.equal(h.writes.length, 3, "pagehide must flush every pending store");
    assert.equal(
      JSON.stringify(h.writes.slice(1).map((w) => w.data.state)),
      JSON.stringify([{ position: 99 }, { downloads: 1 }]),
      "pagehide must flush the newest pending values"
    );
    await lazy.removeItem("library");
    assert.ok(h.writes.at(-1).data == null, "removal must write null immediately, not be coalesced");
  } finally { h.cleanup(); }
});

test("lazy JSON storage: only states that get written are stringified, the newest one wins", async () => {
  const h = await loadCoalescedStorage();
  try {
    let stringified = 0;
    const value = (rev) => ({ state: { toJSON: () => (stringified++, { rev }) }, version: 1 });
    const lazy = h.lazyJSONStorage();
    lazy.setItem("player", value(0));
    assert.equal(h.writes.length, 1, "first write lands immediately (idle before it)");
    for (let i = 1; i <= 20; i++) lazy.setItem("player", value(i));
    assert.equal(stringified, 1, "states superseded inside the window must never be stringified");
    h.firePagehide();
    assert.equal(stringified, 2, "the flush stringifies the pending state once");
    assert.equal(JSON.stringify(h.writes.at(-1).data), JSON.stringify({ state: { rev: 20 }, version: 1 }));
    assert.equal(await lazy.getItem("missing"), null);
  } finally { h.cleanup(); }
});
