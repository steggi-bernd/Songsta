// Tempo, key and energy between two devices, through the real sync service and the real sync engine
// (src/lib/soundShare.ts, the "sounds" and "keys" documents): what the computer measured reaches the
// laptop, where the same file has another id, and isn't measured there again; a key set on one follows
// to the other; a key given back is given back on both; what the laptop measured itself stays its own
// and goes to the document too.
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
const share = await load("../src/lib/soundShare.ts");

const USER = "f".repeat(32);
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-sound-share-"));
  service = createSyncServer({ dataDir, jellyfinUrl: `http://127.0.0.1:${port}` });
  base = `http://127.0.0.1:${await listenOn(service)}`;
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

async function until(check, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`waited in vain for ${what}`);
}

const facts = (bpm, key, minor, extra = {}) => ({ bpm, key, minor, energy: 0.5, loudness: -12, introSilence: 0.2, outroSilence: 1.1, headDb: -35, tailDb: -30, ...extra });

/** A device as the apps build their hosts (src/lib/libraryDocs.ts, mobile/src/libraryDocs.ts): its copies, what it measured, its keys set by hand. */
function device(id, copies, { measured = {}, keys = {}, gone = {} } = {}) {
  const me = { measured: { ...measured }, keys: { ...keys }, gone: { ...gone }, adopted: [] };
  const copyOf = (cid) => copies.find((c) => c.id === cid);
  me.engine = createSyncEngine({
    deviceId: id,
    request: (method, url, body) => ask(method, url, body),
    readPlaylists: () => toPlaylistDoc({ playlists: [], folders: [] }),
    applyPlaylists() {},
    readPlayback: () => null,
    wantsPlayback: () => false,
    adoptPlayback() {},
    library: {
      sounds: {
        read: () => share.soundsDocOf(me.measured, copyOf),
        apply(doc) {
          for (const e of share.sharedFor(copies, doc, me.measured)) {
            me.measured[e.id] = e.facts;
            me.adopted.push(e.id);
          }
        },
      },
      keys: {
        read: () => share.keysDocOf(me.keys, me.gone, copyOf),
        apply(doc) {
          const c = share.keyChangesFor(copies, doc, me.keys, me.gone);
          for (const x of c.set) {
            me.keys[x.id] = { key: x.key, minor: x.minor, at: x.at };
            delete me.gone[x.id];
          }
          for (const x of c.back) {
            delete me.keys[x.id];
            me.gone[x.id] = x.at;
          }
        },
      },
    },
  });
  return me;
}

test("the computer's measurements and keys reach the laptop, a key given back is given back on both", async (t) => {
  const pc = device(
    "share-pc",
    [
      { id: "local:pc-night", title: "Night Ferry", artist: "Lumen Harbor", duration: 213 },
      { id: "jf:aaaa1111", title: "Low Orbit", artist: "Vela Moss", duration: 241 },
    ],
    { measured: { "local:pc-night": facts(98, 8, false), "jf:aaaa1111": facts(121, 9, true, { excerpt: true }) }, keys: { "local:pc-night": { key: 5, minor: false, at: Date.now() } } }
  );
  const laptop = device(
    "share-laptop",
    [
      // The same file, copied to the laptop: another path, another id.
      { id: "local:lt-night", title: "Night Ferry", artist: "Lumen Harbor", duration: 213.3 },
      { id: "jf:aaaa1111", title: "Low Orbit", artist: "Vela Moss", duration: 241 },
      { id: "local:lt-own", title: "Paper Boats", artist: "Lumen Harbor", duration: 199 },
    ],
    { measured: { "local:lt-own": facts(76, 2, true) } }
  );
  t.after(() => {
    pc.engine.stop();
    laptop.engine.stop();
  });
  pc.engine.start();
  await until(async () => ((await ask("GET", "/v1/docs/sounds")).body.doc?.songs ? true : false), "the computer's measurements on the service");
  laptop.engine.start();
  await until(() => laptop.adopted.length === 2, "the laptop takes the computer's measurements in");
  assert.deepEqual(laptop.adopted.sort(), ["jf:aaaa1111", "local:lt-night"]);
  assert.equal(laptop.measured["local:lt-night"].bpm, 98, "the copied file's measurement, not measured again");
  assert.equal(laptop.measured["jf:aaaa1111"].excerpt, true, "a server song's from a stretch stays one");
  assert.equal(laptop.measured["local:lt-own"].bpm, 76, "what it measured itself stays");
  await until(() => laptop.keys["local:lt-night"]?.key === 5, "the key set on the computer");

  // What the laptop measured itself goes to the document too.
  await until(async () => Object.keys((await ask("GET", "/v1/docs/sounds")).body.doc?.songs ?? {}).length === 3, "all three songs in the document");

  // Given back on the laptop: given back on the computer, and it doesn't come back.
  delete laptop.keys["local:lt-night"];
  laptop.gone["local:lt-night"] = Date.now() + 1;
  laptop.engine.libraryChanged("keys");
  await until(() => !pc.keys["local:pc-night"], "given back on the computer too");
  assert.ok(pc.gone["local:pc-night"] > 0);
  const doc = (await ask("GET", "/v1/docs/keys")).body.doc;
  assert.deepEqual(Object.values(doc.keys).map((e) => "v" in e), [false], "the document says it was given back");
});

test("a service from before the sound documents: they stay on each device, the rest syncs on", async (t) => {
  let asked = 0;
  const pc = device("old-share-pc", [{ id: "jf:bbbb2222", title: "X", artist: "Y", duration: 100 }], { measured: { "jf:bbbb2222": facts(100, 1, false, { excerpt: true }) } });
  const engine = createSyncEngine({
    deviceId: "old-share-pc-2",
    request: async (method, url, body) => {
      if (/\/v1\/docs\/(sounds|keys)/.test(url)) {
        asked += 1;
        return { status: 404, body: { error: "No such document" } };
      }
      return ask(method, url, body);
    },
    readPlaylists: () => toPlaylistDoc({ playlists: [], folders: [] }),
    applyPlaylists() {},
    readPlayback: () => null,
    wantsPlayback: () => false,
    adoptPlayback() {},
    library: { sounds: { read: () => ({}), apply() {} }, keys: { read: () => ({}), apply() {} } },
  });
  t.after(() => {
    engine.stop();
    pc.engine.stop();
  });
  engine.start();
  await until(() => asked >= 2, "asked once for each");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(engine.status(), "connected");
  engine.libraryChanged("sounds");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(asked <= 3, `not asked again and again (${asked})`);
});
