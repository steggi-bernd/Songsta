// The computer's side of one stream between devices (src/lib/homeSync.ts) with the shared conversation
// (src/lib/syncEngine.ts) and the real queue, against a sync service in memory and another device played
// by the test: following it, steering it, taking the music over and handing it back. The computer can have
// a song as its own local file where the phone has the server's copy.
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const stub = (contents) => ({ contents, resolveDir: lib, loader: "ts" });
const out = await build({
  stdin: {
    contents: `export { watchHomeSync, otherDevices, useHomeSync } from "./homeSync"; export { usePlayer } from "../stores/player"; export { useSettings } from "../stores/settings";`,
    resolveDir: lib,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onLoad({ filter: /[\\/]lib[\\/]persist\.ts$/ }, () =>
          stub(`const none = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }; export const storage = none; export const lazyJSONStorage = () => none;`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]catalog\.ts$/ }, () =>
          stub(`
            const state = () => globalThis.__catalog;
            export const useCatalog = { getState: state, subscribe: () => () => undefined };
            export const songKey = (id) => globalThis.__catalog.versions.get(id) ?? id;
            export const versionsOf = () => [];`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]library\.ts$/ }, () =>
          stub(`
            const state = { playlists: [], folders: [], liked: [], deletionSync: {} };
            export const useLibrary = { getState: () => state, setState: () => undefined, subscribe: () => () => undefined, persist: { hasHydrated: () => true, onFinishHydration: () => () => undefined } };`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]muted\.ts$/ }, () =>
          stub(`
            export const isMuted = () => false;
            export const useMuted = { getState: () => ({ at: 0, tracks: [], apply() {} }), subscribe: () => () => undefined };`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]ui\.ts$/ }, () =>
          stub(`export const useUI = { getState: () => ({ toast: (message, kind) => (globalThis.__toasts ??= []).push(message) }) };`)
        );
        b.onLoad({ filter: /[\\/]lib[\\/]audio\.ts$/ }, () =>
          stub(`
            import { usePlayer } from "../stores/player";
            let follower = null;
            usePlayer.subscribe((s, p) => follower?.(s, p));
            export function handOverToCast(f) { follower = f; globalThis.__audio.push("handOver"); }
            export function takeBackFromCast() { follower = null; globalThis.__audio.push("takeBack"); }
            export function followClock(at, running) { globalThis.__clock = { at, running }; }`)
        );
        b.onLoad({ filter: /[\\/]lib[\\/]cast\.ts$/ }, () => stub(`export const useCast = { getState: () => ({ active: null }) };`));
        b.onLoad({ filter: /[\\/]lib[\\/]serverSync\.ts$/ }, () => stub(`export const syncFavorites = async () => undefined;`));
      },
    },
  ],
});

/* ------------------------------------------------------------ the service, in memory */

const service = {
  docs: {},
  revs: { playlists: 0, position: 0, queue: 0, likes: 0, muted: 0 },
  devices: {},
  inbox: {},
  seq: 0,
  devicesRev: 0,
  waiting: [],
  sent: [],
  changed() {
    this.seq += 1;
    for (const wake of this.waiting.splice(0)) wake();
  },
  summary(device) {
    return { seq: this.seq, revs: { ...this.revs, devices: this.devicesRev }, inbox: (this.inbox[device] ?? []).length };
  },
  async request(method, path, body) {
    if (this.down) throw new TypeError("Network request failed");
    const url = new URL(path, "http://service");
    const doc = /^\/v1\/docs\/(\w+)$/.exec(url.pathname)?.[1];
    const deviceMatch = /^\/v1\/devices(?:\/([^/]+)(\/commands)?)?$/.exec(url.pathname);
    if (url.pathname === "/v1/changes") {
      const device = url.searchParams.get("device");
      if (this.seq === Number(url.searchParams.get("since")) && !(this.inbox[device] ?? []).length) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 300);
          this.waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return { status: 200, body: this.summary(device) };
    }
    if (doc) {
      if (method === "GET") return { status: 200, body: { rev: this.revs[doc] ?? 0, doc: this.docs[doc] ?? null } };
      this.docs[doc] = structuredClone(body.doc);
      this.revs[doc] = (this.revs[doc] ?? 0) + 1;
      if (doc === "position") this.notesFrom.push(body.doc.device.id);
      this.changed();
      return { status: 200, body: { rev: this.revs[doc] } };
    }
    if (deviceMatch && !deviceMatch[1]) return { status: 200, body: { now: Date.now(), devices: Object.entries(this.devices).map(([id, d]) => ({ id, updatedAt: d.at, doc: d.doc })) } };
    if (deviceMatch && deviceMatch[2]) {
      const id = decodeURIComponent(deviceMatch[1]);
      if (method === "GET") {
        const commands = this.inbox[id] ?? [];
        delete this.inbox[id];
        return { status: 200, body: { commands } };
      }
      (this.inbox[id] ??= []).push(body.command);
      this.sent.push({ ...body.command, target: id });
      this.changed();
      return { status: 200, body: { ok: true } };
    }
    if (deviceMatch) {
      this.devices[decodeURIComponent(deviceMatch[1])] = { at: Date.now(), doc: structuredClone(body.doc) };
      this.devicesRev += 1;
      this.changed();
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: null };
  },
  notesFrom: [],
};

/* ------------------------------------------------------------ this computer's library: local files, the same songs on the server */

const song = (id, title) => ({ id, title, artist: "Band", album: "LP", duration: 200, thumb: "" });
const NAMES = ["a", "b", "c", "d"];
const local = Object.fromEntries(NAMES.map((n) => [n, song(`local:${n}`, n.toUpperCase())]));
const server = Object.fromEntries(NAMES.map((n) => [n, song(`jf:${n}`, n.toUpperCase())]));
const LIST = NAMES.map((n) => local[n]);
const WIRE = NAMES.map((n) => ({ id: `jf:${n}`, title: n.toUpperCase(), artist: "Band", album: "LP", duration: 200 }));
const wire = (n) => WIRE[NAMES.indexOf(n)];

globalThis.__catalog = {
  loaded: true,
  byId: new Map([...Object.values(local), ...Object.values(server)].map((t) => [t.id, t])),
  // Every copy answers with its song's first copy.
  versions: new Map(NAMES.flatMap((n) => [[`local:${n}`, `local:${n}`], [`jf:${n}`, `local:${n}`]])),
};
globalThis.__audio = [];
globalThis.localStorage = undefined;
globalThis.window = {
  setInterval: (...a) => setInterval(...a),
  clearInterval: (...a) => clearInterval(...a),
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
  addEventListener() {},
  removeEventListener() {},
  bytune: {
    homeSyncInfo: async () => ({ ready: true, deviceId: "pc", deviceName: "PC", address: "http://service", customAddress: "", needsUser: false }),
    homeSyncRequest: (method, path, body) => service.request(method, path, body),
  },
};

const { watchHomeSync, otherDevices, useHomeSync, usePlayer, useSettings } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const stopWatching = watchHomeSync();
after(() => stopWatching());

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
  assert.ok(check(), what);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const player = () => usePlayer.getState();
const now = () => player().queue[player().index]?.id;

/* ------------------------------------------------------------ the phone, played by the test */

const phone = {
  say(n, more = {}) {
    service.devices.phone = { at: Date.now(), doc: { name: "Phone", kind: "phone", playing: true, positionMs: 40000, durationMs: 200000, track: wire(n), queueId: "q-phone", shuffle: false, repeat: "off", volume: 0.5, ...more } };
    service.devicesRev += 1;
    service.changed();
  },
  silent() {
    service.devices.phone = { at: Date.now(), doc: { name: "Phone", kind: "phone", playing: false, positionMs: 0, durationMs: 0, track: null } };
    service.devicesRev += 1;
    service.changed();
  },
  note(n, more = {}, tracks = WIRE) {
    service.docs.queue = { id: more.queueId ?? "q-phone", from: 0, tracks, ...(more.doc ?? {}) };
    service.revs.queue += 1;
    const { doc, ...rest } = more;
    service.docs.position = { device: { id: "phone", name: "Phone" }, at: Date.now(), playing: true, positionMs: 40000, track: wire(n), queueId: "q-phone", place: NAMES.indexOf(n), ...rest };
    service.revs.position += 1;
    service.changed();
  },
  tell(command) {
    (service.inbox.pc ??= []).push(command);
    service.changed();
  },
  heard: (action) => service.sent.filter((c) => c.target === "phone" && (!action || c.action === action)),
};

/** Back to nobody following anybody, this computer playing the album from its own files. */
async function playingHere(at = 1) {
  if (useHomeSync.getState().followed) phone.tell({ action: "takeOver" });
  await until(() => !useHomeSync.getState().followed, "not following");
  phone.silent();
  await wait(30);
  usePlayer.setState({ queue: LIST, index: at, playing: true, position: 40, duration: 200, shuffle: false, repeat: "off", unshuffled: null });
  await wait(50);
  service.sent.length = 0;
  service.notesFrom.length = 0;
  globalThis.__toasts = [];
  globalThis.__audio.length = 0;
}

/** The phone took the music: it told this computer to stop, and it says it plays. */
async function followingPhone(n = "b", more = {}, queueId = "q-phone") {
  await playingHere(NAMES.indexOf(n));
  phone.tell({ action: "pause" });
  phone.tell({ action: "yield", to: "phone" });
  await until(() => !player().playing, "paused here");
  phone.note(n, { queueId });
  phone.say(n, { queueId, ...more });
  await until(() => useHomeSync.getState().followed?.id === "phone", "following the phone");
  await wait(40);
  service.sent.length = 0;
  service.notesFrom.length = 0;
  globalThis.__audio.length = 0;
}

await until(() => useHomeSync.getState().status === "connected", "connected to the service");

beforeEach(() => {
  useSettings.setState({ autoplay: false, skipEndsRepeatOne: true });
});

/* ------------------------------------------------------------ the tests */

test("the phone took the music: this computer stops, shows it, and says so right away", async () => {
  await playingHere();
  phone.tell({ action: "pause" });
  phone.tell({ action: "yield", to: "phone" });
  await until(() => !player().playing, "paused here");
  phone.note("b");
  phone.say("b");
  await until(() => useHomeSync.getState().followed?.id === "phone", "following");
  assert.equal(player().playing, true, "it shows what plays there");
  assert.ok(globalThis.__audio.includes("handOver"), "its own decks are silent");
  await until(() => service.devices.pc?.doc.track === null, "the others hear it doesn't play any more");
});

test("the note the phone just wrote isn't overwritten by this computer's pause", async () => {
  await playingHere();
  phone.tell({ action: "pause" });
  phone.tell({ action: "yield", to: "phone" });
  await until(() => !player().playing, "paused here");
  phone.note("b");
  await wait(1100); // longer than a change here waits before it goes out
  assert.deepEqual(service.notesFrom.filter((d) => d === "pc"), []);
  assert.equal(service.docs.position.device.id, "phone");

  // Nothing came of it there, and somebody starts it here again: it's this computer's word again.
  player().setPlaying(true);
  await until(() => service.notesFrom.includes("pc"), "it says where it stands again");
  player().setPlaying(false);
});

test("the same song as another copy stays the same song: the list here isn't thrown away", async () => {
  await playingHere();
  await until(() => service.docs.position?.device.id === "pc" && service.docs.position.track.title === "B", "this computer's note");
  const { queueId } = service.docs.position;
  phone.tell({ action: "pause" });
  phone.tell({ action: "yield", to: "phone" });
  await until(() => !player().playing, "paused here");
  // The phone took over this very list, knowing its songs as the server's copies.
  phone.note("b", { queueId });
  phone.say("b", { queueId });
  await until(() => useHomeSync.getState().followed?.id === "phone", "following");
  await wait(60);
  assert.deepEqual(player().queue.map((t) => t.id), LIST.map((t) => t.id), "still this computer's list");
  assert.equal(now(), "local:b");
  phone.say("c", { queueId, positionMs: 300 });
  await until(() => now() === "local:c", "the next one of it");
  assert.equal(player().queue.length, 4);
});

test("the same song in another list: the list comes along", async () => {
  await playingHere();
  phone.tell({ action: "pause" });
  phone.tell({ action: "yield", to: "phone" });
  await until(() => !player().playing, "paused here");
  const other = [wire("b"), wire("d")];
  phone.note("b", { queueId: "q-other", place: 0 }, other);
  phone.say("b", { queueId: "q-other" });
  await until(() => player().queue.length === 2, "the phone's list");
  assert.deepEqual(player().queue.map((t) => t.title), ["B", "D"]);
});

test("a yield that comes while already following doesn't stop the very music it's about", async () => {
  await followingPhone();
  phone.tell({ action: "yield", to: "phone" });
  await wait(120);
  assert.deepEqual(phone.heard("pause"), [], "no pause sent to the phone");
  assert.equal(player().playing, true);
  assert.equal(useHomeSync.getState().followed?.id, "phone");
});

test("while following, what was meant for this computer before the music moved on is dropped; asked to play here, it does", async () => {
  await followingPhone();
  const before = now();
  for (const command of [{ action: "pause" }, { action: "play" }, { action: "seek", positionMs: 5000 }, { action: "next" }, { action: "previous" }, { action: "volume", level: 0.1 }, { action: "shuffle", on: true }, { action: "repeat", mode: "one" }, { action: "jump", trackId: "jf:d", by: 2 }]) phone.tell(command);
  await wait(150);
  assert.equal(useHomeSync.getState().followed?.id, "phone", "still following");
  assert.equal(now(), before);
  assert.equal(player().shuffle, false);
  assert.equal(player().repeat, "off");
  assert.notEqual(player().volume, 0.1);

  phone.silent();
  phone.note("c", { positionMs: 77000 });
  phone.tell({ action: "takeOver" });
  await until(() => !useHomeSync.getState().followed, "takes it");
  await until(() => player().playing, "plays");
  assert.equal(player().queue[player().index].title, "C", "the song that was handed over");
  assert.equal(player().position, 77, "from the place it was handed over at");
  assert.deepEqual(globalThis.__audio.filter((a) => a === "takeBack").length, 1, "its decks take over once");
});

test("handed back with shuffle and repeat on: it goes on the same way, and shuffle off finds the list's own order", async () => {
  await playingHere();
  phone.silent();
  const shuffledList = [wire("c"), wire("a"), wire("d"), wire("b")];
  phone.note("c", { queueId: "q-shuffled", place: 0, shuffle: true, repeat: "all", doc: { unshuffled: WIRE } }, shuffledList);
  usePlayer.setState({ playing: false });
  phone.tell({ action: "takeOver" });
  await until(() => player().playing && player().queue.length === 4 && player().queue[0].title === "C", "takes the shuffled list");
  assert.equal(player().shuffle, true);
  assert.equal(player().repeat, "all");
  player().toggleShuffle();
  assert.deepEqual(player().queue.map((t) => t.title).slice(0, 2), ["C", "D"], "after the song on, the list's own order");
});

test("this computer's note says how it goes on, with the list's own order along", async () => {
  await playingHere();
  player().toggleShuffle();
  usePlayer.setState({ repeat: "one" });
  await until(() => service.docs.position?.device.id === "pc" && service.docs.position.shuffle === true && service.docs.position.repeat === "one", "the note says so");
  assert.deepEqual(service.docs.queue.unshuffled.map((t) => t.title), ["A", "B", "C", "D"]);
});

test("sent a song this computer doesn't have: the next one it does, from its start, and it says so; none at all, nothing starts", async () => {
  await playingHere();
  usePlayer.setState({ playing: false });
  const elsewhere = { id: "phone-only", title: "Elsewhere", artist: "Nobody", duration: 10 };
  service.docs.queue = { id: "q-away", from: 0, tracks: [elsewhere, wire("c"), wire("d")] };
  service.docs.position = { device: { id: "phone", name: "Phone" }, at: Date.now(), playing: true, positionMs: 5000, track: elsewhere, queueId: "q-away", place: 0 };
  phone.tell({ action: "takeOver" });
  await until(() => player().playing, "plays");
  assert.equal(player().queue[player().index].title, "C");
  assert.equal(player().position, 0);
  assert.ok(globalThis.__toasts.some((t) => /Elsewhere.*next song/.test(t)), "and it says so");

  await playingHere();
  usePlayer.setState({ playing: false });
  await wait(30);
  service.docs.queue = { id: "q-gone", from: 0, tracks: [elsewhere] };
  service.docs.position = { device: { id: "phone", name: "Phone" }, at: Date.now() + 5, playing: true, positionMs: 5000, track: elsewhere, queueId: "q-gone", place: 0 };
  phone.tell({ action: "takeOver" });
  await until(() => globalThis.__toasts.some((t) => /Elsewhere.*isn't on this computer/.test(t)), "it says so");
  await wait(60);
  assert.equal(player().playing, false, "what it had before isn't what was asked for");
});

test("told to go to a song by the phone's copy of it: the song, in this computer's own list", async () => {
  await playingHere(0);
  phone.tell({ action: "jump", trackId: "jf:c", by: 2, track: wire("c") });
  await until(() => now() === "local:c", "it went there");
  phone.tell({ action: "jump", trackId: "jf:d", track: wire("d") });
  await until(() => now() === "local:d", "without a place too");
  // Not known here at all: one step along the list still means the next one.
  usePlayer.setState({ index: 1 });
  phone.tell({ action: "jump", trackId: "phone-only", by: 1, track: { id: "phone-only", title: "Elsewhere", artist: "Nobody", duration: 10 } });
  await until(() => now() === "local:c", "one step along");
});

test("a skip here while following says which song it means, in words the other device understands", async () => {
  await followingPhone("b");
  player().next(true);
  await until(() => phone.heard("jump").length === 1, "the phone hears");
  const [jump] = phone.heard("jump");
  assert.equal(jump.by, 1);
  assert.equal(jump.track.title, "C", "by what it is, not only this computer's name for it");
  const title = () => player().queue[player().index].title;
  assert.equal(title(), "C", "shows at once");
  // What it says from before it got there doesn't move the screen back.
  phone.say("b", { positionMs: 41000 });
  await wait(60);
  assert.equal(title(), "C");
  phone.say("c", { positionMs: 300 });
  await wait(60);
  assert.equal(title(), "C");
});

test("repeat-one ending with a skip is up to the device that plays: this computer shows what it says", async () => {
  await followingPhone("b", { repeat: "one" });
  assert.equal(player().repeat, "one");
  player().next(true);
  await wait(30);
  assert.equal(player().repeat, "one", "not on its own");
  phone.say("c", { positionMs: 300, repeat: "all" });
  await until(() => player().repeat === "all", "as the phone says");
});

test("the phone's reports: a small difference is no move, a real one is, and the words on screen go by this clock", async () => {
  await followingPhone("b", { positionMs: 40000 });
  await until(() => Math.abs(player().position - 40) < 2, "where the phone is");
  const before = player().position;
  phone.say("b", { positionMs: before * 1000 + 800 });
  await wait(60);
  assert.ok(Math.abs(player().position - before) < 0.7, `no jump for a small difference (${player().position} after ${before})`);
  phone.say("b", { positionMs: 90000 });
  await until(() => player().position >= 90, "somebody moved it there");
  assert.ok(globalThis.__clock.at >= 90 && globalThis.__clock.running, "the clock goes with it");
  // A song only just starting there doesn't know its length yet.
  phone.say("c", { durationMs: 0, positionMs: 0 });
  await until(() => player().queue[player().index]?.title === "C", "on to the next");
  assert.equal(player().duration, 200);
});

test("a clock behind the other device's doesn't make what happens here old", async () => {
  await followingPhone("b");
  const ahead = Date.now() + 90_000;
  phone.note("b", { at: ahead, queueId: "q-ahead" });
  phone.say("b", { queueId: "q-ahead" });
  await until(() => service.docs.position.at === ahead && player().queue[0].id === "jf:a", "its list, under its clock");
  await wait(80);
  otherDevices.takeHere();
  await until(() => service.docs.position?.device.id === "pc", "this computer's word goes out all the same");
  assert.ok(service.docs.position.at > ahead, "and it's newer than what it took over");
});

test("the music taken here from the phone: pause and step aside for it, the place stays, and the music starts once", async () => {
  await followingPhone("b", { positionMs: 60000 });
  await until(() => player().position >= 60, "where the phone is");
  otherDevices.takeHere();
  await until(() => phone.heard("yield").length > 0, `tells the phone: ${JSON.stringify(service.sent)}`);
  assert.equal(phone.heard("yield").length, 1);
  assert.equal(phone.heard("pause").length, 1);
  assert.equal(player().playing, true);
  assert.ok(player().position >= 60, "from the place it had reached");
  assert.equal(globalThis.__audio.filter((a) => a === "takeBack").length, 1);
  phone.silent();
  await wait(30);
});

test("waiting for a speaker: taken from the phone without playing here", async () => {
  await followingPhone("b");
  otherDevices.takeHere(false);
  await until(() => phone.heard("yield").length > 0, `tells the phone: ${JSON.stringify(service.sent)}`);
  assert.equal(player().playing, false);
  assert.equal(useHomeSync.getState().followed, null);
  phone.silent();
  await wait(30);
});

test("started here with the service away: the others hear of it when it's back", async () => {
  await playingHere(1);
  usePlayer.setState({ playing: false });
  await wait(40);
  phone.say("c");
  await wait(60);
  assert.equal(useHomeSync.getState().followed, null, "just active here: it doesn't follow yet");
  service.sent.length = 0;

  service.down = true;
  await until(() => useHomeSync.getState().status === "unreachable", "the service is gone", 2000);
  usePlayer.setState({ playing: true });
  await wait(60);
  assert.equal(phone.heard("yield").length, 0, "nobody can hear of it now");

  service.down = false;
  await until(() => phone.heard("yield").length === 1, "back, it tells the phone: one stream", 8000);
  assert.equal(player().playing, true, "and plays on");
  phone.silent();
  await wait(30);
});
