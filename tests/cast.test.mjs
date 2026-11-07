// Casting to a network player — electron/upnp.ts (the protocol) and electron/cast.ts (the
// session) — against a fake DLNA renderer on localhost: discovery, its description, the
// SOAP calls, the media server it plays from, the once-a-second reports and the end of a song.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-cast-"));
const songFile = path.join(tmp, "song.flac");
fs.writeFileSync(songFile, Buffer.from("fLaC" + "0123456789".repeat(100)));

globalThis.__ssdp = { sent: [], replies: [], through: [] };
globalThis.__streams = [];
globalThis.__songFile = songFile;

const stubs = {
  name: "cast-stubs",
  setup(b) {
    b.onResolve({ filter: /^dgram$/ }, () => ({ path: "dgram", namespace: "stub" }));
    b.onResolve({ filter: /^\.\/(jellyfin|subsonic|local-library|tv-remote)$/ }, (a) => ({ path: a.path.slice(2), namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
      loader: "js",
      contents: {
        // SSDP on a fake socket: every search is answered with the replies the test lines up.
        dgram: `import { EventEmitter } from "node:events";
          export function createSocket() {
            const s = new EventEmitter();
            s.bind = (_port, cb) => setTimeout(cb, 0);
            s.setMulticastInterface = (address) => globalThis.__ssdp.through.push(address);
            s.send = (buf, port, address) => {
              globalThis.__ssdp.sent.push({ text: buf.toString(), port, address });
              for (const reply of globalThis.__ssdp.replies) setTimeout(() => s.emit("message", Buffer.from(reply)), 5);
            };
            s.close = () => {};
            return s;
          }`,
        jellyfin: `export const readLibrary = () => ({ tracks: [
            { id: "jf:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", container: "flac", codec: "flac" },
            { id: "jf:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", container: "m4a", codec: "alac" },
          ] });
          export async function fetchStream(id, range) {
            globalThis.__streams.push({ server: "jellyfin", id, range });
            return new Response("JELLYFIN-AUDIO", { status: range ? 206 : 200, headers: { "content-type": "audio/flac", "content-length": "14", "accept-ranges": "bytes", "x-secret": "token" } });
          }
          export async function deviceStreamUrl() {
            return globalThis.__direct ?? null;
          }`,
        subsonic: `export const SERVER_TRANSCODE = new Set(["wma", "alac"]);
          export const readLibrary = () => ({ tracks: [{ id: "ss:s1", suffix: "wma" }, { id: "ss:s2", suffix: "opus" }] });
          export async function fetchStream(id, range) {
            globalThis.__streams.push({ server: "subsonic", id, range });
            return new Response("NAVIDROME", { status: 200, headers: { "content-type": "audio/mpeg" } });
          }`,
        "local-library": `export const localStreamPath = (id) => (id === "local:0123456789abcdef" ? globalThis.__songFile : null);`,
        "tv-remote": `export const readTv = async () => null;
          export const switchTvOff = async () => false;
          export const startPairing = async () => undefined;
          export const finishPairing = async () => "failed";
          export const cancelPairing = () => undefined;`,
      }[a.path],
    }));
  },
};

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

/* ------------------------------------------------------------ fake renderer */
const UDN = "uuid:5a1b2c3d-0000-4000-8000-00000000cafe";
const description = (port) => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Living Room &amp; Kitchen</friendlyName>
    <manufacturer>Acme</manufacturer>
    <modelName>Streamer 2</modelName>
    <UDN>${UDN}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/upnp/control/rc</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>upnp/control/avt?x=1&amp;y=2</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

const calls = [];
const player = { uri: "", state: "NO_MEDIA_PRESENT", position: 0, duration: 0, volume: 35, muted: false, fetched: [], reportUri: true, comesForIt: true, afterHanding: "STOPPED" };
const field = (xml, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? "";
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const clock = (sec) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

const renderer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/moved.xml") {
    res.writeHead(302, { Location: "http://8.8.8.8/desc.xml" });
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/desc.xml") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(description(renderer.address().port));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const action = /#(\w+)"$/.exec(req.headers.soapaction ?? "")?.[1] ?? "";
    calls.push({ path: url.pathname + url.search, action, body, type: req.headers["content-type"] });
    const reply = (inner) => {
      res.writeHead(200, { "Content-Type": 'text/xml; charset="utf-8"' });
      res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="x">${inner}</u:${action}Response></s:Body></s:Envelope>`);
    };
    switch (action) {
      case "SetAVTransportURI":
        player.uri = unescape(field(body, "CurrentURI"));
        player.meta = unescape(field(body, "CurrentURIMetaData"));
        player.state = player.afterHanding;
        player.position = 0;
        // A real player fetches what it was given.
        if (player.comesForIt) void fetch(player.uri, { headers: { Range: "bytes=4-13" } }).then(async (r) => player.fetched.push({ status: r.status, text: await r.text(), headers: Object.fromEntries(r.headers) })).catch(() => undefined);
        return reply("");
      case "Play":
        player.state = player.comesForIt ? "PLAYING" : player.afterHanding;
        return reply("");
      case "Pause":
        player.state = "PAUSED_PLAYBACK";
        return reply("");
      case "Stop":
        player.state = "STOPPED";
        player.position = 0;
        return reply("");
      case "Seek":
        player.position = field(body, "Target").split(":").reduce((n, p) => n * 60 + Number(p), 0);
        return reply("");
      case "GetPositionInfo":
        return reply(`<Track>1</Track><TrackDuration>${clock(player.duration)}</TrackDuration><TrackURI>${player.reportUri ? player.uri.replace(/&/g, "&amp;") : ""}</TrackURI><RelTime>${clock(player.position)}</RelTime>`);
      case "GetTransportInfo":
        return reply(`<CurrentTransportState>${player.state}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>`);
      case "GetVolume":
        return reply(`<CurrentVolume>${player.volume}</CurrentVolume>`);
      case "SetVolume":
        player.volume = Number(field(body, "DesiredVolume"));
        return reply("");
      case "GetMute":
        return reply(`<CurrentMute>${player.muted ? 1 : 0}</CurrentMute>`);
      case "SetMute":
        player.muted = field(body, "DesiredMute") === "1";
        return reply("");
      default:
        res.writeHead(500, { "Content-Type": "text/xml" });
        res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>401</errorCode><errorDescription>Invalid Action &amp; more</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
    }
  });
});

let upnp, cast, base;
before(async () => {
  await new Promise((r) => renderer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${renderer.address().port}`;
  [upnp, cast] = await Promise.all([load("upnp"), load("cast")]);
});
after(async () => {
  await cast?.stop();
  renderer.closeAllConnections();
  await new Promise((r) => renderer.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------ upnp.ts */
test("only http on a private, loopback or link-local IPv4 address counts as the local network", () => {
  for (const ok of ["http://192.168.1.20:49152/desc.xml", "http://10.0.0.5/x", "http://172.16.0.1/", "http://172.31.255.1/", "http://127.0.0.1:8080/", "http://169.254.3.4/"]) {
    assert.equal(upnp.isLanUrl(ok), true, ok);
  }
  for (const no of ["https://192.168.1.20/", "http://8.8.8.8/desc.xml", "http://172.32.0.1/", "http://example.com/", "http://[::1]/", "file:///C:/x", "not a url"]) {
    assert.equal(upnp.isLanUrl(no), false, no);
  }
});

test("SSDP replies are read as headers, names lower-cased", () => {
  const h = upnp.parseSsdp("HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.168.1.20:1400/xml/device.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n");
  assert.equal(h.location, "http://192.168.1.20:1400/xml/device.xml");
  assert.equal(h["cache-control"], "max-age=1800");
  assert.equal(h.st, "urn:schemas-upnp-org:device:MediaRenderer:1");
});

test("a description gives the player's name and its control URLs, resolved against it", () => {
  const r = upnp.parseDescription(description(1234), "http://192.168.1.20:1234/desc.xml");
  assert.equal(r.id, UDN);
  assert.equal(r.name, "Living Room & Kitchen");
  assert.equal(r.model, "Acme Streamer 2");
  assert.equal(r.avTransport.url, "http://192.168.1.20:1234/upnp/control/avt?x=1&y=2");
  assert.equal(r.avTransport.type, "urn:schemas-upnp-org:service:AVTransport:1");
  assert.equal(r.renderingControl.url, "http://192.168.1.20:1234/upnp/control/rc");
  // URLBase wins over the description's own address.
  const based = upnp.parseDescription(description(1).replace("<device>", "<URLBase>http://192.168.1.21:5000/</URLBase><device>"), "http://192.168.1.20:1/desc.xml");
  assert.equal(based.avTransport.url, "http://192.168.1.21:5000/upnp/control/avt?x=1&y=2");
});

test("a description pointing its controls off the local network, or without AVTransport, is no player", () => {
  const away = description(1).replace("upnp/control/avt?x=1&amp;y=2", "http://8.8.8.8/avt");
  assert.equal(upnp.parseDescription(away, "http://192.168.1.20:1/desc.xml"), null);
  const server = description(1).replace(/<service>\s*<serviceType>urn:schemas-upnp-org:service:AVTransport[\s\S]*?<\/service>/, "");
  assert.equal(upnp.parseDescription(server, "http://192.168.1.20:1/desc.xml"), null);
  // An outside RenderingControl is dropped, the player stays.
  const rcAway = description(1).replace("/upnp/control/rc", "http://8.8.8.8/rc");
  assert.equal(upnp.parseDescription(rcAway, "http://192.168.1.20:1/desc.xml").renderingControl, undefined);
});

test("a description that redirects is not followed", async () => {
  await assert.rejects(upnp.describe(`${base}/moved.xml`));
  assert.equal(await upnp.describe("http://8.8.8.8/desc.xml"), null); // never fetched
  assert.equal((await upnp.describe(`${base}/desc.xml`)).name, "Living Room & Kitchen");
});

test("clock strings both ways", () => {
  assert.equal(upnp.parseClock("0:04:12"), 252);
  assert.equal(upnp.parseClock("1:00:00.500"), 3600.5);
  assert.equal(upnp.parseClock("NOT_IMPLEMENTED"), 0);
  assert.equal(upnp.parseClock(undefined), 0);
  assert.equal(upnp.clock(252.9), "0:04:12");
  assert.equal(upnp.clock(3725), "1:02:05");
  assert.equal(upnp.clock(-3), "0:00:00");
});

test("the DIDL item escapes everything put into it", () => {
  const xml = upnp.didl("http://192.168.1.5:5000/cast/abc/song.flac?a=1&b=2", { title: 'Rock <&> "Roll"', artist: "AC/DC's", album: "", duration: 61, mime: "audio/flac" });
  assert.match(xml, /<dc:title>Rock &lt;&amp;&gt; &quot;Roll&quot;<\/dc:title>/);
  assert.match(xml, /<dc:creator>AC\/DC&apos;s<\/dc:creator>/);
  assert.match(xml, /protocolInfo="http-get:\*:audio\/flac:\*" duration="0:01:01.000"/);
  assert.match(xml, />http:\/\/192\.168\.1\.5:5000\/cast\/abc\/song\.flac\?a=1&amp;b=2<\/res>/);
  assert.doesNotMatch(upnp.didl("http://x/", { title: "t", artist: "a", album: "", duration: 0, mime: "audio/mpeg" }), /duration=/);
});

test("SOAP: the action goes in the header and the body, escaped; a refusal carries the player's own words", async () => {
  const service = { url: `${base}/upnp/control/avt`, type: "urn:schemas-upnp-org:service:AVTransport:1" };
  calls.length = 0;
  await upnp.soap(service, "Seek", { InstanceID: 0, Unit: "REL_TIME", Target: "0:01:00" });
  assert.equal(calls[0].action, "Seek");
  assert.match(calls[0].type, /text\/xml/);
  assert.match(calls[0].body, /<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0<\/InstanceID><Unit>REL_TIME<\/Unit><Target>0:01:00<\/Target><\/u:Seek>/);
  await upnp.soap(service, "Seek", { Target: "<x>&" });
  assert.match(calls[1].body, /<Target>&lt;x&gt;&amp;<\/Target>/);
  await assert.rejects(upnp.soap(service, "Explode", {}), /The player refused Explode: Invalid Action & more/);
});

/* ------------------------------------------------------------ cast.ts helpers */
test("byte ranges the way players ask for them", () => {
  assert.deepEqual(cast.byteRange(undefined, 1000), { start: 0, end: 999, partial: false });
  assert.deepEqual(cast.byteRange("bytes=0-", 1000), { start: 0, end: 999, partial: true });
  assert.deepEqual(cast.byteRange("bytes=100-199", 1000), { start: 100, end: 199, partial: true });
  assert.deepEqual(cast.byteRange("bytes=900-5000", 1000), { start: 900, end: 999, partial: true });
  assert.deepEqual(cast.byteRange("bytes=-100", 1000), { start: 900, end: 999, partial: true });
  assert.equal(cast.byteRange("bytes=1000-", 1000), null);
  assert.equal(cast.byteRange("bytes=500-100", 1000), null);
  assert.deepEqual(cast.byteRange("items=0-5", 1000), { start: 0, end: 999, partial: false });
});

test("only songs of the library can be cast; their texts are trimmed to size", () => {
  const s = cast.songFrom({ id: "local:0123456789abcdef", title: "x".repeat(500), artist: " ", album: 3, duration: "200" });
  assert.equal(s.title.length, 200);
  assert.equal(s.artist, "Unknown artist");
  assert.equal(s.album, "");
  assert.equal(s.duration, 200);
  for (const id of ["yt:abc", "local:../../etc", "jf:", "http://x", 42, undefined]) {
    assert.throws(() => cast.songFrom({ id, title: "t" }), /can't be cast/, String(id));
  }
  assert.throws(() => cast.songFrom(null), /can't be cast/);
});

test("the address offered to the player is the one on its network", () => {
  const nets = {
    vEthernet: [{ address: "172.20.0.1", netmask: "255.255.240.0", family: "IPv4", internal: false }],
    WiFi: [
      { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false },
      { address: "192.168.178.24", netmask: "255.255.255.0", family: "IPv4", internal: false },
    ],
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
  };
  assert.equal(cast.addressFor("192.168.178.50", nets), "192.168.178.24");
  assert.equal(cast.addressFor("172.20.3.9", nets), "172.20.0.1");
  assert.equal(cast.addressFor("10.1.1.1", nets), "172.20.0.1"); // no match: the first real address
  assert.equal(cast.addressFor("127.0.0.1", nets), "127.0.0.1");
  assert.equal(cast.addressFor("192.168.178.50", { lo: nets.lo }), null);
});

test("server songs are announced in the format they stream in", () => {
  assert.equal(cast.serverStreamExt({ id: "jf:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), ".flac");
  assert.equal(cast.serverStreamExt({ id: "jf:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), ".flac"); // ALAC: converted to FLAC
  assert.equal(cast.serverStreamExt({ id: "jf:cccccccccccccccccccccccccccccccc" }), ".flac"); // not listed yet: the original, mostly FLAC
  assert.equal(cast.serverStreamExt({ id: "ss:s1" }), ".mp3"); // WMA: converted to MP3
  assert.equal(cast.serverStreamExt({ id: "ss:s2" }), ".opus");
});

/* ------------------------------------------------------------ a session */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await wait(20);
  }
  throw new Error("timed out");
}

test("a whole session: find, connect, play a file and a server song, steer, the end, stop", { timeout: 30000 }, async () => {
  globalThis.__ssdp.replies = [
    `HTTP/1.1 200 OK\r\nLOCATION: ${base}/desc.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n`,
    `HTTP/1.1 200 OK\r\nLOCATION: ${base}/desc.xml\r\n\r\n`, // the same player answering twice
    `HTTP/1.1 200 OK\r\nLOCATION: http://8.8.8.8/desc.xml\r\n\r\n`, // never followed
  ];
  const devices = await cast.findDevices();
  assert.deepEqual(devices, [{ id: UDN, name: "Living Room & Kitchen", model: "Acme Streamer 2", kind: "upnp" }]);
  // Through each network this computer is on, not just the one with the best route: that may be a VPN's.
  const { lanAddresses } = await load("net-lan");
  const networks = lanAddresses();
  assert.deepEqual(new Set(globalThis.__ssdp.through), new Set(networks));
  const searches = globalThis.__ssdp.sent.filter((m) => m.text.startsWith("M-SEARCH"));
  assert.equal(searches.length, 2 * Math.max(1, networks.length), "and through each of them twice");
  assert.match(searches[0].text, /^M-SEARCH \* HTTP\/1\.1\r\n/);
  assert.equal(searches[0].address, "239.255.255.250");
  assert.equal(searches[0].port, 1900);

  await assert.rejects(cast.start("uuid:nobody", () => undefined), /isn't on the network anymore/);
  const statuses = [];
  const started = await cast.start(UDN, (s) => statuses.push({ ...s }));
  assert.deepEqual(started.device, { id: UDN, name: "Living Room & Kitchen" });
  assert.equal(started.volume, 0.35); // read, not set: the player's volume stays where it is
  assert.equal(started.muted, false);
  assert.equal(calls.filter((c) => c.action === "SetVolume").length, 0);

  // A local file, from 0:42, paused: loaded, started, sought, paused.
  calls.length = 0;
  player.duration = 200;
  await cast.load(cast.songFrom({ id: "local:0123456789abcdef", title: "Song <1>", artist: "Band", album: "LP", duration: 200 }), 42, false);
  assert.deepEqual(
    calls.map((c) => c.action),
    ["SetAVTransportURI", "Play", "Seek", "Pause"]
  );
  assert.match(player.uri, /^http:\/\/127\.0\.0\.1:\d+\/cast\/[a-f0-9]{32}\/song\.flac$/);
  assert.match(player.meta, /<dc:title>Song &lt;1&gt;<\/dc:title>/);
  assert.match(player.meta, /audio\/flac/);
  assert.equal(player.state, "PAUSED_PLAYBACK");
  assert.equal(player.position, 42);
  await until(() => player.fetched.length === 1);
  await until(() => cast.castStatus().fetched); // the player asked for the song: it can reach this computer
  assert.equal(player.fetched[0].status, 206);
  assert.equal(player.fetched[0].text, "0123456789");
  assert.equal(player.fetched[0].headers["content-range"], "bytes 4-13/1004");
  assert.equal(player.fetched[0].headers["content-type"], "audio/flac");
  assert.equal(player.fetched[0].headers["transfermode.dlna.org"], "Streaming");

  // The media server serves only the song being cast, under its own path.
  const token = /\/cast\/([a-f0-9]{32})\//.exec(player.uri)[1];
  const port = new URL(player.uri).port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/cast/${"0".repeat(32)}/song.flac`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
  assert.equal((await fetch(player.uri, { method: "POST" })).status, 404);
  assert.equal((await fetch(player.uri, { headers: { Range: "bytes=5000-" } })).status, 416);
  const head = await fetch(player.uri, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "1004");

  // Steering, and what the reports say.
  await cast.control("play", 0);
  assert.equal(player.state, "PLAYING");
  await until(() => statuses.some((s) => s.state === "playing" && s.position === 42 && s.trackId === "local:0123456789abcdef"));
  await cast.control("seek", 100);
  assert.equal(player.position, 100);
  await cast.control("volume", 0.5);
  assert.equal(player.volume, 50);
  await cast.control("mute", 1);
  assert.equal(player.muted, true);
  await cast.control("mute", 0);
  await assert.rejects(cast.control("explode", 0), /Unknown cast command/);

  // A server song streams through, without the server's headers or token.
  player.fetched.length = 0;
  await cast.load(cast.songFrom({ id: "jf:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Remote", artist: "Band", duration: 180 }), 0, true);
  assert.notEqual(/\/cast\/([a-f0-9]{32})\//.exec(player.uri)[1], token); // a new path for every song
  assert.ok(statuses.some((s) => s.trackId === "jf:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" && s.fetched === false), "not yet fetched, the new song");
  assert.equal((await fetch(`http://127.0.0.1:${port}/cast/${token}/song.flac`)).status, 404); // the old one is gone
  await until(() => player.fetched.length === 1);
  assert.equal(player.fetched[0].text, "JELLYFIN-AUDIO");
  assert.equal(player.fetched[0].headers["x-secret"], undefined);
  assert.deepEqual(globalThis.__streams.at(-1), { server: "jellyfin", id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", range: "bytes=4-13" });
  await assert.rejects(cast.load(cast.songFrom({ id: "local:ffffffffffffffff", title: "Gone", duration: 10 }), 0, true), /can't be reached/);

  // Reports about the song before (the player hasn't switched yet) are left out.
  player.duration = 180;
  const realUri = player.uri;
  player.uri = "http://127.0.0.1:1/cast/" + "e".repeat(32) + "/song.flac";
  player.position = 170;
  const before = statuses.length;
  await wait(1300);
  assert.ok(statuses.slice(before).every((s) => s.position !== 170), "a stale report got through");
  player.uri = realUri;

  // Played to its end: reported once.
  player.state = "PLAYING";
  player.position = 178;
  await until(() => statuses.some((s) => s.position === 178 && s.state === "playing"));
  player.state = "STOPPED";
  player.position = 0;
  await until(() => statuses.some((s) => s.ended));
  const ended = statuses.filter((s) => s.ended);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].position, 180);
  await wait(1200);
  assert.equal(statuses.filter((s) => s.ended).length, 1);

  // A player that leaves the song's URI out of its reports is still followed.
  player.reportUri = false;
  player.state = "PAUSED_PLAYBACK";
  player.position = 12;
  await until(() => statuses.some((s) => s.state === "paused" && s.position === 12));
  player.reportUri = true;

  // Stop: the player stops, the media server closes, the session reads idle.
  calls.length = 0;
  await cast.stop();
  assert.deepEqual(calls.map((c) => c.action), ["Stop"]);
  assert.equal(cast.castStatus().device, null);
  assert.equal(cast.castStatus().state, "idle");
  await assert.rejects(fetch(realUri), /fetch failed/);
  await assert.rejects(cast.load(cast.songFrom({ id: "local:0123456789abcdef", title: "x", duration: 1 }), 0, true), /Not casting/);
  await assert.rejects(cast.control("play", 0), /Not casting/);
});

test("a server song goes straight to a device that can fetch it; one that never comes for a song through here is told of once, and gets it again", { timeout: 20000 }, async () => {
  globalThis.__ssdp.replies = [`HTTP/1.1 200 OK\r\nLOCATION: ${base}/desc.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n`];
  await cast.findDevices();
  const statuses = [];
  await cast.start(UDN, (s) => statuses.push({ ...s }));
  const song = cast.songFrom({ id: "jf:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Remote", artist: "Band", duration: 180 });
  const handed = () => calls.filter((c) => c.action === "SetAVTransportURI").length;
  const realNow = Date.now;
  player.comesForIt = false;
  player.afterHanding = "TRANSITIONING";
  try {
    // Straight from the server: there's nothing here to wait for, and nothing to hand again.
    const direct = "http://192.168.1.20:8096/Audio/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/stream?static=true";
    globalThis.__direct = direct;
    await cast.load(song, 0, true);
    assert.equal(player.uri, direct);
    assert.equal(cast.castStatus().through, false);
    Date.now = () => realNow() + 30_000;
    await wait(1200);
    assert.ok(!statuses.some((s) => s.unreachable), "a song straight from the server says nothing about this computer");
    let before = handed();
    await cast.againAll();
    assert.equal(handed(), before);
    Date.now = realNow;

    // Its server out of the device's reach: through this computer, as before.
    globalThis.__direct = null;
    await cast.load(song, 0, true);
    assert.match(player.uri, /\/cast\/[a-f0-9]{32}\/song\.flac$/);
    assert.equal(cast.castStatus().through, true);
    await wait(1200);
    assert.ok(!statuses.some((s) => s.unreachable), "it has time to wake up first");

    // It never came for it: said once.
    Date.now = () => realNow() + 30_000;
    await until(() => statuses.some((s) => s.unreachable));
    assert.deepEqual(statuses.find((s) => s.unreachable).unreachable, { id: UDN, name: "Living Room & Kitchen" });
    await wait(1200);
    assert.equal(statuses.filter((s) => s.unreachable).length, 1);
    Date.now = realNow;

    // The way may be open now: the song once more, under a new address.
    const old = player.uri;
    before = handed();
    await cast.againAll();
    assert.equal(handed(), before + 1);
    assert.notEqual(player.uri, old);

    // Fetched: nothing to say and nothing to hand again.
    player.comesForIt = true;
    player.afterHanding = "STOPPED";
    await cast.load(song, 0, true);
    await until(() => cast.castStatus().fetched);
    before = handed();
    await cast.againAll();
    assert.equal(handed(), before);
  } finally {
    Date.now = realNow;
    globalThis.__direct = null;
    player.comesForIt = true;
    player.afterHanding = "STOPPED";
    await cast.stop();
  }
});

test("the computer's own addresses on its networks: not its loopback, not IPv6", async () => {
  const { lanAddresses } = await load("net-lan");
  assert.deepEqual(
    lanAddresses({
      Loopback: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      Ethernet: [
        { family: "IPv6", address: "fe80::1", internal: false },
        { family: "IPv4", address: "192.168.1.20", internal: false },
      ],
      VPN: [{ family: "IPv4", address: "10.8.0.2", internal: false }],
      Unplugged: undefined,
    }),
    ["192.168.1.20", "10.8.0.2"]
  );
});
