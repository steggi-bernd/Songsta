// The shared listening history keeps a play only once it is on disk (Codex's review, 2026-11-20): a write
// that fails leaves nothing marked as stored, the device's next try stores it, and after a restart the play
// is there exactly once. Taking a device's plays out works the same way.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createSyncServer } from "../sync-server/server.mjs";

const ANNA = "c".repeat(32);
const jellyfin = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url === "/Users/Me" ? { Id: ANNA } : {}));
});
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const header = `MediaBrowser Client="Test", Device="T", DeviceId="t", Version="1", Token="anna"`;

let dataDir;
let jellyfinUrl;
let service;
let base;

async function start() {
  service = createSyncServer({ dataDir, jellyfinUrl });
  base = `http://127.0.0.1:${await listen(service)}`;
}
function stop() {
  service.closeAllConnections();
  service.close();
}
async function call(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: header, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  jellyfinUrl = `http://127.0.0.1:${await listen(jellyfin)}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-listens-"));
  await start();
});
after(() => {
  stop();
  jellyfin.closeAllConnections();
  jellyfin.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const at = Date.now() - 60_000;
const play = (n) => ({ at: at + n * 1000, id: `jf:${String(n).padStart(32, "0")}`, title: `Song ${n}`, artist: "Lumen Harbor", ms: 200_000 });
const device = { id: "pc-test", name: "Test PC", kind: "computer" };

test("a play whose write fails is stored by the next try, once, also after a restart", async () => {
  // A first play makes the user's folder and the file.
  assert.equal((await call("POST", "/v1/listens", { device, listens: [play(1)] })).body.added, 1);
  const file = path.join(dataDir, "users", ANNA, "listens.jsonl");
  assert.ok(fs.existsSync(file));

  // The file can't be written: a folder stands in its place.
  fs.renameSync(file, `${file}.kept`);
  fs.mkdirSync(file);
  const failed = await call("POST", "/v1/listens", { device, listens: [play(2), play(2)] });
  assert.equal(failed.status >= 500, true, "the failed write fails the request");

  // Fixed; the device sends the same plays again, as after any failed request.
  fs.rmdirSync(file);
  fs.renameSync(`${file}.kept`, file);
  const again = await call("POST", "/v1/listens", { device, listens: [play(2), play(2)] });
  assert.equal(again.status, 200);
  assert.equal(again.body.added, 1, "stored now, and once although it came twice in the same batch");
  assert.equal(again.body.count, 2);

  // Sent once more after a lost answer: nothing new.
  assert.equal((await call("POST", "/v1/listens", { device, listens: [play(2)] })).body.added, 0);

  // A restart reads exactly the two plays.
  stop();
  await start();
  const read = await call("GET", "/v1/listens?since=0");
  assert.deepEqual(read.body.listens.map((l) => l.title), ["Song 1", "Song 2"]);
});

test("a line cut short by a broken write doesn't swallow the next play", async () => {
  const file = path.join(dataDir, "users", ANNA, "listens.jsonl");
  // A write broke off in the middle of a line (the file doesn't end with a line break).
  fs.appendFileSync(file, '{"device":"pc-test","at":');
  stop();
  await start();
  assert.equal((await call("POST", "/v1/listens", { device, listens: [play(3)] })).body.added, 1);
  stop();
  await start();
  const read = await call("GET", "/v1/listens?since=0");
  assert.deepEqual(read.body.listens.map((l) => l.title), ["Song 1", "Song 2", "Song 3"]);
});

test("plays standing twice in the file count once", async () => {
  const file = path.join(dataDir, "users", ANNA, "listens.jsonl");
  // Part of a batch reached the file before its write failed, and the batch came again whole.
  const twice = JSON.stringify({ n: 9, device: "pc-test", ...play(3) });
  fs.appendFileSync(file, `${twice}\n`);
  stop();
  await start();
  const read = await call("GET", "/v1/listens?since=0");
  assert.deepEqual(read.body.listens.map((l) => l.title), ["Song 1", "Song 2", "Song 3"]);
});

test("taking a device's plays out can be tried again after a failed write", async () => {
  const file = path.join(dataDir, "users", ANNA, "listens.jsonl");
  const dir = path.dirname(file);
  // The rewrite can't replace the file: a folder stands where it writes its new copy.
  const blockers = [];
  for (const name of fs.readdirSync(dir)) if (name.startsWith("listens.jsonl.")) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  fs.renameSync(file, `${file}.kept`);
  fs.mkdirSync(file);
  blockers.push(file);
  const failed = await call("DELETE", "/v1/listens?device=pc-test");
  assert.equal(failed.status >= 500, true);
  fs.rmdirSync(file);
  fs.renameSync(`${file}.kept`, file);

  const read = await call("GET", "/v1/listens?since=0");
  assert.equal(read.body.count, 3, "nothing was taken out of memory when the write failed");
  const removed = await call("DELETE", "/v1/listens?device=pc-test");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, 3, "the second try finds the plays and takes them out");
  assert.equal(removed.body.count, 0);
  stop();
  await start();
  assert.equal((await call("GET", "/v1/listens?since=0")).body.count, 0);
});
