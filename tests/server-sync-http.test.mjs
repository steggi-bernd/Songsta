// The server half of Server sync — electron/jellyfin.ts and electron/subsonic.ts — against
// fake Jellyfin and Navidrome servers on localhost: users, favorites both ways, plays.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const store = new Map();
const stubs = {
  name: "server-stubs",
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
};
globalThis.__store = store;

async function load(file) {
  const out = await build({
    entryPoints: [fileURLToPath(new URL(`../electron/${file}.ts`, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [stubs],
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

/* ------------------------------------------------------------ fake servers */
const calls = [];
let jellyfinModern = false; // false: the 10.9 routes 404 like on an older server
const favorites = new Set(["11111111111111111111111111111111"]);
const audio = (id, name) => ({ Id: id, Name: name, Artists: ["Band"], Album: "Album", RunTimeTicks: 1_800_000_000 });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? "" });
  const json = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  // Jellyfin
  if (url.pathname === "/Users") return json(200, [{ Id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Name: "steggi" }, { Id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Name: "guest" }]);
  if (url.pathname === "/Items" && url.searchParams.get("Filters") === "IsFavorite") {
    return json(200, { Items: [...favorites].map((id) => audio(id, `Fav ${id.slice(0, 4)}`)), TotalRecordCount: favorites.size });
  }
  let m = /^\/UserFavoriteItems\/(\w+)$/.exec(url.pathname);
  if (m) return jellyfinModern ? json(200, {}) : json(404);
  m = /^\/Users\/(\w+)\/FavoriteItems\/(\w+)$/.exec(url.pathname);
  if (m) {
    if (req.method === "POST") favorites.add(m[2]);
    else favorites.delete(m[2]);
    return json(200, { IsFavorite: req.method === "POST" });
  }
  if (/^\/(UserPlayedItems|Users\/\w+\/PlayedItems)\/\w+$/.test(url.pathname)) {
    return jellyfinModern || url.pathname.startsWith("/Users") ? json(200, { Played: true }) : json(404);
  }
  // Navidrome
  const sub = /^\/rest\/(\w+)\.view$/.exec(url.pathname);
  if (sub) {
    const ok = (extra = {}) => json(200, { "subsonic-response": { status: "ok", version: "1.16.1", ...extra } });
    if (sub[1] === "getStarred2") return ok({ starred2: { song: [{ id: "s1", title: "Starred", artist: "Band", album: "Album", duration: 200 }] } });
    if (["star", "unstar", "scrobble"].includes(sub[1])) return ok();
  }
  json(404);
});
let base;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test("an API-key login picks the user whose favorites and plays these are", async () => {
  const jellyfin = await load("jellyfin");
  store.set("jellyfin", { server: base, serverName: "Home", userId: null, userName: null, token: "sealed:apikey", deviceId: "dev-1" });
  assert.deepEqual(jellyfin.status().syncUserId, null);
  await assert.rejects(jellyfin.favoriteTracks(), /No Jellyfin user/);
  assert.deepEqual((await jellyfin.listUsers()).map((u) => u.name), ["steggi", "guest"]);
  const s = await jellyfin.setSyncUser("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(s.apiKey, true);
  assert.equal(s.syncUserName, "steggi");
  await assert.rejects(jellyfin.setSyncUser("cccccccccccccccccccccccccccccccc"), /isn't on this server/);
  assert.equal(jellyfin.status().syncUserId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "a refused pick changes nothing");
});

test("Jellyfin favorites both ways, and a play, on servers before and after 10.9", async () => {
  const jellyfin = await load("jellyfin");
  store.set("jellyfin", {
    server: base, serverName: "Home", userId: null, userName: null, token: "sealed:apikey", deviceId: "dev-1",
    syncUserId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", syncUserName: "steggi",
  });
  const listed = await jellyfin.favoriteTracks();
  assert.deepEqual(listed.map((t) => t.id), ["jf:11111111111111111111111111111111"]);
  assert.equal(calls.at(-1).query.UserId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.match(calls.at(-1).auth, /Token="apikey"/, "the key travels in the header");

  calls.length = 0;
  jellyfinModern = false;
  await jellyfin.setFavorite("22222222222222222222222222222222", true);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "POST /UserFavoriteItems/22222222222222222222222222222222",
    "POST /Users/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/FavoriteItems/22222222222222222222222222222222",
  ], "the old route once the new one isn't there");
  assert.ok(favorites.has("22222222222222222222222222222222"));
  await jellyfin.setFavorite("11111111111111111111111111111111", false);
  assert.ok(!favorites.has("11111111111111111111111111111111"));

  calls.length = 0;
  jellyfinModern = true;
  const at = new Date("2026-10-31T12:00:00Z");
  await jellyfin.markPlayed("22222222222222222222222222222222", at);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/UserPlayedItems/22222222222222222222222222222222");
  assert.deepEqual(calls[0].query, { datePlayed: at.toISOString(), userId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  await assert.rejects(jellyfin.setFavorite("../../System/Restart", true), /Not a Jellyfin item/);
});

test("Navidrome: starred songs, star/unstar and scrobbles", async () => {
  const subsonic = await load("subsonic");
  store.set("subsonic", { server: base, serverName: "Navidrome", userName: "steggi", auth: "sealed:salt1:tok1" });
  assert.deepEqual((await subsonic.favoriteTracks()).map((t) => t.id), ["ss:s1"]);
  calls.length = 0;
  await subsonic.setStarred("s1", false);
  await subsonic.scrobble("s1", false);
  await subsonic.scrobble("s1", true, new Date(1_800_000_000_000));
  assert.deepEqual(calls.map((c) => c.path), ["/rest/unstar.view", "/rest/scrobble.view", "/rest/scrobble.view"]);
  assert.equal(calls[1].query.submission, "false");
  assert.deepEqual([calls[2].query.submission, calls[2].query.time], ["true", "1800000000000"]);
  assert.deepEqual([calls[2].query.u, calls[2].query.s, calls[2].query.t], ["steggi", "salt1", "tok1"]);
  await assert.rejects(subsonic.setStarred("bad id with spaces", true), /Not a song/);
});

test("a device gets a song straight from a server on its own network that needs no login; anything else goes through this computer", async (t) => {
  const jellyfin = await load("jellyfin");
  const id = "33333333333333333333333333333333";
  const login = { serverName: "Home", userId: null, userName: null, token: "sealed:secret-token", deviceId: "dev-1" };
  const asked = [];
  let answer = 401;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    asked.push({ url: String(url), method: init?.method });
    return new Response(null, { status: answer });
  });
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });

  // Not a word to a server that's out of the device's reach.
  for (const server of ["http://172.17.0.2:8096", "http://192.168.2.5:8096", "http://127.0.0.1:8096", "https://music.example.org"]) {
    store.set("jellyfin", { ...login, server });
    assert.equal(await jellyfin.deviceStreamUrl(id, "192.168.1.50"), null, server);
  }
  assert.deepEqual(asked, []);

  store.set("jellyfin", { ...login, server: "http://192.168.1.5:8096" });
  assert.equal(await jellyfin.deviceStreamUrl("not an id", "192.168.1.50"), null);
  assert.deepEqual(asked, []);

  // It wants a login: through this computer, and it isn't asked again for a while.
  assert.equal(await jellyfin.deviceStreamUrl(id, "192.168.1.50"), null);
  assert.equal(await jellyfin.deviceStreamUrl(id, "192.168.1.50"), null);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].method, "HEAD");

  // Later it gives songs out: the device gets the address, with nothing secret in it.
  answer = 200;
  Date.now = () => realNow() + 6 * 60_000;
  const url = await jellyfin.deviceStreamUrl(id, "192.168.1.50");
  assert.match(url, /^http:\/\/192\.168\.1\.5:8096\/Audio\/3{32}\/stream\?/);
  assert.ok(!/secret-token|api_key|token/i.test(url), url);
  assert.equal(asked.length, 2);
  await jellyfin.deviceStreamUrl(id, "192.168.1.50");
  assert.equal(asked.length, 2, "once it says yes, that stands");

  // A server and a device on this computer, as in a test run.
  store.set("jellyfin", { ...login, server: "http://127.0.0.1:8096" });
  assert.match(await jellyfin.deviceStreamUrl(id, "127.0.0.1"), /^http:\/\/127\.0\.0\.1:8096\/Audio\//);
});
