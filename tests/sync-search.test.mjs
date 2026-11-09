// Looking for the sync service (src/lib/syncEngine.ts): most people have none. Until one ever
// answered for this server, it's looked for once a start and when asked ("Search again", a new
// address), and nothing else is sent; once one has, it's kept in reach and retried as before.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createSyncServer } from "../sync-server/server.mjs";

async function load(file) {
  const out = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const { createSyncEngine } = await load("../src/lib/syncEngine.ts");
const { toPlaylistDoc, toWireTrack } = await load("../src/lib/playlistSync.ts");

const USER = "e".repeat(32);
let jellyfin;
let jellyfinUrl;
const dirs = [];
const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  jellyfin = http.createServer((req, res) => {
    res.writeHead(req.url === "/Users/Me" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/Users/Me" ? { Id: USER } : {}));
  });
  jellyfinUrl = `http://127.0.0.1:${await listen(jellyfin)}`;
});
after(() => {
  jellyfin.closeAllConnections();
  jellyfin.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A sync service on that port, started now. */
async function serviceOn(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-sync-search-"));
  dirs.push(dir);
  const server = createSyncServer({ dataDir: dir, jellyfinUrl });
  await listen(server, port);
  return () => {
    server.closeAllConnections();
    server.close();
  };
}

/** A port nothing listens on, for now. */
async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  return port;
}

function device(port, linkedAtFirst) {
  const memory = { linked: linkedAtFirst };
  const log = [];
  const statuses = [];
  const engine = createSyncEngine({
    deviceId: "dev",
    async request(method, url, body) {
      log.push(`${method} ${url.split("?")[0]}`);
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { Authorization: 'MediaBrowser Token="t"', ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    },
    readPlaylists: () => toPlaylistDoc({ playlists: [], folders: [] }),
    applyPlaylists() {},
    readPlayback: () => ({
      note: { device: { id: "dev", name: "dev" }, at: Date.now(), playing: true, positionMs: 0, track: toWireTrack({ id: "s", title: "S", artist: "A", duration: 100 }), queueId: "q" },
      queue: () => ({ id: "q", tracks: [] }),
    }),
    wantsPlayback: () => false,
    adoptPlayback() {},
    readLikes: () => [],
    readMuted: () => ({ at: 1, tracks: [] }),
    applyMuted() {},
    onStatus: (s) => statuses.push(s),
    linked: () => memory.linked,
    onLinked: () => (memory.linked = true),
  });
  return { engine, log, statuses, memory };
}

test("never found here: looked for once at the start, then nothing, whatever happens on the device", async (t) => {
  const port = await freePort();
  const { engine, log } = device(port, false);
  t.after(() => engine.stop());
  engine.start();
  await sleep(300);
  // Things happen here meanwhile: none of them goes out.
  engine.playbackChanged();
  engine.likesChanged();
  engine.mutedChanged();
  engine.playlistsChanged();
  engine.libraryChanged?.("order");
  await sleep(7000);
  assert.deepEqual(log, ["GET /v1/changes"], "one look, past the first retry's 5 s");
  assert.equal(engine.status(), "unreachable");
});

test("a service started later is found when asked, and from then on it's known", async (t) => {
  const port = await freePort();
  const { engine, log, statuses, memory } = device(port, false);
  t.after(() => engine.stop());
  engine.start();
  await sleep(300);
  const stop = await serviceOn(port);
  t.after(stop);
  await sleep(1000);
  assert.equal(log.length, 1, "not found by itself");
  engine.searchAgain();
  assert.equal(statuses.at(-1), "connecting", "the search shows");
  for (let i = 0; i < 100 && engine.status() !== "connected"; i++) await sleep(50);
  assert.equal(engine.status(), "connected");
  assert.equal(memory.linked, true, "remembered as found");
});

test("a new address, or the next start, looks again", async (t) => {
  const port = await freePort();
  const { engine, log } = device(port, false);
  t.after(() => engine.stop());
  engine.start();
  await sleep(300);
  engine.retryNow();
  await sleep(300);
  assert.equal(log.filter((l) => l.startsWith("GET /v1/changes")).length, 2);
  engine.stop();
  engine.start();
  await sleep(300);
  assert.equal(log.filter((l) => l.startsWith("GET /v1/changes")).length, 3);
});

test("a known service that's away for a while is retried and back within seconds, as before", async (t) => {
  const port = await freePort();
  const { engine, log } = device(port, true);
  t.after(() => engine.stop());
  engine.start();
  await sleep(500);
  assert.equal(engine.status(), "unreachable");
  const stop = await serviceOn(port);
  t.after(stop);
  for (let i = 0; i < 160 && engine.status() !== "connected"; i++) await sleep(50);
  assert.equal(engine.status(), "connected", "back by the first retry (5 s)");
  assert.ok(log.filter((l) => l.startsWith("GET /v1/changes")).length >= 2);
});
