// The sync service says its version and documents at /health (sync-server/server.mjs); an app
// linked to one says when it's too old (src/lib/syncService.ts), and an app that isn't linked
// asks nothing (src/lib/syncEngine.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createSyncServer, VERSION } from "../sync-server/server.mjs";

async function load(file) {
  const out = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const { readServiceInfo, serviceProblem, problemKey, SYNC_SERVICE_MIN_VERSION, SYNC_UPDATE_COMMAND } = await load("../src/lib/syncService.ts");
const { createSyncEngine } = await load("../src/lib/syncEngine.ts");
const { toPlaylistDoc } = await load("../src/lib/playlistSync.ts");

const USER = "d".repeat(32);
let jellyfin;
let dataDir;
let service;
let base;
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

before(async () => {
  jellyfin = http.createServer((req, res) => {
    res.writeHead(req.url === "/Users/Me" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/Users/Me" ? { Id: USER } : {}));
  });
  const port = await listen(jellyfin);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-sync-version-"));
  service = createSyncServer({ dataDir, jellyfinUrl: `http://127.0.0.1:${port}` });
  base = `http://127.0.0.1:${await listen(service)}`;
});
after(() => {
  service.closeAllConnections();
  service.close();
  jellyfin.closeAllConnections();
  jellyfin.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the service says its version and documents, without a login", async () => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.service, "songsta-sync");
  assert.equal(health.api, 1, "what older apps read stays");
  assert.equal(health.version, VERSION);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  for (const name of ["playlists", "order", "groups", "albumedits", "albumpictures"]) assert.ok(health.docs.includes(name), name);
  assert.equal(serviceProblem(readServiceInfo(health)), null, "this service is new enough for this app");
});

test("a service from before the library's documents is too old; one that says nothing usable can't be judged", () => {
  const old = readServiceInfo({ ok: true, service: "songsta-sync", api: 1 });
  assert.deepEqual(serviceProblem(old), { missing: ["order", "groups", "albumedits", "albumpictures"] });
  assert.deepEqual(serviceProblem(readServiceInfo({ service: "songsta-sync", docs: ["playlists", "order", "groups"] })).missing, ["albumedits", "albumpictures"]);
  assert.equal(serviceProblem(readServiceInfo({ service: "songsta-sync", docs: ["order", "groups", "albumedits", "albumpictures"] })), null, "no version said: the documents decide");
  const behind = serviceProblem(readServiceInfo({ service: "songsta-sync", version: "1.4.0", docs: ["order", "groups", "albumedits", "albumpictures"] }));
  assert.equal(behind.version, "1.4.0", `below ${SYNC_SERVICE_MIN_VERSION}: too old whatever it lists`);
  assert.equal(readServiceInfo({ service: "jellyfin" }), null);
  assert.equal(readServiceInfo(null), null);
  assert.equal(serviceProblem(null), null);
  assert.notEqual(problemKey(serviceProblem(old)), problemKey(behind), "another problem is told again");
  assert.equal(SYNC_UPDATE_COMMAND, "docker compose pull && docker compose up -d");
});

/** An engine with a request log; `at` is where its service is (or isn't). */
function engineAt(at, oldService = false) {
  const log = [];
  const heard = [];
  const engine = createSyncEngine({
    deviceId: "dev",
    async request(method, url, body) {
      log.push(url.split("?")[0]);
      const res = await fetch(`${at}${url}`, {
        method,
        headers: { Authorization: 'MediaBrowser Token="t"', ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const reply = { status: res.status, body: await res.json() };
      if (oldService && url === "/health") reply.body = { ok: true, service: "songsta-sync", api: 1 };
      return reply;
    },
    readPlaylists: () => toPlaylistDoc({ playlists: [], folders: [] }),
    applyPlaylists() {},
    readPlayback: () => null,
    wantsPlayback: () => false,
    adoptPlayback() {},
    onService: (info) => heard.push(info),
  });
  return { engine, log, heard };
}

const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`waited in vain for ${what}`);
};

test("linked: what the service says is asked once per start", async (t) => {
  const { engine, log, heard } = engineAt(base);
  t.after(() => engine.stop());
  engine.start();
  await until(() => heard.length === 1, "the service's word");
  assert.equal(heard[0].version, VERSION);
  // More rounds of listening don't ask again.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(log.filter((u) => u === "/health").length, 1);
  engine.stop();
  engine.start();
  await until(() => heard.length === 2, "asked again at the next start");
});

test("linked to an old service: it's found too old", async (t) => {
  const { engine, heard } = engineAt(base, true);
  t.after(() => engine.stop());
  engine.start();
  await until(() => heard.length === 1, "the old service's word");
  assert.equal(serviceProblem(heard[0]).missing.length, 4);
});

test("not linked: no service answers, and nothing is asked of it beyond looking for it", async (t) => {
  // A port nothing listens on.
  const free = http.createServer();
  const port = await listen(free);
  await new Promise((r) => free.close(r));
  const { engine, log, heard } = engineAt(`http://127.0.0.1:${port}`);
  t.after(() => engine.stop());
  engine.start();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(engine.status(), "unreachable");
  assert.equal(heard.length, 0);
  assert.ok(!log.includes("/health"), `asked: ${log.join(", ")}`);
});
