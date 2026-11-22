// What a device tells another goes out in the order it was said (src/lib/syncEngine.ts): a list takes two
// requests (its document, then its word), and a quick word after it used to overtake it, so a play chosen
// first landed after a later one (Codex, 2026-11-21).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/syncEngine.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { createSyncEngine } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

function engineWith(request) {
  return createSyncEngine({
    deviceId: "phone",
    request,
    readPlaylists: () => ({ playlists: [], folders: [], deleted: {} }),
    applyPlaylists() {},
    readPlayback: () => ({
      note: { device: { id: "phone", name: "Phone" }, at: Date.now(), playing: true, positionMs: 0, track: { id: "s", title: "S", artist: "A", duration: 100 }, queueId: "q" },
      queue: () => ({ id: "q", tracks: [] }),
    }),
    wantsPlayback: () => false,
    adoptPlayback() {},
    readLikes: () => [],
    readMuted: () => ({ at: 1, tracks: [] }),
    applyMuted() {},
    linked: () => true,
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a list whose document is slow to store still goes out before the word said after it", async () => {
  const words = [];
  const engine = engineWith(async (method, path, body) => {
    if (method === "PUT") await wait(40);
    if (method === "POST") words.push(body.command.action);
    return { status: 200, body: {} };
  });
  const list = engine.sendList("pc", [{ id: "a", title: "A", artist: "X", duration: 10 }], undefined, { action: "playList", start: 0 });
  const next = engine.sendCommand("pc", { action: "jump", trackId: "b", by: 1 });
  assert.deepEqual(await Promise.all([list, next]), [true, true]);
  assert.deepEqual(words, ["playList", "jump"]);
});

test("a hand-over waits its turn too, and a word that fails doesn't hold up the next one", async () => {
  const words = [];
  let first = true;
  const engine = engineWith(async (method, path, body) => {
    if (method === "POST") {
      words.push(body.command.action);
      if (first) {
        first = false;
        await wait(30);
        throw new Error("no answer");
      }
    }
    return { status: 200, body: {} };
  });
  const pause = engine.sendCommand("pc", { action: "pause" });
  const handed = engine.handOver("pc");
  const play = engine.sendCommand("pc", { action: "play" });
  assert.deepEqual(await Promise.all([pause, handed, play]), [false, true, true]);
  assert.deepEqual(words, ["pause", "takeOver", "play"]);
});
