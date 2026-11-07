// Casting, the renderer half (src/lib/cast.ts): the queue, play/pause, seeking and the
// volume follow the network player; the player's reports come back into the store; a
// player that stops answering hands the music back. The bridge is a fake, the audio engine
// a recorder, the player store the real one.
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const stub = (contents) => ({ contents, resolveDir: lib, loader: "ts" });
const out = await build({
  // cast.ts and the player store it steers, from one module graph.
  stdin: { contents: `export * from "./cast"; export { usePlayer } from "../stores/player";`, resolveDir: lib, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  // React comes along (zustand's hooks import it): a data: module can't resolve packages.
  plugins: [
    {
      name: "cast-follow-stubs",
      setup(b) {
        b.onLoad({ filter: /[\\/]lib[\\/]audio\.ts$/ }, () =>
          stub(`import { usePlayer } from "../stores/player";
            let follower = null;
            // The engine hands every store change to the follower while a player has the music.
            usePlayer.subscribe((s, p) => { if (follower) follower(s, p); });
            export function handOverToCast(f) { follower = f; globalThis.__audio.push(["handOver"]); }
            export function takeBackFromCast() { follower = null; globalThis.__audio.push(["takeBack"]); }
            export function castHeard(id, pos, playing) { globalThis.__audio.push(["heard", id, pos, playing]); }
            export function castTrackEnded() { globalThis.__audio.push(["ended"]); usePlayer.getState().next(false); }`)
        );
        b.onLoad({ filter: /[\\/]lib[\\/]librarySource\.ts$/ }, () =>
          stub(`export const playableVersions = (t) => (globalThis.__versions?.(t) ?? [t]);`)
        );
        b.onLoad({ filter: /[\\/]lib[\\/]bridge\.ts$/ }, () => stub(`export const requireBridge = () => globalThis.__bridge;`));
        b.onLoad({ filter: /[\\/]lib[\\/]persist\.ts$/ }, () =>
          stub(`export const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }; export const lazyJSONStorage = () => ({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined });`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]ui\.ts$/ }, () =>
          stub(`export const useUI = { getState: () => ({ toast: (m, k) => globalThis.__toasts.push([m, k ?? "info"]) }) };`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]catalog\.ts$/ }, () => stub(`export const songKey = (id) => id;`));
      },
    },
  ],
});
const cast = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const { usePlayer } = cast;

let bridgeLog, statusListener, failIds;
let now = 1_000_000;
const realNow = Date.now;
Date.now = () => now;
after(() => {
  Date.now = realNow;
});
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const song = (id, extra = {}) => ({ id, title: id.toUpperCase(), artist: "Band", album: "LP", duration: 200, thumb: "", ...extra });
const TV = { id: "uuid:tv", name: "TV", model: "Acme" };
const status = (over) => ({ device: { id: TV.id, name: "TV" }, state: "playing", trackId: null, position: 0, duration: 200, fetched: true, volume: 0.3, muted: false, ...over });
const report = (over) => statusListener(status(over));

globalThis.__bridge = {
  castFind: async () => [TV],
  castStart: async (id) => status({ device: { id, name: "TV" }, state: "idle" }),
  castLoad: async (s, position, play) => {
    bridgeLog.push(["load", s.id, position, play]);
    if (failIds.has(s.id)) throw new Error("Error invoking remote method 'cast:load': Error: That file can't be reached right now");
  },
  castControl: async (action, value) => {
    bridgeLog.push([action, value]);
  },
  castStop: async () => {
    bridgeLog.push(["stop"]);
  },
  onCastStatus: (listener) => {
    statusListener = listener;
    return () => {
      statusListener = null;
    };
  },
};

beforeEach(async () => {
  globalThis.__audio = [];
  globalThis.__toasts = [];
  await cast.stopCasting();
  globalThis.__audio = [];
  globalThis.__versions = null;
  bridgeLog = [];
  failIds = new Set();
  // Time only runs forward (the module keeps its last command's time between tests).
  now += 100_000;
  usePlayer.setState({ queue: [], index: 0, playing: false, position: 0, duration: 0, repeat: "off", shuffle: false, volume: 0.8, muted: false });
});

async function connected(queue = [song("local:a"), song("local:b"), song("local:c")], { position = 0, playing = true } = {}) {
  usePlayer.getState().playQueue(queue, 0);
  usePlayer.setState({ position, playing, duration: 200 });
  await cast.castTo(TV);
  now += 10_000; // past the settling time of the load
  report({ trackId: queue[0].id, state: playing ? "playing" : "paused", position }); // and started
  bridgeLog = [];
  globalThis.__audio = [];
}

test("connecting hands the music over: the song where it is, playing or not", async () => {
  usePlayer.getState().playQueue([song("local:a"), song("local:b")], 0);
  usePlayer.setState({ position: 42, playing: false });
  await cast.castTo(TV);
  assert.deepEqual(globalThis.__audio[0], ["handOver"]);
  assert.deepEqual(bridgeLog, [["load", "local:a", 42, false]]);
  assert.deepEqual(cast.useCast.getState().active, { id: TV.id, name: "TV" });
  assert.equal(cast.useCast.getState().volume, 0.3);
  assert.deepEqual(globalThis.__toasts.at(-1), ["Playing on TV", "info"]);
  assert.equal(usePlayer.getState().buffering, false);
});

test("the queue steers the player: pause, play, seek, the next song", async () => {
  await connected();
  usePlayer.getState().toggle();
  usePlayer.getState().toggle();
  usePlayer.getState().seek(120);
  usePlayer.getState().next(true);
  await flush();
  assert.deepEqual(bridgeLog, [["pause", 0], ["play", 0], ["seek", 120], ["load", "local:b", 0, true]]);
  // Its own position reports change nothing on the player.
  bridgeLog = [];
  now += 10_000;
  report({ trackId: "local:b", position: 3 });
  report({ trackId: "local:b", position: 4 });
  assert.deepEqual(bridgeLog, []);
  assert.equal(usePlayer.getState().position, 4);
  assert.deepEqual(globalThis.__audio.filter((a) => a[0] === "heard").at(-1), ["heard", "local:b", 4, true]);
});

test("the player's reports: only about the song it was given", async () => {
  await connected();
  report({ trackId: "local:zzz", position: 99 });
  assert.notEqual(usePlayer.getState().position, 99);
  report({ trackId: "local:a", state: "loading", position: 77 });
  assert.equal(usePlayer.getState().buffering, true);
  assert.notEqual(usePlayer.getState().position, 77);
  report({ trackId: "local:a", position: 5 });
  assert.equal(usePlayer.getState().buffering, false);
  assert.equal(usePlayer.getState().position, 5);
  // A report from another session (a player switched away from) is not this one's.
  statusListener(status({ device: { id: "uuid:other", name: "Other" }, trackId: "local:a", position: 66 }));
  assert.equal(usePlayer.getState().position, 5);
});

test("a report sent off before a seek doesn't pull the position back", async () => {
  await connected();
  usePlayer.getState().seek(150);
  report({ trackId: "local:a", position: 20 });
  assert.equal(usePlayer.getState().position, 150);
  now += 2000;
  report({ trackId: "local:a", position: 151 });
  assert.equal(usePlayer.getState().position, 151);
});

test("paused or resumed on the player itself: followed here, not echoed back", async () => {
  await connected();
  report({ trackId: "local:a", state: "paused", position: 30 });
  assert.equal(usePlayer.getState().playing, false);
  report({ trackId: "local:a", state: "playing", position: 31 });
  assert.equal(usePlayer.getState().playing, true);
  report({ trackId: "local:a", state: "stopped", position: 0 });
  assert.equal(usePlayer.getState().playing, false);
  await flush();
  assert.deepEqual(bridgeLog, []);
  // Play after a stop on the player: the song goes back on, where the queue is.
  usePlayer.setState({ position: 30 });
  usePlayer.getState().toggle();
  await flush();
  assert.deepEqual(bridgeLog, [["load", "local:a", 30, true]]);
});

test("right after a command, the player's older state isn't adopted", async () => {
  await connected();
  usePlayer.getState().toggle(); // pause
  report({ trackId: "local:a", state: "playing", position: 10 }); // sent before the pause arrived
  assert.equal(usePlayer.getState().playing, false);
  now += 5000;
  report({ trackId: "local:a", state: "paused", position: 10 });
  assert.equal(usePlayer.getState().playing, false);
});

test("the end of a song moves the queue on; repeat-one plays it again on the player", async () => {
  await connected();
  report({ trackId: "local:a", state: "stopped", position: 200, ended: true });
  await flush();
  assert.ok(globalThis.__audio.some((a) => a[0] === "ended"));
  assert.equal(usePlayer.getState().index, 1);
  assert.deepEqual(bridgeLog, [["load", "local:b", 0, true]]);
  bridgeLog = [];
  now += 10_000;
  usePlayer.setState({ repeat: "one" });
  report({ trackId: "local:b", state: "stopped", position: 200, ended: true });
  await flush();
  assert.equal(usePlayer.getState().index, 1);
  assert.deepEqual(bridgeLog, [["load", "local:b", 0, true]]);
});

test("an album played again from its first song: from the top on the player too", async () => {
  const album = [song("local:a"), song("local:b")];
  await connected(album);
  report({ trackId: "local:a", position: 50 });
  usePlayer.getState().playQueue([...album], 0);
  await flush();
  assert.deepEqual(bridgeLog, [["seek", 0]]);
});

test("moving to a player that takes its time: no word of playing until it does", async () => {
  usePlayer.getState().playQueue([song("local:a"), song("local:b")], 0);
  await cast.castTo(TV);
  assert.equal(cast.useCast.getState().connecting, TV.id, "the wheel goes on");
  assert.equal(usePlayer.getState().buffering, true);
  assert.deepEqual(globalThis.__toasts, []);
  // Its stops on the way to starting are not a listener's stop.
  now += 6000;
  report({ trackId: "local:a", state: "loading" });
  report({ trackId: "local:a", state: "stopped" });
  assert.equal(usePlayer.getState().playing, true);
  assert.deepEqual(globalThis.__toasts, []);
  report({ trackId: "local:a", state: "playing", position: 1 });
  assert.deepEqual(globalThis.__toasts, [["Playing on TV", "info"]]);
  assert.equal(cast.useCast.getState().connecting, null);
  assert.equal(usePlayer.getState().buffering, false);
  report({ trackId: "local:a", state: "playing", position: 2 });
  assert.equal(globalThis.__toasts.length, 1, "once");
});

test("a song handed over that never starts: why, as far as it can be told, and the music comes back here, paused", async () => {
  usePlayer.getState().playQueue([song("local:a"), song("local:b")], 0);
  await cast.castTo(TV);
  now += 60_000;
  report({ trackId: "local:a", state: "stopped", fetched: false, through: true, members: [{ id: TV.id, name: "TV", volume: 0.3, muted: false }], notStarted: { id: TV.id, name: "TV" } });
  await flush();
  assert.equal(usePlayer.getState().playing, false);
  assert.equal(cast.useCast.getState().active, null);
  assert.equal(cast.useCast.getState().connecting, null);
  assert.deepEqual(globalThis.__toasts.at(-1), ["TV didn't start. It may be off, or a firewall keeps it from this computer: let Songsta through for private networks. The music is back here, paused", "error"]);
  assert.ok(globalThis.__audio.some((a) => a[0] === "takeBack"));

  // Handed its song straight from the server: no firewall of this computer's in the way.
  usePlayer.getState().setPlaying(true);
  await cast.castTo(TV);
  report({ trackId: "local:a", state: "stopped", fetched: false, through: false, members: [{ id: TV.id, name: "TV", volume: 0.3, muted: false }], notStarted: { id: TV.id, name: "TV" } });
  await flush();
  assert.deepEqual(globalThis.__toasts.at(-1), ["TV didn't start. It may be off. The music is back here, paused", "error"]);

  // Fetched but not started: most likely the file type.
  usePlayer.getState().setPlaying(true);
  await cast.castTo(TV);
  report({ trackId: "local:a", state: "stopped", fetched: true, members: [{ id: TV.id, name: "TV", volume: 0.3, muted: false }], notStarted: { id: TV.id, name: "TV" } });
  await flush();
  assert.match(globalThis.__toasts.at(-1)[0], /TV fetched "LOCAL:A" but didn't start it/);
  assert.equal(cast.useCast.getState().active, null);
});

test("one of a group that never starts just goes; the first one leaving hands the group to the next", async () => {
  const HALL = { id: "uuid:hall", name: "Hall", volume: 0.5, muted: false };
  const tv = { id: TV.id, name: "TV", volume: 0.3, muted: false };
  await connected();
  report({ trackId: "local:a", members: [tv, HALL], position: 3 });
  report({ trackId: "local:a", members: [tv], position: 4, notStarted: { id: HALL.id, name: "Hall" } });
  await flush();
  assert.deepEqual(globalThis.__toasts.at(-1), ["Hall didn't start. Is it switched on?", "error"]);
  assert.deepEqual(cast.useCast.getState().active, { id: TV.id, name: "TV" });

  report({ trackId: "local:a", members: [tv, HALL], position: 5 });
  report({ device: { id: HALL.id, name: "Hall" }, trackId: "local:a", members: [HALL], position: 6 });
  assert.deepEqual(cast.useCast.getState().active, { id: HALL.id, name: "Hall" }, "the song's end and the rest are heard from that one now");
  assert.equal(usePlayer.getState().position, 6);
  // Anybody else is from before.
  report({ device: { id: "uuid:old", name: "Old" }, trackId: "local:a", position: 90 });
  assert.equal(usePlayer.getState().position, 6);
});

test("the end of the queue: nothing is sent to the stopped player", async () => {
  await connected([song("local:a")]);
  report({ trackId: "local:a", state: "stopped", position: 200, ended: true });
  await flush();
  assert.equal(usePlayer.getState().playing, false);
  assert.deepEqual(bridgeLog, []);
});

test("a copy that can't play gives way to the next; none at all pauses with a message", async () => {
  const copies = { "local:a": [song("local:a-file"), song("jf:aaaa")] };
  globalThis.__versions = (t) => copies[t.id] ?? [t];
  failIds = new Set(["local:a-file"]);
  usePlayer.getState().playQueue([song("local:a"), song("yt:x")], 0);
  await cast.castTo(TV);
  assert.deepEqual(bridgeLog, [["load", "local:a-file", 0, true], ["load", "jf:aaaa", 0, true]]);
  assert.equal(usePlayer.getState().sources["local:a"].id, "jf:aaaa");
  // Reports name the copy that plays.
  now += 10_000;
  report({ trackId: "jf:aaaa", position: 8 });
  assert.equal(usePlayer.getState().position, 8);
  // A song with no copy the player can be handed.
  bridgeLog = [];
  usePlayer.getState().next(true);
  await flush();
  assert.deepEqual(bridgeLog, []);
  assert.equal(usePlayer.getState().playing, false);
  assert.match(globalThis.__toasts.at(-1)[0], /"YT:X" can't play on TV/);
  assert.equal(globalThis.__toasts.at(-1)[1], "error");
});

test("a player that stops answering hands the music back, paused", async () => {
  await connected();
  for (let i = 0; i < 9; i++) report({ message: "The player doesn't answer" });
  assert.ok(cast.useCast.getState().active);
  report({ message: "The player doesn't answer" });
  await flush();
  assert.equal(cast.useCast.getState().active, null);
  assert.equal(usePlayer.getState().playing, false);
  assert.deepEqual(bridgeLog, [["stop"]]);
  assert.ok(globalThis.__audio.some((a) => a[0] === "takeBack"));
  assert.match(globalThis.__toasts.at(-1)[0], /TV stopped answering/);
});

test("taking the music back: this computer plays on, the player hears nothing more", async () => {
  await connected();
  await cast.stopCasting();
  assert.deepEqual(bridgeLog, [["stop"]]);
  assert.deepEqual(globalThis.__audio, [["takeBack"]]);
  assert.equal(usePlayer.getState().playing, true);
  assert.equal(statusListener, null);
  bridgeLog = [];
  usePlayer.getState().next(true);
  usePlayer.getState().toggle();
  await flush();
  assert.deepEqual(bridgeLog, []);
});

test("the volume: the player's while casting (latest value wins), this computer's otherwise", async () => {
  assert.equal(cast.volumeTarget().value, 0.8);
  await connected();
  const v = cast.volumeTarget();
  assert.equal(v.value, 0.3);
  assert.equal(v.fixed, false);
  v.setVolume(0.4);
  v.setVolume(0.5);
  v.setVolume(0.6);
  assert.equal(cast.volumeTarget().value, 0.6);
  await flush();
  // The first goes at once; of those arriving meanwhile only the last is sent.
  assert.deepEqual(bridgeLog, [["volume", 0.4], ["volume", 0.6]]);
  assert.equal(usePlayer.getState().volume, 0.8); // this computer's volume untouched
  bridgeLog = [];
  cast.volumeTarget().toggleMute();
  await flush();
  assert.deepEqual(bridgeLog, [["mute", 1]]);
  assert.equal(cast.volumeTarget().muted, true);
  // A player whose volume can't be set from here: the slider is fixed.
  cast.useCast.setState({ volume: null });
  assert.equal(cast.volumeTarget().fixed, true);
  await cast.stopCasting();
  assert.equal(cast.volumeTarget().value, 0.8);
  assert.equal(cast.volumeTarget().fixed, false);
});

test("searching lists the players found", async () => {
  const found = await cast.searchCastDevices();
  assert.deepEqual(found, [TV]);
  assert.deepEqual(cast.useCast.getState().devices, [TV]);
  assert.equal(cast.useCast.getState().searching, false);
});
