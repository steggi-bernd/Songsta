// The computer's two ways to one Jellyfin server (electron/jellyfin.ts checkReach, setAway): the
// direct one at home, and one from anywhere. Against stand-in servers on localhost that answer, fall
// silent, or turn out to be somebody else's server at the same address.
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const store = new Map();
globalThis.__store = store;
const out = await build({
  entryPoints: [fileURLToPath(new URL("../electron/jellyfin.ts", import.meta.url))],
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
const jf = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

/** A stand-in server: answers with its id, or stays silent. */
function standIn(id) {
  const s = { id, silent: false, server: null, url: "" };
  s.server = http.createServer((req, res) => {
    if (s.silent) return; // never answers: the way a home address does from elsewhere
    if (req.url === "/System/Info/Public") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ Id: s.id, ServerName: "Home" }));
    }
    res.writeHead(404).end();
  });
  return s;
}
const home = standIn("server-one");
const away = standIn("server-one");
const other = standIn("server-two");
before(async () => {
  for (const s of [home, away, other]) {
    await new Promise((done) => s.server.listen(0, "127.0.0.1", done));
    s.url = `http://127.0.0.1:${s.server.address().port}`;
  }
});
after(() => {
  for (const s of [home, away, other]) {
    s.server.closeAllConnections?.();
    s.server.close();
  }
});
const CONFIG = "jellyfin";
beforeEach(() => {
  home.silent = false;
  away.silent = false;
  store.clear();
  store.set(CONFIG, { server: home.url, serverName: "Home", userId: "u1", userName: "me", token: "sealed:t", deviceId: "d1" });
});
const config = () => store.get(CONFIG);

test("an address away from home that leads to the same server is kept; at home the direct way stays in use", async () => {
  const s = await jf.setAway(away.url);
  assert.equal(s.away, away.url);
  assert.equal(s.home, home.url);
  assert.equal(config().server, home.url, "home answers: the direct way");
  assert.equal(s.reach, "home");
  assert.equal(config().serverId, "server-one");
});

test("somebody else's server at that address is refused", { timeout: 15000 }, async () => {
  await assert.rejects(jf.setAway(other.url), /another Jellyfin server/);
  assert.equal(config().away, undefined);
});

test("nothing answering there is said as such", { timeout: 15000 }, async () => {
  other.silent = true;
  await assert.rejects(jf.setAway(other.url), /Nothing answers/);
  other.silent = false;
});

test("out of the house: the address away takes over, and back home the direct one again", { timeout: 20000 }, async () => {
  await jf.setAway(away.url);
  home.silent = true;
  assert.equal(await jf.checkReach(), true, "a change to tell the page");
  assert.equal(config().server, away.url);
  assert.equal(jf.status().reach, "away");
  // Where the music and the covers come from follows: they're all made from the address in use.
  assert.equal(jf.syncLogin().server, away.url);
  home.silent = false;
  assert.equal(await jf.checkReach(), true);
  assert.equal(config().server, home.url);
  assert.equal(jf.status().reach, "home");
});

test("another server at the home address, in somebody else's house: not taken for ours", { timeout: 20000 }, async () => {
  await jf.setAway(away.url);
  // The laptop at a friend's: their server sits at the same private address.
  const real = home.id;
  home.id = "server-two";
  await jf.checkReach();
  assert.equal(config().server, away.url, "the address away, ours");
  home.id = real;
  await jf.checkReach();
  assert.equal(config().server, home.url);
});

test("neither answering: the address stays, and it says so", { timeout: 20000 }, async () => {
  await jf.setAway(away.url);
  home.silent = true;
  away.silent = true;
  await jf.checkReach();
  assert.equal(jf.status().reach, "offline");
  assert.equal(config().server, home.url, "nothing better to go to");
});

test("taken back: home again, and nothing switches any more", { timeout: 15000 }, async () => {
  await jf.setAway(away.url);
  home.silent = true;
  await jf.checkReach();
  const s = await jf.setAway("");
  assert.equal(s.away, null);
  assert.equal(config().server, home.url);
  assert.equal(await jf.checkReach(), false);
});

test("an address away without a scheme is https", () => {
  assert.equal(jf.normalizeServer("music.example.org", true), "https://music.example.org");
  assert.equal(jf.normalizeServer("nas:8096"), "http://nas:8096");
});
