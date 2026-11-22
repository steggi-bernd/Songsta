// The listening history every device shares through the sync service (src/lib/listenSync.ts,
// sync-server: /v1/listens, the engine's ListenHost): a device's plays go in once however often they're
// sent, every device reads everybody's in order, and Replay then counts every play everywhere.
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
const { wireListen, readListenPage, listenKey, LISTEN_BATCH } = await load("../src/lib/listenSync.ts");
const { createSyncEngine } = await load("../src/lib/syncEngine.ts");
const { toPlaylistDoc } = await load("../src/lib/playlistSync.ts");

const NOW = Date.UTC(2026, 10, 15, 12);
const play = (id, minutesAgo, over = {}) => ({ at: NOW - minutesAgo * 60_000, id, title: `Song ${id}`, artist: "Lumen Harbor", album: "Lanterns", ms: 200_000, ...over });

/* ------------------------------------------------------------ the format */

test("a listen travels safely: odd ones out, only a web picture along", () => {
  assert.deepEqual(wireListen(play("jf:1", 5), NOW), { at: NOW - 300_000, id: "jf:1", title: "Song jf:1", artist: "Lumen Harbor", album: "Lanterns", ms: 200_000 });
  assert.equal(wireListen({ ...play("jf:1", 5), thumb: "localart://x" }, NOW).thumb, undefined);
  assert.equal(wireListen({ ...play("jf:1", 5), thumb: "http://pi:8096/Items/1/Images/Primary" }, NOW).thumb, "http://pi:8096/Items/1/Images/Primary");
  assert.equal(wireListen({ ...play("jf:1", 5), title: "" }, NOW), null, "a song without a title");
  assert.equal(wireListen({ ...play("jf:1", 5), at: Date.UTC(1990, 0, 1) }, NOW), null, "from before there were any");
  assert.equal(wireListen({ ...play("jf:1", 5), at: NOW + 3 * 86_400_000 }, NOW), null, "from days ahead");
  assert.equal(wireListen({ ...play("jf:1", 5), ms: 99 * 3600_000 }, NOW).ms, 6 * 3600_000, "no play longer than six hours");
  assert.equal(listenKey("pc", play("jf:1", 5)), listenKey("pc", { ...play("jf:1", 5), title: "Other spelling" }), "who, when and which song: the same listen");
});

test("a page from the service is read safely", () => {
  const page = readListenPage(
    {
      count: 3,
      listens: [{ n: 1, device: "pc", ...play("jf:1", 9) }, { n: 2, device: "", ...play("jf:2", 8) }, { n: 3, device: "phone", ...play("jf:3", 7), title: "" }],
      devices: { pc: { name: "Living room", kind: "computer" }, __proto__: { name: "x" } },
      more: false,
    },
    NOW
  );
  assert.deepEqual(page.listens.map((l) => l.id), ["jf:1"]);
  assert.deepEqual(page.devices, { pc: { name: "Living room", kind: "computer" } });
  assert.equal(readListenPage({ listens: [] }), null, "no count, no page");
});

/* ------------------------------------------------------------ the service */

const ANNA = "d".repeat(32);
let jellyfin;
let dataDir;
let service;
let base;
const listenOn = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
before(async () => {
  jellyfin = http.createServer((req, res) => {
    res.writeHead(req.url === "/Users/Me" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/Users/Me" ? { Id: ANNA } : {}));
  });
  const port = await listenOn(jellyfin);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-listen-sync-"));
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

const ask = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: { Authorization: `MediaBrowser Token="t"`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test("the service keeps every device's plays in order, each once, and hands them out from any point", async () => {
  const first = await ask("POST", "/v1/listens", { device: { id: "svc-pc", name: "Living room", kind: "computer" }, listens: [play("jf:a", 30), play("jf:b", 20), { title: "broken" }] });
  assert.equal(first.status, 200);
  assert.equal(first.body.added, 2, "the broken one is left out");
  const again = await ask("POST", "/v1/listens", { device: { id: "svc-pc", name: "Living room", kind: "computer" }, listens: [play("jf:b", 20), play("jf:c", 10)] });
  assert.equal(again.body.added, 1, "sent twice after a lost answer, kept once");
  await ask("POST", "/v1/listens", { device: { id: "svc-phone", name: "Pixel", kind: "phone" }, listens: [play("jf:a", 5)] });

  const all = await ask("GET", "/v1/listens?since=0");
  assert.equal(all.body.count, 4);
  assert.deepEqual(all.body.listens.map((l) => [l.n, l.device, l.id]), [[1, "svc-pc", "jf:a"], [2, "svc-pc", "jf:b"], [3, "svc-pc", "jf:c"], [4, "svc-phone", "jf:a"]]);
  assert.deepEqual(all.body.devices, { "svc-pc": { name: "Living room", kind: "computer" }, "svc-phone": { name: "Pixel", kind: "phone" } });
  assert.equal(all.body.more, false);
  const rest = await ask("GET", "/v1/listens?since=2&limit=1");
  assert.deepEqual(rest.body.listens.map((l) => l.n), [3]);
  assert.equal(rest.body.more, true);

  const changes = await ask("GET", "/v1/changes?since=-1&wait=0");
  assert.equal(changes.body.revs.listens, 4, "the long poll says how many there are");
  assert.equal((await ask("POST", "/v1/listens", { listens: [] })).status, 400, "plays come from a device");
  assert.equal((await ask("POST", "/v1/listens", { device: { id: "x" }, listens: Array.from({ length: 1001 }, (_, i) => play(`jf:${i}`, 1)) })).status, 400, "a thousand at most");

  // A restart keeps them: they're on disk, one line each.
  const again2 = createSyncServer({ dataDir, jellyfinUrl: "http://127.0.0.1:9" });
  const lines = fs.readFileSync(path.join(dataDir, "users", ANNA, "listens.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 4);
  again2.close();
});

test("one device's plays can be taken out; the rest keep their order and get their places again", async () => {
  const dev = (id) => ({ id, name: id, kind: "phone" });
  await ask("POST", "/v1/listens", { device: dev("rm-a"), listens: [play("jf:ra1", 40), play("jf:ra2", 39)] });
  await ask("POST", "/v1/listens", { device: dev("rm-b"), listens: [play("jf:rb1", 38)] });
  const before = (await ask("GET", "/v1/listens?since=0&limit=2000")).body;
  const gone = await ask("DELETE", "/v1/listens?device=rm-a");
  assert.equal(gone.status, 200);
  assert.equal(gone.body.removed, 2);
  assert.equal(gone.body.count, before.count - 2);
  const after = (await ask("GET", "/v1/listens?since=0&limit=2000")).body;
  assert.ok(!after.listens.some((l) => l.device === "rm-a"), "none of its plays left");
  assert.deepEqual(after.listens.map((l) => l.n), after.listens.map((_, i) => i + 1), "places from 1, without gaps");
  assert.ok(after.listens.some((l) => l.device === "rm-b"), "the other device's stay");
  assert.equal(after.devices["rm-a"], undefined);
  // Sent again, they'd come back: it's the device that keeps them to itself (lib/listenShare.ts, stores/listens.ts).
  assert.equal((await ask("DELETE", "/v1/listens?device=rm-a")).body.removed, 0, "twice is nothing more");
  assert.equal((await ask("DELETE", "/v1/listens?device=../x")).status, 400);
  // A restart reads what's left.
  const again = createSyncServer({ dataDir, jellyfinUrl: "http://127.0.0.1:9" });
  const lines = fs.readFileSync(path.join(dataDir, "users", ANNA, "listens.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(!lines.some((l) => l.device === "rm-a"));
  again.close();
});

/* ------------------------------------------------------------ two devices */

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`waited in vain for ${what}`);
}

/** A stand-in long poll: at once when asked so, else after a moment, as a real service waits for news. */
const longPoll = async (url, body) => {
  if (!url.includes("wait=0")) await new Promise((resolve) => setTimeout(resolve, 150));
  return { status: 200, body };
};

/** A device with its plays in memory: what it played, how far it sent and read, what came from the others. */
function device(id, kind, own, { request } = {}) {
  const me = { own: [...own], sent: 0, upTo: 0, got: [], missing: false, startedOver: 0 };
  me.engine = createSyncEngine({
    deviceId: id,
    request:
      request ??
      (async (method, url, body) => {
        const reply = await ask(method, url, body);
        return reply;
      }),
    readPlaylists: () => toPlaylistDoc({ playlists: [], folders: [] }),
    applyPlaylists() {},
    readPlayback: () => null,
    wantsPlayback: () => false,
    adoptPlayback() {},
    listens: {
      device: () => ({ name: id.toUpperCase(), kind }),
      // By place, as the apps keep it: how many of its own the service has.
      pending: async (max) => me.own.slice(me.sent, me.sent + max),
      sent: (last) => {
        me.sent = me.own.indexOf(last) + 1;
      },
      readUpTo: () => me.upTo,
      take(listens, devices, upTo, startOver) {
        if (startOver) {
          me.startedOver += 1;
          me.upTo = 0;
          me.sent = 0;
          return;
        }
        for (const l of listens) if (!me.got.some((g) => listenKey(g.device, g) === listenKey(l.device, l))) me.got.push(l);
        me.devices = devices;
        me.upTo = upTo;
      },
      missing: () => {
        me.missing = true;
      },
    },
  });
  return me;
}

test("the computer's plays reach the phone and the phone's the computer; more than one page goes too", async (t) => {
  const many = Array.from({ length: LISTEN_BATCH + 20 }, (_, i) => play(`jf:pc${i}`, 10_000 - i));
  const pc = device("two-pc", "computer", many);
  const phone = device("two-phone", "phone", [play("jf:x", 3), play("jf:y", 2)]);
  t.after(() => {
    pc.engine.stop();
    phone.engine.stop();
  });
  pc.engine.start();
  phone.engine.start();
  await until(() => phone.got.filter((l) => l.device === "two-pc").length === many.length, "every computer play on the phone");
  await until(() => pc.got.filter((l) => l.device === "two-phone").length === 2, "the phone's plays on the computer");
  assert.equal(phone.devices["two-pc"].name, "TWO-PC");
  assert.ok(!phone.got.some((l) => l.device === "two-phone"), "a device doesn't take its own plays back");

  // A play counted later goes out on its own.
  pc.own.push(play("jf:late", 1));
  pc.engine.listensChanged();
  await until(() => phone.got.some((l) => l.id === "jf:late"), "the later play on the phone", 20_000);
});

test("a service that started over is read from the start, and gets this device's plays again", async (t) => {
  const posted = [];
  let reads = 0;
  const pc = device("over-pc", "computer", [play("jf:1", 5)], {
    async request(method, url, body) {
      if (url.startsWith("/v1/changes")) return longPoll(url, { seq: 1, revs: { listens: 0 } });
      if (method === "POST") {
        posted.push(...body.listens);
        return { status: 200, body: { added: body.listens.length, count: 1 } };
      }
      if (url.startsWith("/v1/listens")) {
        reads += 1;
        return { status: 200, body: { count: 0, listens: [], devices: {}, more: false } };
      }
      return { status: 200, body: { rev: 0, doc: null } };
    },
  });
  pc.upTo = 40;
  t.after(() => pc.engine.stop());
  pc.engine.start();
  await until(() => pc.startedOver === 1 && reads >= 2, "a read from the start");
  assert.equal(pc.upTo, 0);
  await until(() => posted.length >= 1, "its plays sent");
});

test("a shared history that goes wrong never holds up the rest of the sync", async (t) => {
  // As the desktop's line once did with a path it didn't know: every listens request throws.
  const statuses = [];
  let playlistReads = 0;
  let listenTries = 0;
  const engine = createSyncEngine({
    deviceId: "broken-pc",
    request: async (method, url) => {
      if (url.startsWith("/v1/changes")) return longPoll(url, { seq: 1, revs: { playlists: 0, listens: 3 } });
      if (url.startsWith("/v1/listens")) {
        listenTries += 1;
        throw new Error("Not a request for the sync service");
      }
      if (url === "/v1/docs/playlists") playlistReads += 1;
      return { status: 200, body: { rev: 0, doc: null } };
    },
    readPlaylists: () => toPlaylistDoc({ playlists: [], folders: [] }),
    applyPlaylists() {},
    readPlayback: () => null,
    wantsPlayback: () => false,
    adoptPlayback() {},
    // The status as the app shows it.
    onStatus: (s) => statuses.push(s),
    listens: { device: () => ({ name: "PC", kind: "computer" }), pending: async () => [play("jf:1", 5)], sent() {}, readUpTo: () => 0, take() {} },
  });
  t.after(() => engine.stop());
  engine.start();
  await until(() => listenTries >= 1 && playlistReads >= 1, "a round with the playlists and a try at the history");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual([...new Set(statuses)], ["connecting", "connected"], "still connected: the playlists, devices and the rest go on");
  assert.equal(playlistReads, 1, "one round, not one start after another");
});

test("a service from before the shared history: each device counts its own, and it's said once", async (t) => {
  let posts = 0;
  const pc = device("old-pc", "computer", [play("jf:1", 5)], {
    async request(method, url) {
      if (url.startsWith("/v1/changes")) return longPoll(url, { seq: 1, revs: { playlists: 0 } });
      if (url.startsWith("/v1/listens")) posts += 1;
      return { status: 200, body: { rev: 0, doc: null } };
    },
  });
  t.after(() => pc.engine.stop());
  pc.engine.start();
  await until(() => pc.missing, "told the service keeps no shared history");
  pc.engine.listensChanged();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(posts, 0, "nothing sent to a service that can't keep it");
});

/* ------------------------------------------------------------ the history's generation (part 2 of the protocol rework) */

/** A service of its own on a folder of its own; a restart is another one on the same folder. */
async function ownService(dir) {
  const server = createSyncServer({ dataDir: dir, jellyfinUrl: `http://127.0.0.1:${jellyfin.address().port}` });
  const at = `http://127.0.0.1:${await listenOn(server)}`;
  return {
    ask: async (method, url, body) => {
      const res = await fetch(`${at}${url}`, { method, headers: { Authorization: `MediaBrowser Token="t"`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("the history has a generation: the same through new plays and a restart, a new one when plays are taken out or the history isn't what the service wrote", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-listen-gen-"));
  const pc = { id: "gen-pc", name: "PC", kind: "computer" };
  try {
    const first = await ownService(dir);
    await first.ask("POST", "/v1/listens", { device: pc, listens: [play("jf:1", 9), play("jf:2", 8)] });
    const g1 = (await first.ask("GET", "/v1/listens?since=0&limit=10")).body.generation;
    assert.equal(typeof g1, "string");
    await first.ask("POST", "/v1/listens", { device: pc, listens: [play("jf:3", 7)] });
    assert.equal((await first.ask("GET", "/v1/listens?since=0&limit=10")).body.generation, g1, "plays added: the same history");
    assert.equal((await first.ask("GET", "/v1/changes?since=-1&wait=0")).body.listensGeneration, g1, "the summary says it too");
    first.close();
    const again = await ownService(dir);
    assert.equal((await again.ask("GET", "/v1/listens?since=0&limit=10")).body.generation, g1, "started again: the same history");
    again.close();
    // Put back from an older backup: not what the service last wrote.
    const file = path.join(dir, "users", ANNA, "listens.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, `${lines.slice(0, 2).join("\n")}\n`);
    const restored = await ownService(dir);
    try {
      const g2 = (await restored.ask("GET", "/v1/listens?since=0&limit=10")).body.generation;
      assert.notEqual(g2, g1, "a backup put back: another generation");
      await restored.ask("POST", "/v1/listens", { device: { id: "gen-phone", name: "Phone", kind: "phone" }, listens: [play("jf:9", 3)] });
      const removed = await restored.ask("DELETE", "/v1/listens?device=gen-pc");
      assert.equal(removed.body.removed, 2);
      assert.notEqual(removed.body.generation, g2, "plays taken out: another generation");
      assert.equal((await restored.ask("GET", "/v1/listens?since=0&limit=10")).body.generation, removed.body.generation);
    } finally {
      restored.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a play taken out and others in while a device was away: it reads the history again and has the new ones, though the length stayed the same", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-listen-away-"));
  const there = await ownService(dir);
  const me = { own: [play("jf:mine", 50)], sent: 0, upTo: 0, got: [], read: null, afresh: null, afreshTimes: 0 };
  const listens = {
    device: () => ({ name: "AWAY", kind: "phone" }),
    pending: async (max) => me.own.slice(me.sent, me.sent + max),
    sent: (last) => {
      me.sent = me.own.indexOf(last) + 1;
    },
    readUpTo: () => me.upTo,
    take(got, devices, upTo, startOver) {
      if (startOver) {
        me.upTo = 0;
        me.sent = 0;
        return;
      }
      for (const l of got) if (!me.got.some((g) => listenKey(g.device, g) === listenKey(l.device, l))) me.got.push(l);
      me.upTo = upTo;
    },
    generation: () => ({ read: me.read, afresh: me.afresh }),
    readAfresh(generation) {
      me.afresh = generation;
      me.upTo = 0;
      me.sent = 0;
      me.afreshTimes += 1;
    },
    readThrough(generation) {
      if (me.afresh === generation) me.afresh = null;
      me.read = generation;
    },
  };
  const engineOf = () =>
    createSyncEngine({
      deviceId: "away-phone",
      request: there.ask,
      readPlaylists: () => toPlaylistDoc({ playlists: [], folders: [] }),
      applyPlaylists() {},
      readPlayback: () => null,
      wantsPlayback: () => false,
      adoptPlayback() {},
      listens,
    });
  let engine = null;
  t.after(() => {
    engine?.stop();
    there.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await there.ask("POST", "/v1/listens", { device: { id: "gone-pc", name: "Old PC", kind: "computer" }, listens: [play("jf:old1", 30), play("jf:old2", 29)] });
  engine = engineOf();
  engine.start();
  await until(() => me.got.length === 2 && me.read !== null && me.sent === 1, "the history read to its end, its own play there");
  engine.stop();
  // While it's away: the old computer's plays taken out, a new computer's two in. Three plays, as before.
  await there.ask("DELETE", "/v1/listens?device=gone-pc");
  await there.ask("POST", "/v1/listens", { device: { id: "new-pc", name: "New PC", kind: "computer" }, listens: [play("jf:new1", 5), play("jf:new2", 4)] });
  assert.equal((await there.ask("GET", "/v1/listens?since=0&limit=1")).body.count, 3, "the same length");
  engine = engineOf();
  engine.start();
  await until(() => me.got.some((l) => l.id === "jf:new1") && me.got.some((l) => l.id === "jf:new2"), "the new plays", 12000);
  await until(() => me.read !== null && me.afresh === null && me.sent === 1, "read to its end, its own play sent again", 12000);
  assert.equal(me.afreshTimes, 2, "read afresh once more");
  assert.ok(me.got.some((l) => l.id === "jf:old1"), "what it had stays, as the privacy settings promise");
});
