// How the library is organised, the same on every device (src/lib/librarySync.ts): the documents'
// shapes and merges, then two devices' engines (src/lib/syncEngine.ts) against the real sync
// service (sync-server/server.mjs), a new one and one from before these documents.
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

const lib = await load("../src/lib/librarySync.ts");
const { createSyncEngine } = await load("../src/lib/syncEngine.ts");
const { toPlaylistDoc } = await load("../src/lib/playlistSync.ts");
const {
  albumEditsDoc,
  albumEditsFrom,
  canonical,
  latestMoment,
  mergeAlbumEditsDocs,
  mergeAlbumPicturesDocs,
  mergeGroupsDocs,
  mergeOrderDocs,
  mergePlayed,
  MAX_PLAYED_SYNCED,
  OLD_ON_COMPUTER,
  OLD_ON_PHONE,
  readAlbumEditsDoc,
  readAlbumPicturesDoc,
  readGroupsDoc,
  readOrderDoc,
  restamp,
  sameLibraryDoc,
  stampClock,
  withOwnPins,
} = lib;

const PICTURE = `data:image/jpeg;base64,${Buffer.from("not really a jpeg").toString("base64")}`;
const OTHER_PICTURE = `data:image/jpeg;base64,${Buffer.from("another one").toString("base64")}`;

/* ------------------------------------------------------------ the documents */

test("the later change wins, whichever side it's on", () => {
  const older = { sort: { at: 1000, v: "alpha" }, pins: { at: 1000, v: ["album:a"] } };
  const newer = { sort: { at: 2000, v: "artist" }, pins: { at: 900, v: ["album:b"] } };
  const one = mergeOrderDocs(older, newer);
  assert.deepEqual(one.sort, { at: 2000, v: "artist" });
  assert.deepEqual(one.pins, { at: 1000, v: ["album:a"] }, "each part by its own moment");
  assert.ok(sameLibraryDoc(one, mergeOrderDocs(newer, older)), "the same from either side");
});

test("the first time two devices meet, both sides' pins and groups stay, the computer's first", () => {
  const computer = { pins: { at: OLD_ON_COMPUTER, v: ["liked", "album:a", "smart:s"] } };
  const phone = { pins: { at: OLD_ON_PHONE, v: ["artist:x", "album:a", "mix:m"] } };
  const met = mergeOrderDocs(phone, computer);
  assert.deepEqual(met.pins, { at: OLD_ON_COMPUTER, v: ["liked", "album:a", "smart:s", "artist:x", "mix:m"] });
  assert.ok(sameLibraryDoc(met, mergeOrderDocs(computer, phone)));
  // Each side merging again with what came back changes nothing: no answering back and forth.
  assert.ok(sameLibraryDoc(mergeOrderDocs(computer, met), met));
  assert.ok(sameLibraryDoc(mergeOrderDocs(phone, met), met));
  // Between devices that have met, a change made since wins outright, removals too.
  const later = { pins: { at: 5000, v: ["album:a"] } };
  assert.deepEqual(mergeOrderDocs({ pins: { at: 4000, v: ["album:a", "album:b"] } }, later).pins, { at: 5000, v: ["album:a"] });
  // A device meeting the others for the first time loses nothing it had: it joins their newer list.
  assert.deepEqual(mergeOrderDocs(computer, later).pins, { at: 5000, v: ["album:a", "liked", "smart:s"] });
  assert.ok(sameLibraryDoc(mergeOrderDocs(computer, later), mergeOrderDocs(later, computer)));

  const groups = mergeGroupsDocs(
    { library: { at: OLD_ON_PHONE, v: [{ id: "p", name: "Phone's", items: ["album:a", "album:b"] }] } },
    { library: { at: OLD_ON_COMPUTER, v: [{ id: "c", name: "Computer's", items: ["album:b", "playlist:1"] }] } }
  );
  assert.deepEqual(groups.library.v, [
    { id: "c", name: "Computer's", items: ["album:b", "playlist:1"] },
    { id: "p", name: "Phone's", items: ["album:a"] },
  ], "an album is in one group at most: the computer's");
});

test("played times only grow, and only the latest are kept", () => {
  assert.deepEqual(mergePlayed({ "album:a": 5, "album:b": 9 }, { "album:a": 7, "mix:m": 3 }), { "album:a": 7, "album:b": 9, "mix:m": 3 });
  const many = Object.fromEntries(Array.from({ length: MAX_PLAYED_SYNCED + 50 }, (_, i) => [`album:${i}`, i + 1]));
  const kept = mergePlayed(many, {});
  assert.equal(Object.keys(kept).length, MAX_PLAYED_SYNCED);
  assert.equal(kept["album:0"], undefined, "the oldest went");
  assert.equal(kept[`album:${MAX_PLAYED_SYNCED + 49}`], MAX_PLAYED_SYNCED + 50);
});

test("album edits merge entry by entry, and what was taken away doesn't come back", () => {
  const computer = {
    titles: { "x|one": { at: 100, v: "One (Remastered)" } },
    mergedInto: { "x|one disc 2": { at: 100, v: "x|one" } },
    songs: { s1: { at: 100, v: { album: "Loose", albumArtist: "X" } } },
  };
  const phone = {
    titles: { "x|two": { at: 150, v: "Two" } },
    mergedInto: { "x|one disc 2": { at: 200 } },
    artists: { "x|one": { at: 120, v: "X, Y" } },
  };
  const met = mergeAlbumEditsDocs(computer, phone);
  assert.deepEqual(Object.keys(met.titles).sort(), ["x|one", "x|two"], "names given on both sides both stay");
  assert.deepEqual(met.mergedInto["x|one disc 2"], { at: 200 }, "split later on the phone: split");
  assert.equal(met.artists["x|one"].v, "X, Y");
  assert.equal(met.songs.s1.v.album, "Loose");
  assert.ok(sameLibraryDoc(met, mergeAlbumEditsDocs(phone, computer)));

  const { edits, stamps } = albumEditsFrom(met);
  assert.equal(edits.mergedInto["x|one disc 2"], undefined);
  assert.equal(stamps.mergedInto["x|one disc 2"], 200, "the split keeps its moment");
  assert.ok(sameLibraryDoc(albumEditsDoc(edits, stamps, OLD_ON_PHONE), met), "a store's copy says the same");
});

test("two devices merging two albums into each other: the older merge goes, the same on both", () => {
  const a = { mergedInto: { "x|a": { at: 300, v: "x|b" } } };
  const b = { mergedInto: { "x|b": { at: 310, v: "x|a" } } };
  const met = mergeAlbumEditsDocs(a, b);
  assert.deepEqual(met.mergedInto["x|a"], { at: 301 }, "the older one is taken back just after it");
  assert.equal(met.mergedInto["x|b"].v, "x|a");
  assert.ok(sameLibraryDoc(met, mergeAlbumEditsDocs(b, a)));
  assert.ok(sameLibraryDoc(mergeAlbumEditsDocs(met, a), met), "and stays so");
});

test("what isn't one of these documents is left out when read", () => {
  assert.deepEqual(readOrderDoc({ sort: { at: 5, v: "loudest" }, pins: { at: "now", v: [] }, played: { "album:a": "yesterday", __proto__: 4 } }), {});
  assert.deepEqual(readOrderDoc(null), {});
  const edits = readAlbumEditsDoc({ titles: { a: { at: 1, v: "" }, b: { at: 2, v: "B" }, c: { at: 3 } }, songs: { s: { at: 1, v: { album: 7 } } } });
  assert.deepEqual(edits, { titles: { b: { at: 2, v: "B" }, c: { at: 3 } } });
  assert.deepEqual(readGroupsDoc({ library: { at: 1, v: "groups" } }), {});
  assert.deepEqual(readGroupsDoc({ library: { at: 1, v: [{ id: "g", name: "G", items: ["album:a"] }, { id: "h", name: "" }] } }).library.v, [{ id: "g", name: "G", items: ["album:a"] }]);
  const pictures = readAlbumPicturesDoc({ covers: { a: { at: 1, v: PICTURE }, b: { at: 1, v: "javascript:alert(1)" }, c: { at: 1, v: `data:image/jpeg;base64,${"A".repeat(500_000)}` } } });
  assert.deepEqual(Object.keys(pictures.covers), ["a"], "only small pictures");
  assert.deepEqual(mergeAlbumPicturesDocs(pictures, { covers: { a: { at: 2 } } }).covers.a, { at: 2 }, "a picture taken away");
});

test("equal documents compare equal whatever order their keys came in", () => {
  assert.equal(canonical({ b: 1, a: [{ y: 2, x: 1 }] }), canonical({ a: [{ x: 1, y: 2 }], b: 1 }));
  assert.ok(!sameLibraryDoc({ pins: { at: 1, v: ["a", "b"] } }, { pins: { at: 1, v: ["b", "a"] } }), "a list's order counts");
});

test("a device's own pins keep their order and places; another device's stay where they stood", () => {
  const full = ["liked", "artist:x", "album:a", "smart:s", "album:b"];
  const computer = (key) => ["liked", "album", "smart", "playlist"].includes(key.split(":")[0]);
  assert.deepEqual(withOwnPins(full, ["album:b", "liked", "album:a"], computer), ["album:b", "artist:x", "liked", "album:a"], "smart:s was unpinned, the artist kept its place");
  assert.deepEqual(withOwnPins(full, ["liked", "album:a", "smart:s", "album:b", "album:new"], computer), [...full, "album:new"]);
  assert.deepEqual(withOwnPins([], ["album:a"], computer), ["album:a"]);
});

test("moments for what changed, and a clock that goes on from the latest seen", () => {
  const times = restamp({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" }, { a: 10 }, 50);
  assert.deepEqual(times, { a: 10, b: 50, c: 50 });
  assert.deepEqual(restamp({ a: "1" }, {}, {}, 60), { a: 60 }, "taken away has a moment too");
  const clock = stampClock();
  clock.saw(Date.now() + 60_000);
  assert.ok(clock.now() > Date.now() + 59_000, "a device whose clock is behind still stamps later than what it saw");
  assert.equal(latestMoment({ titles: { a: { at: 7, v: "x" } }, played: { b: 99 }, sort: { at: 3, v: "alpha" } }), 7, "played times aren't moments of change");
});

/* ------------------------------------------------------------ two devices and the service */

const ANNA = "c".repeat(32);
let jellyfin;
let dataDir;
let service;
let base;
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

before(async () => {
  jellyfin = http.createServer((req, res) => {
    res.writeHead(req.url === "/Users/Me" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/Users/Me" ? { Id: ANNA } : {}));
  });
  const port = await listen(jellyfin);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-library-sync-"));
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

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`waited in vain for ${what}`);
}

/** A device with its library documents as plain objects; the stand-in Jellyfin knows one user, so all tests share them. */
function device(id, { at = base, old = OLD_ON_PHONE, oldService = false, log = [] } = {}) {
  const clock = stampClock();
  const me = {
    log,
    order: {},
    edits: { values: { artists: {}, mergedInto: {}, aliases: {}, songs: {}, titles: {} }, stamps: {} },
    pictures: {},
    lastMerge: {},
    changed: new Set(),
    rename(key, title) {
      const next = { ...me.edits.values.titles };
      if (title) next[key] = title;
      else delete next[key];
      me.edits.stamps = { ...me.edits.stamps, titles: restamp(me.edits.values.titles, next, me.edits.stamps.titles, clock.now()) };
      me.edits.values = { ...me.edits.values, titles: next };
      me.changed.add("albumedits");
      me.engine.libraryChanged("albumedits");
    },
    pin(keys) {
      me.order = { ...me.order, pins: { at: clock.now(), v: keys } };
      me.changed.add("order");
      me.engine.libraryChanged("order");
    },
  };
  const side = (name, read, apply) => ({
    read,
    apply(doc) {
      clock.saw(latestMoment(doc));
      apply(doc);
    },
    lastMerge: () => (me.lastMerge[name] ? { ...me.lastMerge[name], changed: me.changed.has(name) } : null),
    merged(rev) {
      me.lastMerge[name] = { rev, changed: false };
      me.changed.delete(name);
    },
  });
  me.engine = createSyncEngine({
    deviceId: id,
    async request(method, url, body) {
      me.log.push(`${method} ${url.split("?")[0]}`);
      if (oldService && /\/v1\/docs\/(order|groups|albumedits|albumpictures)/.test(url)) return { status: 404, body: { error: "No such document" } };
      const res = await fetch(`${at}${url}`, {
        method,
        headers: { Authorization: `MediaBrowser Token="t"`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const reply = { status: res.status, body: await res.json() };
      if (oldService && url.startsWith("/v1/changes")) for (const name of ["order", "groups", "albumedits", "albumpictures"]) delete reply.body.revs[name];
      return reply;
    },
    readPlaylists: () => toPlaylistDoc({ playlists: [], folders: [] }),
    applyPlaylists() {},
    readPlayback: () => null,
    wantsPlayback: () => false,
    adoptPlayback() {},
    library: {
      order: side("order", () => me.order, (doc) => (me.order = doc)),
      albumedits: side(
        "albumedits",
        () => albumEditsDoc(me.edits.values, me.edits.stamps, old),
        (doc) => {
          const { edits, stamps } = albumEditsFrom(doc);
          me.edits = { values: edits, stamps };
        }
      ),
      albumpictures: side("albumpictures", () => me.pictures, (doc) => (me.pictures = doc)),
    },
  });
  return me;
}

test("pins and album names go from one device to the other and back, and edits made apart both stay", async (t) => {
  const pc = device("pc", { old: OLD_ON_COMPUTER });
  const phone = device("phone");
  t.after(() => {
    pc.engine.stop();
    phone.engine.stop();
  });
  pc.engine.start();
  phone.engine.start();
  pc.pin(["liked", "album:x|one"]);
  pc.rename("x|one", "One (Remastered)");
  await until(() => phone.edits.values.titles["x|one"] === "One (Remastered)" && phone.order.pins?.v?.length === 2, "the computer's name and pins on the phone");

  phone.rename("x|two", "Two");
  await until(() => pc.edits.values.titles["x|two"] === "Two", "the phone's name on the computer");

  // Apart: each renames something of its own, the phone takes the computer's name back.
  pc.engine.stop();
  phone.engine.stop();
  pc.engine.start();
  pc.rename("x|three", "Three");
  phone.rename("x|one", null);
  phone.engine.start();
  await until(() => pc.edits.values.titles["x|one"] === undefined && phone.edits.values.titles["x|three"] === "Three", "both edits on both");
  assert.deepEqual(pc.edits.values.titles, phone.edits.values.titles);

  phone.pictures = { covers: { "x|two": { at: Date.now(), v: PICTURE } } };
  phone.engine.libraryChanged("albumpictures");
  await until(() => pc.pictures.covers?.["x|two"]?.v === PICTURE, "the phone's picture on the computer");
});

test("unchanged on both sides, a device that starts again fetches nothing of these", async (t) => {
  const log = [];
  const pc = device("pc2", { old: OLD_ON_COMPUTER, log });
  t.after(() => pc.engine.stop());
  pc.engine.start();
  pc.rename("y|one", "One");
  await until(() => pc.lastMerge.albumedits && !pc.changed.size, "merged once");
  pc.engine.stop();
  log.length = 0;
  pc.engine.start();
  await until(() => log.some((l) => l.startsWith("GET /v1/changes")), "the first round");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!log.includes("GET /v1/docs/albumedits"), `fetched again: ${log.join(", ")}`);
});

test("a service from before these documents: everything stays on the device, the rest syncs on", async (t) => {
  const log = [];
  const pc = device("pc3", { oldService: true, log });
  t.after(() => pc.engine.stop());
  pc.engine.start();
  pc.rename("z|one", "One");
  pc.pin(["album:z|one"]);
  await until(() => log.some((l) => l.startsWith("GET /v1/changes")), "the first round");
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(pc.engine.status(), "connected");
  assert.equal(pc.edits.values.titles["z|one"], "One", "kept here");
  assert.ok(log.filter((l) => /docs\/(order|albumedits)/.test(l)).length <= 2, "asked at most once each, after the change here");
});

test("an older app's look at the changes isn't disturbed by the new documents", async () => {
  const res = await fetch(`${base}/v1/changes?since=-1&wait=0`, { headers: { Authorization: `MediaBrowser Token="t"` } });
  const body = await res.json();
  for (const name of ["playlists", "queue", "position", "likes", "muted", "devices"]) assert.equal(typeof body.revs[name], "number", name);
  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(health.docs.slice(-4), ["order", "groups", "albumedits", "albumpictures"]);
});
