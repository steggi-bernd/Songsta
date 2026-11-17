// What goes to your sync service, switch by switch (Settings → Network & privacy → Shared with your own
// servers): the library's order only while it's shared, the listening history only while it's shared
// and plays are kept at all (lib/listenSync.ts sharesListens), both apps the same. Every combination,
// against the real service and the real sync engine.
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
const { toPlaylistDoc } = await load("../src/lib/playlistSync.ts");
const { sharesListens } = await load("../src/lib/listenSync.ts");

const NOW = Date.now();
const play = (id, minutesAgo) => ({ at: NOW - minutesAgo * 60_000, id, title: `Song ${id}`, artist: "Lumen Harbor", album: "Lanterns", ms: 200_000 });
const USER = "e".repeat(32);

let jellyfin;
let service;
let dataDir;
let base;
const listenOn = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
before(async () => {
  jellyfin = http.createServer((req, res) => {
    res.writeHead(req.url === "/Users/Me" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/Users/Me" ? { Id: USER } : {}));
  });
  const port = await listenOn(jellyfin);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-share-switches-"));
  service = createSyncServer({ dataDir, jellyfinUrl: `http://127.0.0.1:${port}` });
  base = `http://127.0.0.1:${await listenOn(service)}`;
  // Another device's plays are there already: a device that shares takes them in.
  await ask("POST", "/v1/listens", { device: { id: "phone-before", name: "Pixel", kind: "phone" }, listens: [play("jf:p1", 50), play("jf:p2", 40)] });
});
after(() => {
  service.closeAllConnections();
  service.close();
  jellyfin.closeAllConnections();
  jellyfin.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function ask(method, url, body) {
  const res = await fetch(`${base}${url}`, { method, headers: { Authorization: `MediaBrowser Token="t"`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`waited in vain for ${what}`);
}

/** A device as the apps build it: the hosts behind getters that read the switches each time. */
function device(id, settings) {
  const me = { log: [], took: [], sentUpTo: 0, order: { pins: { at: NOW, v: [`album:${id}|one`] } }, merged: null };
  const own = [play(`jf:${id}-1`, 30), play(`jf:${id}-2`, 20)];
  const listenHost = {
    device: () => ({ name: id, kind: "computer" }),
    pending: async (max) => own.slice(me.sentUpTo, me.sentUpTo + max),
    sent: (last) => {
      me.sentUpTo = own.indexOf(last) + 1;
    },
    readUpTo: () => 0,
    take(listens) {
      me.took.push(...listens);
    },
    missing() {},
  };
  const libraryHosts = {
    order: {
      read: () => me.order,
      apply(doc) {
        me.order = doc;
      },
      lastMerge: () => me.merged,
      merged(rev) {
        me.merged = { rev, changed: false };
      },
    },
  };
  me.engine = createSyncEngine({
    deviceId: id,
    async request(method, url, body) {
      me.log.push(`${method} ${url.split("?")[0]}`);
      return ask(method, url, body);
    },
    readPlaylists: () => toPlaylistDoc({ playlists: [], folders: [] }),
    applyPlaylists() {},
    readPlayback: () => null,
    wantsPlayback: () => false,
    adoptPlayback() {},
    get library() {
      return settings.shareLibrary ? libraryHosts : undefined;
    },
    get listens() {
      return sharesListens(settings) ? listenHost : undefined;
    },
  });
  return me;
}

const asked = (me, re) => me.log.some((line) => re.test(line));

test("every combination of the share switches: only what's shared goes to the service, only what's kept comes in", async (t) => {
  const combos = [];
  for (const shareLibrary of [false, true]) for (const shareListens of [false, true]) for (const recordListening of [false, true]) combos.push({ shareLibrary, shareListens, recordListening });
  const devices = combos.map((settings, i) => ({ settings, me: device(`combo-${i}`, settings) }));
  t.after(() => devices.forEach(({ me }) => me.engine.stop()));
  for (const { me } of devices) me.engine.start();
  // Every device has had its rounds: the playlists are always synced, the rest only where shared.
  await until(() => devices.every(({ me }) => asked(me, /\/v1\/docs\/playlists/)), "a round on every device");
  await until(
    () => devices.every(({ settings, me }) => (!settings.shareLibrary || me.merged) && (!sharesListens(settings) || (me.took.length >= 2 && me.sentUpTo === 2))),
    "the shared things through"
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const { settings, me } of devices) {
    const what = JSON.stringify(settings);
    assert.equal(asked(me, /\/v1\/docs\/order/), settings.shareLibrary, `library order asked about with ${what}`);
    const history = settings.shareListens && settings.recordListening;
    assert.equal(asked(me, /\/v1\/listens/), history, `listening history asked about with ${what}`);
    assert.equal(me.took.length > 0, history, `others' plays taken in with ${what}`);
    assert.equal(me.sentUpTo > 0, history, `own plays sent with ${what}`);
  }
  // What the service ends up with: only the sharing devices' plays and order.
  const all = await ask("GET", "/v1/listens?since=0");
  const fromDevices = new Set(all.body.listens.map((l) => l.device));
  devices.forEach(({ settings }, i) => assert.equal(fromDevices.has(`combo-${i}`), sharesListens(settings), `combo-${i}'s plays on the service`));
});

test("switched on while running (the apps start the sync again): the history goes out from then on", async (t) => {
  const settings = { shareLibrary: false, shareListens: true, recordListening: false };
  const me = device("flip", settings);
  t.after(() => me.engine.stop());
  me.engine.start();
  await until(() => asked(me, /\/v1\/docs\/playlists/), "the first round");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!asked(me, /\/v1\/listens/), "nothing while plays aren't kept");
  // "Keep my plays" back on: the apps stop the engine and start it again (lib/homeSync.ts, mobile/src/sync.ts).
  settings.recordListening = true;
  me.engine.stop();
  me.engine.start();
  await until(() => me.sentUpTo === 2 && me.took.length >= 2, "the history shared once plays are kept");
  // And off again: nothing more goes out.
  settings.shareListens = false;
  me.engine.stop();
  const before = me.log.length;
  me.engine.start();
  await until(() => me.log.slice(before).some((l) => /\/v1\/changes/.test(l)), "a round after switching off");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!me.log.slice(before).some((l) => /\/v1\/listens/.test(l)), "nothing about the history once it's off");
});

test("the rule both apps use", () => {
  assert.equal(sharesListens({ shareListens: true, recordListening: true }), true);
  assert.equal(sharesListens({ shareListens: true, recordListening: false }), false, "nothing kept here, nothing shared");
  assert.equal(sharesListens({ shareListens: false, recordListening: true }), false);
  assert.equal(sharesListens({ shareListens: false, recordListening: false }), false);
});
