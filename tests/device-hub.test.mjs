// The parts of the device area both apps share: Google Cast's frames and client against a stand-in
// device (src/lib/castV2.ts), reading what answers on the network (src/lib/netScan.ts) and a zone with
// its own queue (src/lib/zoneEngine.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function load(file) {
  const out = await build({ entryPoints: [fileURLToPath(new URL(`../src/lib/${file}`, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
async function loadFrom(relative) {
  const out = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const cast = await load("castV2.ts");
const scan = await load("netScan.ts");
const zones = await load("zoneEngine.ts");

/* ------------------------------------------------------------ Cast */

test("a frame survives the wire, also cut in pieces and with any letters", () => {
  const m = { source: "sender-0", destination: "receiver-0", namespace: "urn:x-cast:test", payload: JSON.stringify({ title: "Tøyen – 夜 🌙" }) };
  const frame = cast.encodeFrame(m);
  const reader = new cast.FrameReader();
  assert.deepEqual(reader.push(frame.slice(0, 7)), []);
  const [got] = reader.push(frame.slice(7));
  assert.deepEqual(got, m);
  assert.deepEqual(reader.push(new Uint8Array([...frame, ...frame])).length, 2);
});

/** A device on the other end of a socket, as far as the client gets to see it. */
function fakeDevice(behaviour = {}) {
  const device = { apps: [], media: null, heard: [], closed: false, autoFinish: false, volume: 0.4 };
  const reader = new cast.FrameReader();
  let data = () => undefined;
  let close = () => undefined;
  const reply = (to, namespace, payload) =>
    data(cast.encodeFrame({ source: to.destination, destination: to.source, namespace, payload: JSON.stringify(payload) }));
  const receiverStatus = (requestId) => ({
    type: "RECEIVER_STATUS",
    requestId,
    status: { applications: device.apps, volume: { level: device.volume, muted: false } },
  });
  const mediaStatus = (requestId) => ({ type: "MEDIA_STATUS", requestId, status: device.media ? [device.media] : [] });
  const socket = {
    write(bytes) {
      for (const m of reader.push(bytes)) {
        const body = JSON.parse(m.payload);
        device.heard.push({ to: m.destination, ...body });
        if (m.namespace.endsWith("receiver")) {
          if (body.type === "GET_STATUS") reply(m, m.namespace, receiverStatus(body.requestId));
          if (body.type === "LAUNCH") {
            device.apps = [{ appId: body.appId, sessionId: "s1", transportId: "t1", displayName: "Default Media Receiver" }];
            reply(m, m.namespace, receiverStatus(body.requestId));
          }
          if (body.type === "SET_VOLUME") {
            if (typeof body.volume.level === "number") device.volume = body.volume.level;
            reply(m, m.namespace, receiverStatus(body.requestId));
          }
          if (body.type === "STOP") {
            device.apps = [];
            device.media = null;
            reply(m, m.namespace, receiverStatus(body.requestId));
          }
        }
        if (m.namespace.endsWith("media")) {
          if (body.type === "LOAD") {
            if (behaviour.refuseLoad) reply(m, m.namespace, { type: "LOAD_FAILED", requestId: body.requestId });
            else {
              device.media = { mediaSessionId: 7, playerState: body.autoplay ? "PLAYING" : "PAUSED", currentTime: body.currentTime, media: { contentId: body.media.contentId, duration: body.media.duration } };
              reply(m, m.namespace, mediaStatus(body.requestId));
            }
          }
          if (body.type === "GET_STATUS") reply(m, m.namespace, mediaStatus(body.requestId));
          if (body.type === "PAUSE") {
            device.media.playerState = "PAUSED";
            reply(m, m.namespace, mediaStatus(body.requestId));
          }
          if (body.type === "PLAY") {
            device.media.playerState = "PLAYING";
            reply(m, m.namespace, mediaStatus(body.requestId));
          }
          if (body.type === "SEEK") {
            device.media.currentTime = body.currentTime;
            reply(m, m.namespace, mediaStatus(body.requestId));
          }
        }
      }
    },
    close() {
      device.closed = true;
      close();
    },
    onData: (l) => (data = l),
    onClose: (l) => (close = l),
  };
  return { device, socket, hangUp: () => close(), ping: () => data(cast.encodeFrame({ source: "receiver-0", destination: "x", namespace: "urn:x-cast:com.google.cast.tp.heartbeat", payload: '{"type":"PING"}' })) };
}

test("the client starts the device's own player, loads a song and steers it", async (t) => {
  const { device, socket } = fakeDevice();
  const client = new cast.CastClient(socket);
  t.after(() => client.close());
  await client.load({ url: "http://x/song.flac", contentType: "audio/flac", title: "Song", artist: "Band", album: "Album", duration: 100, art: "http://x/art.jpg" }, 12, true);
  assert.ok(device.heard.some((h) => h.type === "LAUNCH" && h.appId === cast.DEFAULT_MEDIA_RECEIVER));
  const load = device.heard.find((h) => h.type === "LOAD");
  assert.equal(load.to, "t1");
  assert.equal(load.media.metadata.title, "Song");
  assert.equal(load.currentTime, 12);
  assert.equal(load.sessionId, "s1");

  let now = await client.playback();
  assert.equal(now.state, "PLAYING");
  assert.equal(now.url, "http://x/song.flac");
  await client.pause();
  assert.equal((await client.playback()).state, "PAUSED");
  await client.seek(50);
  assert.equal((await client.playback()).position, 50);

  await client.setVolume(0.2);
  assert.equal(device.volume, 0.2);
  await client.stop();
  assert.deepEqual(device.apps, []);
  now = await client.playback();
  assert.equal(now.state, "IDLE");
});

test("a second song needs no second start of the player; a song the device can't play says so", async (t) => {
  const { device, socket } = fakeDevice();
  const client = new cast.CastClient(socket);
  t.after(() => client.close());
  const song = { url: "http://x/a.flac", contentType: "audio/flac", title: "A", artist: "", album: "", duration: 10 };
  await client.load(song, 0, true);
  await client.load({ ...song, url: "http://x/b.flac" }, 0, true);
  assert.equal(device.heard.filter((h) => h.type === "LAUNCH").length, 1);

  const refusing = fakeDevice({ refuseLoad: true });
  const other = new cast.CastClient(refusing.socket);
  t.after(() => other.close());
  await assert.rejects(other.load(song, 0, true), /can't play this song/);
});

test("the device's pings are answered, its status read without starting anything", async (t) => {
  const { device, socket, ping } = fakeDevice();
  const client = new cast.CastClient(socket);
  t.after(() => client.close());
  ping();
  assert.ok(device.heard.some((h) => h.type === "PONG"));
  const status = await client.receiverStatus();
  assert.deepEqual(status, { apps: [], volume: 0.4, muted: false });
  assert.ok(!device.heard.some((h) => h.type === "LAUNCH"));
});

test("a connection that breaks fails what's waiting and says so", async () => {
  const { socket, hangUp } = fakeDevice();
  const client = new cast.CastClient(socket);
  let told = 0;
  client.onChange = () => (told += 1);
  hangUp();
  assert.equal(client.closed, true);
  assert.ok(told > 0);
  await assert.rejects(client.receiverStatus(), /isn't connected/);
});

/* ------------------------------------------------------------ the network */

/** An mDNS answer the way devices send them, with a pointer back into the packet as they do. */
function mdnsAnswer() {
  const name = (text) => {
    const out = [];
    for (const label of text.split(".")) {
      const b = Buffer.from(label);
      out.push(b.length, ...b);
    }
    out.push(0);
    return out;
  };
  const service = "_googlecast._tcp.local";
  const instance = `Google-TV-abc.${service}`;
  const record = (rname, type, data) => [...name(rname), 0, type, 0, 1, 0, 0, 0, 120, data.length >> 8, data.length & 255, ...data];
  const txt = [];
  for (const entry of ["id=abc123", "fn=Bedroom TV", "md=Google TV Streamer"]) {
    const b = Buffer.from(entry);
    txt.push(b.length, ...b);
  }
  return Uint8Array.from([
    0, 0, 0x84, 0, 0, 0, 0, 3, 0, 0, 0, 0,
    ...record(service, 12, name(instance)),
    ...record(instance, 33, [0, 0, 0, 0, 0x1f, 0x49, ...name("google-tv.local")]),
    ...record(instance, 16, txt),
  ]);
}

test("a Cast device is read from its mDNS answer, with its name and port", () => {
  const services = new Map();
  scan.readMdns(mdnsAnswer(), "192.168.1.63", services);
  const [device] = scan.castDevices(services.values());
  assert.deepEqual(device, { id: "cast:abc123", kind: "cast", name: "Bedroom TV", model: "Google TV Streamer", host: "192.168.1.63", port: 8009 });
});

test("the question asks for each service; rubbish in a packet breaks nothing", () => {
  const q = scan.mdnsQuery();
  assert.equal(q[5], scan.MDNS_SERVICES.length);
  assert.ok(Buffer.from(q).includes("_googlecast"));
  const services = new Map();
  scan.readMdns(Uint8Array.from([1, 2, 3]), "1.1.1.1", services);
  scan.readMdns(Uint8Array.from({ length: 40 }, (_, i) => (i * 37) & 255), "1.1.1.1", services);
  assert.deepEqual(scan.castDevices(services.values()), []);
});

test("an Echo or a Fire TV is told apart from what its Connect service says; others aren't listed from there", () => {
  const s = { service: "connect", instance: "x", host: "192.168.1.28", port: 4070, txt: {} };
  assert.equal(scan.pairOnlyDevice(s, { brandDisplayName: "Amazon", modelDisplayName: "Echo_Dot", deviceType: "SPEAKER" }).name, "Echo (28)");
  assert.equal(scan.pairOnlyDevice(s, { brandDisplayName: "Amazon", modelDisplayName: "Echo_Dot", remoteName: "Küche" }).name, "Küche");
  assert.equal(scan.pairOnlyDevice(s, { brandDisplayName: "Amazon", modelDisplayName: "AFTMM", deviceType: "TV" }).kind, "firetv");
  assert.equal(scan.pairOnlyDevice(s, { brandDisplayName: "Denon", modelDisplayName: "AVR", deviceType: "AVR" }), null);
  assert.equal(scan.pairOnlyDevice(s, null), null);
});

/* ------------------------------------------------------------ zones */

function fakeDriver(log = []) {
  const driver = {
    log,
    st: { state: "idle", position: 0, duration: 0, ended: false },
    failing: false,
    volume: 0.5,
    async load(song, position, play) {
      if (driver.failing) throw new Error("no way");
      log.push(`load ${song.id}@${position}${play ? "" : " paused"}`);
      driver.st = { state: play ? "playing" : "paused", position, duration: song.duration, ended: false };
    },
    async play() {
      log.push("play");
      driver.st.state = "playing";
    },
    async pause() {
      log.push("pause");
      driver.st.state = "paused";
    },
    async stop() {
      log.push("stop");
      driver.st.state = "stopped";
    },
    async seek(sec) {
      log.push(`seek ${sec}`);
      driver.st.position = sec;
    },
    async status() {
      if (driver.failing) throw new Error("no answer");
      return driver.st;
    },
    async setVolume(level) {
      driver.volume = level;
    },
    getVolume: async () => driver.volume,
    close() {
      log.push("close");
    },
  };
  return driver;
}

const songs = ["a", "b", "c"].map((id) => ({ id, title: id, artist: "", album: "", duration: 100 }));
const member = (id, driver) => ({ deviceId: id, name: id, driver, volume: 0.5 });

test("a zone plays its own queue and moves on when a song ends", async () => {
  const d = fakeDriver();
  const zone = new zones.Zone([member("denon", d)], () => undefined);
  await zone.play(songs, 0);
  assert.equal(zone.state.state, "loading", "playing once the device says so");
  await zone.tick();
  assert.equal(zone.state.state, "playing");
  assert.deepEqual(d.log, ["load a@0"]);

  d.st = { state: "stopped", position: 100, duration: 100, ended: true };
  await zone.tick();
  assert.equal(zone.state.index, 1);
  assert.equal(d.log.at(-1), "load b@0");

  await zone.next();
  await zone.previous();
  assert.equal(zone.state.index, 1);
  zone.state = { ...zone.state, position: 50 };
  await zone.previous();
  assert.equal(d.log.at(-1), "seek 0");
});

test("at the queue's end a zone stops, unless it repeats", async () => {
  const d = fakeDriver();
  const zone = new zones.Zone([member("denon", d)], () => undefined);
  await zone.play(songs, 2);
  d.st = { state: "stopped", position: 100, duration: 100, ended: true };
  await zone.tick();
  assert.equal(zone.state.state, "stopped");
  zone.setRepeat("all");
  await zone.toggle();
  d.st = { state: "stopped", position: 100, duration: 100, ended: true };
  await zone.tick();
  assert.equal(zone.state.index, 0);
});

test("a group: every member gets the song and the commands, the first one tells the time", async () => {
  const log1 = [];
  const log2 = [];
  const a = fakeDriver(log1);
  const b = fakeDriver(log2);
  const zone = new zones.Zone([member("denon", a)], () => undefined);
  await zone.play(songs, 1);
  a.st.position = 30;
  zone.state = { ...zone.state, position: 30 };
  await zone.join(member("tv", b));
  assert.equal(log2.at(-1), "load b@30");
  await zone.toggle();
  assert.equal(log1.at(-1), "pause");
  assert.equal(log2.at(-1), "pause");
  await zone.setVolume("tv", 0.1);
  assert.equal(b.volume, 0.1);
  assert.equal(a.volume, 0.5);

  assert.equal(await zone.leave("tv"), true);
  assert.equal(log2.at(-1), "close");
  assert.equal(await zone.leave("denon"), false);
});

test("a device that stops answering is let go; the next member takes over", async () => {
  const a = fakeDriver();
  const b = fakeDriver();
  const zone = new zones.Zone([member("denon", a), member("tv", b)], () => undefined);
  await zone.play(songs, 0);
  a.failing = true;
  for (let i = 0; i < 8; i++) await zone.tick();
  assert.deepEqual(zone.members.map((m) => m.deviceId), ["tv"]);
  assert.match(zone.state.error, /denon stopped answering/);
});

test("paused on the device itself: the zone follows, but only once a command of ours has settled", async () => {
  const d = fakeDriver();
  const zone = new zones.Zone([member("denon", d)], () => undefined);
  await zone.play(songs, 0);
  await zone.tick();
  assert.equal(zone.state.state, "playing");
  d.st.state = "paused";
  await zone.tick();
  assert.equal(zone.state.state, "playing");
  zone.lastCommandAt = 0;
  await zone.tick();
  assert.equal(zone.state.state, "paused");
});

test("the queue can change under the song that's on", async () => {
  const d = fakeDriver();
  const zone = new zones.Zone([member("denon", d)], () => undefined);
  await zone.play(songs, 1);
  zone.insert(2, [{ id: "x", title: "x", artist: "", album: "", duration: 10 }]);
  assert.deepEqual(zone.state.queue.map((s) => s.id), ["a", "b", "x", "c"]);
  zone.remove(0);
  assert.equal(zone.state.index, 0);
  assert.deepEqual(zone.state.queue.map((s) => s.id), ["b", "x", "c"]);
  zone.move(2, 1);
  assert.deepEqual(zone.state.queue.map((s) => s.id), ["b", "c", "x"]);
  zone.setUpcoming([]);
  assert.deepEqual(zone.state.queue.map((s) => s.id), ["b"]);
});

test("a song that won't load stands still instead of loading forever, and play tries again", async () => {
  const d = fakeDriver();
  const zone = new zones.Zone([member("denon", d)], () => undefined);
  d.failing = true;
  await zone.play(songs, 0);
  assert.equal(zone.state.state, "stopped");
  assert.match(zone.state.error, /no way/);
  d.failing = false;
  await zone.toggle();
  await zone.tick();
  assert.equal(zone.state.state, "playing");
  assert.equal(zone.state.error, null);
});

test("back on a zone that stands still starts the song again; a device can't seek in nothing", async () => {
  const log = [];
  const d = fakeDriver(log);
  const zone = new zones.Zone([member("denon", d)], () => undefined);
  await zone.play(songs, 0);
  d.st = { state: "stopped", position: 0, duration: 100, ended: true };
  await zone.tick(); // on to b
  await zone.previous(); // back to a
  await zone.jump(2);
  d.st = { state: "stopped", position: 0, duration: 100, ended: true };
  await zone.tick(); // the end of the queue
  assert.equal(zone.state.state, "stopped");
  log.length = 0;
  zone.state = { ...zone.state, index: 0, position: 0 };
  await zone.previous();
  assert.deepEqual(log, ["load a@0"]);
  assert.equal(zone.state.state, "loading");
});

test("a status that never comes back doesn't stop the zone for good", async () => {
  const d = fakeDriver();
  const zone = new zones.Zone([member("denon", d)], () => undefined);
  await zone.play(songs, 0);
  const realNow = Date.now;
  const realStatus = d.status;
  let asked = 0;
  d.status = () => {
    asked += 1;
    return new Promise(() => undefined);
  };
  void zone.tick();
  void zone.tick();
  assert.equal(asked, 1, "one at a time while it may still answer");
  try {
    Date.now = () => realNow() + 16_000;
    d.status = realStatus;
    d.st = { state: "playing", position: 7, duration: 100, ended: false };
    zone.lastCommandAt = 0;
    await zone.tick();
    assert.equal(zone.state.position, 7);
  } finally {
    Date.now = realNow;
  }
});

/* ------------------------------------------------------------ what a device says, on both apps */

test("the end of a song: stopped near its end or told so, once; stopped halfway isn't an end", async () => {
  const { EndWatch } = await loadFrom("../electron/device-player.ts");
  const report = (state, position, extra = {}) => ({ state, position, duration: 100, uri: "", ...extra });
  const watch = new EndWatch();
  watch.begin(0);
  assert.equal(watch.see(report("TRANSITIONING", 0), 100).state, "loading");
  assert.deepEqual(watch.see(report("PLAYING", 50), 100), { state: "playing", position: 50, duration: 100, ended: false });
  assert.equal(watch.see(report("STOPPED", 0), 100).ended, false, "stopped halfway");
  watch.see(report("PLAYING", 98), 100);
  const end = watch.see(report("STOPPED", 0), 100);
  assert.equal(end.ended, true);
  assert.equal(end.position, 100);
  assert.equal(watch.see(report("STOPPED", 0), 100).ended, false, "said once");
  watch.begin(0);
  assert.equal(watch.see(report("STOPPED", 0, { finished: true }), 100).ended, true, "a device that tells");
  watch.begin(90);
  watch.moved(10);
  assert.equal(watch.see(report("STOPPED", 0), 100).ended, false, "moved back before it stopped");
});

test("a device's model doesn't say its maker twice", async () => {
  const { parseDescription } = await loadFrom("../electron/upnp-control.ts");
  const xml = (maker, model) =>
    `<root><device><friendlyName>Player</friendlyName><manufacturer>${maker}</manufacturer><modelName>${model}</modelName><UDN>uuid:1</UDN>` +
    `<serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/c</controlURL></service></serviceList></device></root>`;
  const at = "http://192.168.1.5:1234/d.xml";
  assert.equal(parseDescription(xml("Denon", "Denon AVR-X1700H"), at).model, "Denon AVR-X1700H");
  assert.equal(parseDescription(xml("Sonos", "Play:1"), at).model, "Sonos Play:1");
});
