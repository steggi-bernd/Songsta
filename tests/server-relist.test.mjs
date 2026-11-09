// The servers' songs are listed again at each start (src/lib/serverRelist.ts, stores/catalog.ts):
// what was added on the server and the covers it found since come in by themselves. While the
// server can't be reached yet the tries repeat a few times; a listing that came back the same
// changes nothing on screen; a reload during the start's listing shares it; and a listing that
// ends after signing out leaves nothing behind (electron/jellyfin.ts, electron/subsonic.ts).
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dataUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const settle = () => new Promise((done) => setImmediate(done));

/* ------------------------------------------------------------ tries at start */

const pure = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/serverRelist.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
const { relistOnce } = await import(dataUrl(pure.outputFiles[0].text));

/** Timers that run only when told to. */
function handTimers() {
  const due = [];
  return {
    set: (run, ms) => {
      const handle = { run, ms };
      due.push(handle);
      return handle;
    },
    clear: (handle) => {
      const at = due.indexOf(handle);
      if (at >= 0) due.splice(at, 1);
    },
    due,
    async next() {
      const handle = due.shift();
      handle.run();
      await settle();
      return handle.ms;
    },
  };
}

test("a listing that came back different is announced, the same one isn't", async () => {
  let told = 0;
  relistOnce(async () => true, () => (told += 1), [30]);
  await settle();
  assert.equal(told, 1);
  const timers = handTimers();
  relistOnce(async () => false, () => (told += 1), [30], timers);
  await settle();
  assert.equal(told, 1);
  assert.equal(timers.due.length, 0, "nothing more to try");
});

test("while the server can't be reached it tries again after each wait, then stops", async () => {
  const timers = handTimers();
  let tries = 0;
  relistOnce(
    async () => {
      tries += 1;
      throw new Error("Can't reach the Jellyfin server — check the address");
    },
    () => assert.fail("nothing to announce"),
    [30, 120, 600],
    timers
  );
  await settle();
  assert.equal(tries, 1);
  assert.equal(await timers.next(), 30);
  assert.equal(await timers.next(), 120);
  assert.equal(await timers.next(), 600);
  assert.equal(tries, 4);
  assert.equal(timers.due.length, 0, "then it waits for the next start");
});

test("the first try that gets through ends the tries", async () => {
  const timers = handTimers();
  const answers = [false, false, true];
  let told = 0;
  relistOnce(
    async () => {
      if (!answers.shift()) throw new Error("no answer");
      return true;
    },
    () => (told += 1),
    [30, 120, 600],
    timers
  );
  await settle();
  await timers.next();
  await timers.next();
  assert.equal(told, 1);
  assert.equal(timers.due.length, 0);
});

test("a stop drops the tries to come and a listing under way stays quiet", async () => {
  const timers = handTimers();
  const stopRetrying = relistOnce(async () => Promise.reject(new Error("no answer")), () => assert.fail("stopped"), [30], timers);
  await settle();
  assert.equal(timers.due.length, 1);
  stopRetrying();
  assert.equal(timers.due.length, 0);

  let finish;
  const stopListening = relistOnce(() => new Promise((done) => (finish = done)), () => assert.fail("stopped"), [30], timers);
  await settle();
  stopListening();
  finish(true);
  await settle();
});

/* ------------------------------------------------------------ the main process */

const store = new Map();
globalThis.__store = store;
const servers = await build({
  stdin: { contents: `export * as jf from "./jellyfin"; export * as ss from "./subsonic";`, resolveDir: fileURLToPath(new URL("../electron/", import.meta.url)), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
        b.onResolve({ filter: /^\.\/(persist|secrets)$/ }, (a) => ({ path: a.path.slice(2), namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
          loader: "js",
          contents: {
            electron: `export const app = { getPath: () => ${JSON.stringify(os.tmpdir())} };`,
            persist: "export const readData = (n) => globalThis.__store.get(n) ?? null; export const writeData = async (n, v) => { globalThis.__store.set(n, v); };",
            secrets: "export const sealSecret = (s) => 'sealed:' + s; export const openSecret = (s) => (typeof s === 'string' && s.startsWith('sealed:') ? s.slice(7) : '');",
          }[a.path],
        }));
      },
    },
  ],
});
const { jf, ss } = await import(dataUrl(servers.outputFiles[0].text));

/** A stand-in for both servers: one album, with or without its cover, answering at once or when let go. */
const stage = { cover: false, hold: false, held: [], listings: 0 };
const JF_SONG = "0123456789abcdef0123456789abcdef";
const JF_ALBUM = "fedcba9876543210fedcba9876543210";
let base = "";
const standIn = http.createServer((req, res) => {
  const url = new URL(req.url, "http://stand-in");
  const answer = (body) => {
    const send = () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (stage.hold) stage.held.push(send);
    else send();
  };
  if (url.pathname === "/Items") {
    if (url.searchParams.get("StartIndex") === "0") stage.listings += 1;
    const song = { Id: JF_SONG, Name: "Departure Bell", Album: "Night Ferry", AlbumId: JF_ALBUM, Artists: ["Lumen Harbor"], AlbumArtist: "Lumen Harbor", RunTimeTicks: 2_000_000_000 };
    return answer({ Items: [stage.cover ? { ...song, AlbumPrimaryImageTag: "front1" } : song], TotalRecordCount: 1 });
  }
  if (url.pathname === "/rest/search3.view") {
    if (url.searchParams.get("songOffset") === "0") stage.listings += 1;
    const song = { id: "s1", title: "Departure Bell", artist: "Lumen Harbor", album: "Night Ferry", albumId: "a1", duration: 200, ...(stage.cover ? { coverArt: "al-a1" } : {}) };
    return answer({ "subsonic-response": { status: "ok", version: "1.16.1", searchResult3: { song: [song] } } });
  }
  if (url.pathname === "/rest/getAlbumList2.view") return answer({ "subsonic-response": { status: "ok", version: "1.16.1", albumList2: { album: [] } } });
  res.statusCode = 404;
  res.end();
});

before(async () => {
  await new Promise((done) => standIn.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${standIn.address().port}`;
});
after(() => standIn.close());

beforeEach(() => {
  store.clear();
  Object.assign(stage, { cover: false, hold: false, held: [], listings: 0 });
  store.set("jellyfin", { server: base, home: base, serverName: "Stand-in", userId: null, userName: null, token: "sealed:api-key", deviceId: "desk" });
  store.set("subsonic", { server: base, serverName: "Stand-in", userName: "listener", auth: "sealed:salt:token" });
});

const letGo = () => {
  stage.hold = false;
  for (const send of stage.held.splice(0)) send();
};
const heard = async () => {
  for (let i = 0; i < 200 && !stage.held.length; i++) await new Promise((done) => setTimeout(done, 5));
  assert.ok(stage.held.length, "the server got the request");
};

for (const [name, server, libraryStore] of [
  ["Jellyfin", jf, "jellyfin-library"],
  ["Navidrome", ss, "subsonic-library"],
]) {
  test(`${name}: a listing says whether the songs or their covers changed`, async () => {
    assert.equal((await server.refreshLibrary()).changed, true, "the first listing fills an empty cache");
    assert.equal((await server.refreshLibrary()).changed, false, "the same songs again");
    stage.cover = true;
    const listed = await server.refreshLibrary();
    assert.equal(listed.changed, true, "the server found a cover");
    assert.match(listed.tracks[0].art, /^(jfart|ssart):\/\//);
    assert.equal(store.get(libraryStore).tracks[0].art, listed.tracks[0].art);
  });

  test(`${name}: a reload during the start's listing shares it`, async () => {
    stage.hold = true;
    const atStart = server.refreshLibrary();
    const reload = server.refreshLibrary();
    assert.equal(reload, atStart);
    await heard();
    letGo();
    await Promise.all([atStart, reload]);
    assert.equal(stage.listings, 1);
    const later = server.refreshLibrary();
    assert.notEqual(later, atStart, "a later reload lists again");
    await later;
    assert.equal(stage.listings, 2);
  });

  test(`${name}: a listing that ends after signing out leaves nothing behind`, async () => {
    stage.hold = true;
    const listing = server.refreshLibrary();
    await heard();
    await server.disconnect();
    letGo();
    await assert.rejects(listing, /Not connected/);
    assert.deepEqual(store.get(libraryStore), { fetchedAt: 0, tracks: [] });
  });
}
