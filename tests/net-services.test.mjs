// What Songsta may ask the internet (src/lib/netServices.ts): every address in the code belongs to a
// service in the list (so Settings → Network & privacy shows it and its switch holds it back), your own
// servers and the home network always go, "only my own servers" stops everything else.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({ stdin: { contents: `export * from "./netServices";`, resolveDir: lib, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { NET_SERVICES, serviceOfHost, isHomeHost, judgeRequest, hostsOf, readPolicy } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const root = fileURLToPath(new URL("../", import.meta.url));
/** Addresses in the code that aren't requests: XML namespaces, links you open in your browser, examples. */
const NOT_ASKED = new Set(["www.w3.org", "schemas.xmlsoap.org", "purl.org", "invalid.invalid", "music.example.org", "discord.com", "exportify.net", "open.spotify.com", "www.qobuz.com", "bandcamp.com", "www.7digital.com", "us.7digital.com", "www.amazon.com", "www.amazon.de", "music.amazon.com"]);

function sources(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

test("every address the code asks belongs to a service in the list", () => {
  const files = [...sources(path.join(root, "electron")), ...sources(path.join(root, "mobile", "src")), ...sources(path.join(root, "src", "lib"))];
  const strays = new Set();
  let seen = 0;
  for (const file of files) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/:"'`?]|$)/gi)) {
      const host = m[1].toLowerCase();
      if (NOT_ASKED.has(host) || isHomeHost(host)) continue;
      seen += 1;
      if (!serviceOfHost(host)) strays.add(`${host} (${path.relative(root, file)})`);
    }
  }
  assert.ok(seen > 30, `the code's addresses are found (${seen})`);
  assert.deepEqual([...strays], [], "an address no switch holds back: add its service to src/lib/netServices.ts");
});

test("the names services answer at, pictures and videos included", () => {
  const cases = {
    "musicbrainz.org": "musicbrainz",
    "coverartarchive.org": "coverart",
    "ia800906.us.archive.org": "coverart",
    "itunes.apple.com": "itunes",
    "is1-ssl.mzstatic.com": "itunes",
    "de.wikipedia.org": "wikipedia",
    "www.wikidata.org": "wikipedia",
    "upload.wikimedia.org": "wikipedia",
    "images.genius.com": "genius",
    "lrclib.net": "lrclib",
    "lyrics-api.boidu.dev": "boidu",
    "unison.boidu.dev": "boidu",
    "amp-api.music.apple.com": "paxsenix",
    "lyricsplus-seven.vercel.app": "lyricsplus",
    "mobileservice.kugou.com": "kugou",
    "apic.musixmatch.com": "musixmatch",
    "resources.tidal.com": "tidal",
    "objects.githubusercontent.com": "github",
    "api.github.com": "github",
  };
  for (const [host, id] of Object.entries(cases)) assert.equal(serviceOfHost(host)?.id, id, host);
  assert.equal(serviceOfHost("evil-musicbrainz.org"), null, "a name merely ending the same way isn't theirs");
  assert.equal(serviceOfHost("example.com"), null);
  assert.equal(new Set(NET_SERVICES.map((s) => s.id)).size, NET_SERVICES.length, "each service once");
});

test("the home network and this computer", () => {
  for (const h of ["localhost", "127.0.0.1", "192.168.1.50", "10.0.0.5", "172.20.1.1", "100.101.102.103", "[::1]", "fd12::1", "matrix", "nas.local", "pi.fritz.box"]) assert.equal(isHomeHost(h), true, h);
  for (const h of ["8.8.8.8", "172.32.0.1", "musicbrainz.org", "2001:db8::1", "jellyfin.example.work"]) assert.equal(isHomeHost(h), false, h);
});

test("your own servers always go; a switched-off service doesn't; only my own servers stops the rest", () => {
  const own = hostsOf(["https://jellyfin.example.work", "http://192.168.1.50:8096", "not an address", null]);
  assert.deepEqual([...own].sort(), ["192.168.1.50", "jellyfin.example.work"]);
  const open = { ownOnly: false, off: [] };
  const someOff = { ownOnly: false, off: ["genius", "lrclib"] };
  const closed = { ownOnly: true, off: [] };
  assert.equal(judgeRequest("https://jellyfin.example.work/Items", closed, own).allowed, true, "your server, even with everything off");
  assert.equal(judgeRequest("http://192.168.1.20/description.xml", closed, own).kind, "own", "a device at home");
  assert.equal(judgeRequest("https://genius.com/api/search", open, own).allowed, true);
  assert.equal(judgeRequest("https://genius.com/api/search", someOff, own).allowed, false);
  assert.equal(judgeRequest("https://musicbrainz.org/ws/2/", someOff, own).allowed, true);
  assert.equal(judgeRequest("https://musicbrainz.org/ws/2/", closed, own).allowed, false);
  const elsewhere = judgeRequest("https://somewhere.example/x", open, own);
  assert.deepEqual([elsewhere.kind, elsewhere.allowed], ["other", true]);
  assert.equal(judgeRequest("https://somewhere.example/x", closed, own).allowed, false);
});

/** An address at one of a service's names (a name under it where its list says ".name"). */
const at = (name) => `https://${name.startsWith(".") ? `cdn${name}` : name}/some/path?q=secret`;

test("every combination of the switches: each set of services off, with and without only my own servers", () => {
  const ids = NET_SERVICES.map((s) => s.id);
  const own = hostsOf(["https://jellyfin.example.work", "https://sync.example.work:8443"]);
  const probes = NET_SERVICES.map((s, i) => ({ id: s.id, bit: 2 ** i, url: at(s.hosts[0]) }));
  const always = ["https://jellyfin.example.work/Items", "https://sync.example.work:8443/v1/changes", "http://192.168.1.50:8096/x", "http://nas.local/x", "http://[fd00::5]/x", "http://localhost:5173/"];
  const elsewhere = ["https://somewhere.example/x", "https://8.8.8.8/dns"];
  const wrong = [];
  let checked = 0;
  for (let mask = 0; mask < 2 ** ids.length && wrong.length < 5; mask++) {
    const off = ids.filter((_, i) => mask & (2 ** i));
    for (const ownOnly of [false, true]) {
      const policy = { ownOnly, off };
      for (const p of probes) {
        const v = judgeRequest(p.url, policy, own);
        if (v.kind !== "service" || v.service.id !== p.id || v.allowed !== (!ownOnly && !(mask & p.bit))) wrong.push(`${p.url} with ${JSON.stringify(policy)}`);
      }
      for (const url of always) if (!judgeRequest(url, policy, own).allowed) wrong.push(`${url} with ${JSON.stringify(policy)}`);
      for (const url of elsewhere) if (judgeRequest(url, policy, own).allowed !== !ownOnly) wrong.push(`${url} with ${JSON.stringify(policy)}`);
      checked += probes.length + always.length + elsewhere.length;
    }
  }
  assert.deepEqual(wrong, []);
  assert.equal(checked, 2 ** ids.length * 2 * (probes.length + always.length + elsewhere.length), "all combinations were judged");
});

test("every name a service answers at is held back by its own switch, and by no other", () => {
  const ids = NET_SERVICES.map((s) => s.id);
  const own = new Set();
  for (const s of NET_SERVICES) {
    for (const name of s.hosts) {
      const url = at(name);
      assert.equal(judgeRequest(url, { ownOnly: false, off: [] }, own).allowed, true, url);
      assert.equal(judgeRequest(url, { ownOnly: false, off: [s.id] }, own).allowed, false, url);
      assert.equal(judgeRequest(url, { ownOnly: false, off: ids.filter((id) => id !== s.id) }, own).allowed, true, `${url}: the other switches don't touch it`);
      assert.equal(judgeRequest(url, { ownOnly: true, off: [] }, own).allowed, false, url);
      const odd = new URL(url);
      odd.hostname = `${odd.hostname.toUpperCase()}.`;
      assert.equal(judgeRequest(odd.href, { ownOnly: false, off: [s.id] }, own).allowed, false, `${odd.href}: a closing dot or capitals are the same name`);
    }
  }
  // A home-network name with a closing dot is still at home; your server's too.
  assert.equal(isHomeHost("nas.local."), true);
  assert.deepEqual([...hostsOf(["https://Jellyfin.Example.Work./web"])], ["jellyfin.example.work"]);
  assert.equal(judgeRequest("https://jellyfin.example.work./Items", { ownOnly: true, off: [] }, hostsOf(["https://jellyfin.example.work"])).kind, "own");
});

test("saved settings are read with care", () => {
  assert.deepEqual(readPolicy({ state: { netOwnOnly: true, netOff: ["genius", "nonsense", 3] } }), { ownOnly: true, off: ["genius"] });
  assert.deepEqual(readPolicy(null), { ownOnly: false, off: [] });
  assert.deepEqual(readPolicy({ netOff: "genius" }), { ownOnly: false, off: [] });
});
