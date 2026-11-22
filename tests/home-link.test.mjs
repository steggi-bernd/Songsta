// Phones at home without a sync service (electron/home-link-server.ts): this computer runs the sync
// service for the devices paired with it. A phone finds it, pairs once with the code shown here, and
// gets in with its token from then on; wrong codes close the pairing, a removed phone is out.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../electron/home-link-server.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

let dir;
let state;
let link;
let base;
let changes = 0;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "home-link-"));
  state = m.newHomeLinkState();
  link = m.createHomeLink({
    dataDir: dir,
    name: () => "Study PC",
    read: () => state,
    write: (next) => {
      state = next;
    },
    changed: () => {
      changes += 1;
    },
    // Songs of this computer: one local song, the rest isn't its.
    async serveFile(id, req, res) {
      if (id !== "local:abc") return false;
      res.writeHead(req.headers.range ? 206 : 200, { "Content-Type": "audio/flac" });
      res.end(req.method === "HEAD" ? undefined : `song ${id} ${req.headers.range ?? "whole"}`);
      return true;
    },
  });
  await new Promise((resolve) => link.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${link.server.address().port}`;
});

after(async () => {
  link.server.closeAllConnections();
  await new Promise((resolve) => link.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const ask = async (method, pathname, body, token) => {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(token ? { Authorization: m.homeLinkAuthorization(token) } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const phone = (id = "phone-1", name = "Pixel") => ({ id, name, kind: "phone" });

test("a phone finds this computer by its name and id, and learns whether it may pair now", async () => {
  const hello = await ask("GET", "/v1/hello");
  assert.equal(hello.status, 200);
  assert.deepEqual(hello.body, { songsta: "home", api: 1, id: state.serviceId, name: "Study PC", pairing: false });
});

test("without the code shown here, nobody pairs; five wrong codes close the pairing", async () => {
  assert.equal((await ask("POST", "/v1/pair", { code: "000000", device: phone() })).status, 410, "nothing shown, nothing to pair with");
  const { code } = link.openPairing();
  assert.equal((await ask("GET", "/v1/hello")).body.pairing, true);
  const wrong = code === "111111" ? "222222" : "111111";
  for (let i = 0; i < m.PAIRING_TRIES; i++) assert.equal((await ask("POST", "/v1/pair", { code: wrong, device: phone() })).status, 403);
  assert.equal(link.pairing(), null, "closed after the fifth");
  assert.equal((await ask("POST", "/v1/pair", { code, device: phone() })).status, 410, "the right code is too late now");
  assert.deepEqual(state.devices, []);
});

test("the right code pairs once and hands out a token that gets the phone into the sync service", async () => {
  const before = changes;
  const { code } = link.openPairing();
  const paired = await ask("POST", "/v1/pair", { code: ` ${code} `, device: phone() });
  assert.equal(paired.status, 200);
  assert.equal(paired.body.id, state.serviceId);
  assert.equal(paired.body.name, "Study PC");
  assert.match(paired.body.token, /^[a-f0-9]{64}$/);
  assert.equal(state.devices.length, 1);
  assert.notEqual(state.devices[0].hash, paired.body.token, "only the token's hash is kept");
  assert.ok(changes > before, "the settings page hears of it");
  assert.equal(link.pairing(), null, "the code is used up");
  assert.equal((await ask("POST", "/v1/pair", { code, device: phone("phone-2") })).status, 410);

  const token = paired.body.token;
  assert.deepEqual((await ask("GET", "/v1/docs/playlists", null, token)).body, { rev: 0, updatedAt: 0, doc: null });
  const put = await ask("PUT", "/v1/docs/playlists", { rev: 0, doc: { lists: [] } }, token);
  assert.equal(put.status, 200);
  // This computer gets in with its own token, and sees the same documents.
  const own = await ask("GET", "/v1/docs/playlists", null, state.ownToken);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.doc, { lists: [] });
});

test("a token nobody paired gets nothing, and a phone taken off is out", async () => {
  assert.equal((await ask("GET", "/v1/docs/playlists")).status, 401, "no token");
  assert.equal((await ask("GET", "/v1/docs/playlists", null, "a".repeat(64))).status, 401, "a made-up token");
  const { code } = link.openPairing();
  const second = (await ask("POST", "/v1/pair", { code, device: phone("phone-2", "Tablet") })).body.token;
  assert.equal((await ask("GET", "/v1/devices", null, second)).status, 200);
  state = { ...state, devices: state.devices.filter((d) => d.id !== "phone-2") };
  assert.equal((await ask("GET", "/v1/devices", null, second)).status, 401);
});

test("pairing the same phone again replaces it: the old token stops working", async () => {
  const first = await (async () => {
    const { code } = link.openPairing();
    return (await ask("POST", "/v1/pair", { code, device: phone("phone-3", "Old name") })).body.token;
  })();
  const { code } = link.openPairing();
  const again = (await ask("POST", "/v1/pair", { code, device: phone("phone-3", "New name") })).body.token;
  assert.equal(state.devices.filter((d) => d.id === "phone-3").length, 1);
  assert.equal(state.devices.find((d) => d.id === "phone-3").name, "New name");
  assert.equal((await ask("GET", "/v1/devices", null, first)).status, 401);
  assert.equal((await ask("GET", "/v1/devices", null, again)).status, 200);
});

test("a pairing that doesn't name the device or comes too big is turned away", async () => {
  const { code } = link.openPairing();
  assert.equal((await ask("POST", "/v1/pair", { code })).status, 400);
  assert.equal((await ask("POST", "/v1/pair", { code, device: { id: "bad id with spaces", name: "x" } })).status, 400);
  const big = await fetch(`${base}/v1/pair`, { method: "POST", body: JSON.stringify({ code, device: phone(), pad: "x".repeat(10_000) }) }).catch(() => null);
  assert.ok(!big || big.status === 400, "too big");
  link.closePairing();
});

test("only the home network and this computer itself are let in", () => {
  for (const a of ["127.0.0.1", "::1", "192.168.0.77", "::ffff:10.1.2.3", "172.16.0.9", "172.31.255.1", "169.254.3.4", "fe80::1", "fd12:3456::1"]) assert.equal(m.fromHomeNetwork(a), true, a);
  for (const a of ["8.8.8.8", "::ffff:1.1.1.1", "172.32.0.1", "100.64.0.1", "2001:db8::1", "", undefined]) assert.equal(m.fromHomeNetwork(a), false, String(a));
});

test("a paired phone fetches this computer's songs with its files key, and nothing else does", async () => {
  const { code } = link.openPairing();
  const paired = (await ask("POST", "/v1/pair", { code, device: phone("phone-files", "Pixel") })).body;
  assert.match(paired.filesKey, /^[a-f0-9]{64}$/);
  assert.notEqual(paired.filesKey, paired.token, "a key of its own, not the token");
  const songAt = (id, key) => `${base}/v1/files/${Buffer.from(id).toString("base64url")}${key ? `?key=${key}` : ""}`;
  const got = await fetch(songAt("local:abc", paired.filesKey), { headers: { Range: "bytes=10-" } });
  assert.equal(got.status, 206, "the player's range goes along");
  assert.equal(await got.text(), "song local:abc bytes=10-");
  assert.equal((await fetch(songAt("local:other", paired.filesKey))).status, 404, "not a song of this computer");
  assert.equal((await fetch(songAt("local:abc"))).status, 401, "no key");
  assert.equal((await fetch(songAt("local:abc", paired.token))).status, 401, "the sync token doesn't open songs");
  assert.equal((await fetch(songAt("local:abc", "b".repeat(64)))).status, 401, "a made-up key");
  // The files key opens nothing of the sync service.
  assert.equal((await ask("GET", "/v1/docs/playlists", null, paired.filesKey)).status, 401);
  // Taken off: its key is out too.
  state = { ...state, devices: state.devices.filter((d) => d.id !== "phone-files") };
  assert.equal((await fetch(songAt("local:abc", paired.filesKey))).status, 401);
});
