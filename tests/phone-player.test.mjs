// The phone's queue and what it does while it shows another device (mobile/src/stores/player.ts):
// first come, first played, branches included; and a skip shows at once, without what that device
// says before it got there moving the screen back and forth.
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const stores = fileURLToPath(new URL("../mobile/src/stores/", import.meta.url));
const stubs = {
  "stores/connection": `export const useConnection = { getState: () => ({ reach: "online", metered: false, check: async () => "online" }), subscribe() {} };`,
  "stores/devices": `const known = { others: [] }; export const useDevices = { getState: () => known, setState(next) { Object.assign(known, next); } }; export const isAround = () => true;`,
  "stores/localMusic": `export const fileOfSong = () => null;`,
  "stores/downloads": `export const useDownloads = { getState: () => ({ kept: {}, covers: {} }), subscribe() {} }; export const downloadsLine = () => "";`,
  "stores/library": `export const useLibrary = { getState: () => ({ muted: new Set(), byId: new Map(), loaded: true, data: { tracks: [], counts: {} }, notePlayed() {} }), subscribe() {} };`,
  // A song this phone knows under another copy's id, and one it doesn't have.
  "stores/playlists": `export const findSong = (wire) => (wire.id === "elsewhere" ? undefined : { thumb: "", ...wire, id: globalThis.__copies?.[wire.id] ?? wire.id });`,
  "stores/session": `export const useSession = { getState: () => ({ session: null }) }; export const here = (x) => x;`,
  "stores/settings": `export const useSettings = { getState: () => ({ autoplay: false, dontRepeat: false, speed: 1, skipEndsRepeatOne: globalThis.__skipEnds !== false }) };`,
  "stores/popups": `export const toast = () => undefined;`,
  storage: `export const readJson = async () => null; export const writeJson = () => undefined;`,
  jellyfin: `export const streamUrl = () => "http://test/song";`,
  addresses: `export const withoutServer = (x) => x;`,
  quality: `export const ORIGINAL = { kind: "original" }; export const chooseStream = () => globalThis.__stream ?? ORIGINAL; export const levelGain = () => 0; export const sameChoice = () => true; export const stepDown = () => null;`,
};
const out = await build({
  stdin: { contents: `export { usePlayer, adoptPlayback, hearDevices, linkDevices, playbackNote, runCommand, wantsPlayback, watchPlayer } from "./player";`, resolveDir: stores, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /^react-native$/ }, () => ({ path: "react-native", namespace: "stub" }));
        b.onResolve({ filter: /media3-player$/ }, () => ({ path: "media3", namespace: "stub" }));
        b.onLoad({ filter: /^react-native$/, namespace: "stub" }, () => ({ contents: `export const Platform = { constants: { Model: "Test" } };`, loader: "js" }));
        b.onLoad({ filter: /^media3$/, namespace: "stub" }, () => ({
          contents: `const calls = (globalThis.__native = []);
            const say = (name) => async (...args) => { globalThis.__native.push([name, ...args]); };
            export default new Proxy({}, { get: (_, name) => name === "addListener" ? (event, fn) => { globalThis.__listeners ??= {}; globalThis.__listeners[event] = fn; } : name === "getMediaVolume" ? async () => 50 : say(name) });`,
          loader: "js",
        }));
        for (const [name, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`[\\\\/]mobile[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`);
          b.onLoad({ filter }, () => ({ contents, resolveDir: stores, loader: "ts" }));
        }
      },
    },
  ],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const { usePlayer, adoptPlayback, hearDevices, linkDevices, watchPlayer } = m;
watchPlayer();

const t = (id) => ({ id, title: id.toUpperCase(), artist: "Band", duration: 100 });
const songs = (...names) => names.map(t);
const ids = () => usePlayer.getState().queue.map((x) => x.id);
const now = () => usePlayer.getState().queue[usePlayer.getState().index]?.id;
const player = () => usePlayer.getState();

/** The native player's word: this song is on. */
function nativeSays(index, more = {}) {
  globalThis.__listeners.onState({ index, isPlaying: true, playWhenReady: true, isBuffering: false, isEnded: false, positionMs: 0, durationMs: 100000, repeat: "off", audio: "", count: player().queue.length, ...more });
}

/** What the PC says about itself. */
const pc = (id, more = {}) => ({ id: "pc", ageMs: 0, lastSeen: Date.now(), presence: { name: "PC", kind: "desktop", playing: true, positionMs: 40000, durationMs: 100000, track: t(id), queueId: "q1", ...more } });

let sent;
const LIST = songs("a", "b", "c", "d");

/** Following the PC, with its list known here. */
function followPc(at = "b", list = LIST, doc = {}) {
  // The PC took the music over from here.
  m.runCommand({ action: "yield", to: "pc" });
  hearDevices([pc(at)]);
  adoptPlayback({ device: { id: "pc", name: "PC" }, at: 1, playing: true, positionMs: 40000, track: t(at), queueId: "q1" }, { id: "q1", tracks: list, ...doc });
}

beforeEach(() => {
  sent = [];
  linkDevices({
    self: "phone",
    send: async (id, command) => {
      sent.push(command);
      return true;
    },
    sendList: async (id, tracks, context, command) => {
      sent.push({ ...command, tracks });
      return true;
    },
    handOver: async () => true,
    look: () => undefined,
    presence: () => undefined,
  });
  hearDevices([]);
  player().stop();
  usePlayer.setState({ isPlaying: false, playWhenReady: false });
  globalThis.__native.length = 0;
});

/* ------------------------------------------------------------- the queue */

test("first come, first played: a song, a branch, a song, another branch", () => {
  player().playTracks(songs("a", "b", "c"), 0, "Album");
  assert.equal(player().addToQueue(songs("q")), 1);
  player().branchOff(songs("w", "x", "y"), 1, "Mix");
  assert.deepEqual(ids(), ["a", "q", "x", "y", "b", "c"]);
  assert.equal(player().addToQueue(songs("n")), 4);
  player().branchOff(songs("r", "s"), 0, "Other");
  assert.deepEqual(ids(), ["a", "q", "x", "y", "n", "r", "s", "b", "c"]);
  assert.equal(player().lineEnd, 7);
  assert.deepEqual(player().branches.map((b) => b.name), ["Mix", "Other"]);
  const native = globalThis.__native.filter((c) => c[0] === "replaceUpcoming").at(-1)[1].map((item) => item.id);
  assert.deepEqual(native, ["q", "x", "y", "n", "r", "s", "b", "c"], "the player has the same order");
});

test("each branch goes back by itself, and what it took out of the list comes back where it was", () => {
  player().playTracks(songs("a", "b", "c"), 0, "Album");
  player().branchOff(songs("x", "b"), 0, "Mix");
  player().addToQueue(songs("q"));
  player().branchOff(songs("r"), 0, "Other");
  assert.deepEqual(ids(), ["a", "x", "b", "q", "r", "c"]);
  player().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "q", "r", "b", "c"]);
  player().cancelBranch("Other");
  assert.deepEqual(ids(), ["a", "q", "b", "c"]);
  assert.equal(player().lineEnd, 2);
  assert.deepEqual(globalThis.__native.at(-1)[1].map((item) => item.id), ["q", "b", "c"]);
});

test("the same list again: the branch starts at the other song, and only goes once", () => {
  player().playTracks(songs("a", "b"), 0, "Album");
  player().branchOff(songs("x", "y", "z"), 0, "Mix");
  player().branchOff(songs("x", "y", "z"), 1, "Mix");
  assert.deepEqual(ids(), ["a", "y", "z", "b"]);
  assert.equal(player().branches.length, 1);
  assert.ok(player().branchFrom("y", "Mix"));
  assert.equal(player().branchFrom("x", "Mix"), undefined);
});

test("taken out, a song stays out, and what's asked for by hand leaves a branch", () => {
  player().playTracks(songs("a", "b", "c"), 0, "Album");
  player().branchOff(songs("x", "y"), 0, "Mix");
  player().removeAt(1);
  assert.deepEqual(ids(), ["a", "y", "b", "c"]);
  assert.equal(player().lineEnd, 2);
  assert.equal(player().branches[0].trackId, "y");
  player().removeAt(2);
  player().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "c"]);
});

test("only what was asked for by hand goes", () => {
  player().playTracks(songs("a", "b", "c"), 0, "Album");
  player().addToQueue(songs("q"));
  player().branchOff(songs("x", "b"), 0, "Mix");
  player().clearLine();
  assert.deepEqual(ids(), ["a", "b", "c"]);
  assert.deepEqual(player().branches, []);
  assert.deepEqual(globalThis.__native.at(-1)[1].map((item) => item.id), ["b", "c"]);
});

test("moving a song across the end of the line takes it out of the line or into it", () => {
  player().playTracks(songs("a", "b", "c"), 0, "Album");
  player().addToQueue(songs("q", "r"));
  assert.equal(player().lineEnd, 3);
  player().moveItem(2, 3);
  assert.deepEqual(ids(), ["a", "q", "b", "r", "c"]);
  assert.equal(player().lineEnd, 2, "r is one of the list's now");
  player().moveItem(4, 1);
  assert.deepEqual(ids(), ["a", "c", "q", "b", "r"]);
  assert.equal(player().lineEnd, 3, "c was moved up among the songs asked for");
});

test("Playing from: the branch's list while its songs play, then back", () => {
  player().playTracks(songs("a", "b"), 0, "Album");
  player().branchOff(songs("x", "y"), 0, "Mix");
  nativeSays(0);
  assert.equal(player().context, "Album");
  nativeSays(1);
  assert.equal(player().context, "Mix");
  assert.equal(player().homeContext, "Album");
  assert.equal(player().branches[0].started, true);
  nativeSays(2);
  assert.equal(player().context, "Mix");
  nativeSays(3);
  assert.equal(player().context, "Album");
  assert.equal(player().homeContext, null);
  assert.deepEqual(player().branches, []);
});

test("Previous before a branch's first song: chosen again, and the list's name is back", () => {
  player().playTracks(songs("a", "b"), 0, "Album");
  player().branchOff(songs("x", "y"), 0, "Mix");
  nativeSays(1);
  nativeSays(0);
  assert.equal(player().branches[0].started, false);
  assert.equal(player().context, "Album");
});

test("from the very song that's playing: the list plays on behind it", () => {
  player().playTracks(songs("a", "b"), 0, "Album");
  player().branchOff(songs("a", "y"), 0, "Mix");
  assert.deepEqual(ids(), ["a", "y", "b"]);
  assert.equal(player().branches[0].started, true);
  assert.equal(player().context, "Mix");
  player().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "b"]);
  assert.equal(player().context, "Album");
});

/* ------------------------------------------------------------- showing another device */

/** Every song the screen stood on from here on. */
function watchSongs() {
  const stood = [];
  const off = usePlayer.subscribe((s, prev) => {
    const song = s.queue[s.index]?.id;
    if (song !== prev.queue[prev.index]?.id) stood.push(song);
  });
  return { stood, off };
}

test("Next shows at once, and what the device says before it got there doesn't move it back", () => {
  followPc();
  assert.equal(now(), "b");
  const { stood, off } = watchSongs();
  player().next();
  assert.equal(now(), "c", "at once");
  assert.equal(player().positionMs, 0);
  assert.deepEqual(sent.at(-1), { action: "jump", trackId: "c", by: 1, track: t("c") });
  // The PC hasn't heard yet: still the song before, further on.
  hearDevices([pc("b", { positionMs: 41000 })]);
  assert.equal(now(), "c");
  assert.equal(player().positionMs, 0, "nor its place in the song");
  hearDevices([pc("c", { positionMs: 3000 })]);
  assert.equal(now(), "c");
  assert.equal(player().positionMs, 3000, "from here on it's what the device says");
  off();
  assert.deepEqual(stood, ["c"], "one step, never back");
});

test("a swipe back goes one way only", () => {
  followPc();
  const { stood, off } = watchSongs();
  player().skipBy(-1);
  assert.equal(now(), "a");
  assert.deepEqual(sent.at(-1), { action: "jump", trackId: "a", by: -1, track: t("a") });
  hearDevices([pc("b")]);
  hearDevices([pc("b", { positionMs: 42000 })]);
  hearDevices([pc("a", { positionMs: 100 })]);
  off();
  assert.deepEqual(stood, ["a"]);
});

test("Previous goes back near a song's start; well into it, it starts over", () => {
  followPc();
  usePlayer.setState({ positionMs: 40000 });
  player().previous();
  assert.equal(now(), "b");
  assert.deepEqual(sent.at(-1), { action: "seek", positionMs: 0 });
  usePlayer.setState({ positionMs: 1000 });
  player().previous();
  assert.equal(now(), "a");
  assert.deepEqual(sent.at(-1), { action: "jump", trackId: "a", by: -1, track: t("a") });
});

test("two skips in a row wait for the last one", () => {
  followPc();
  const { stood, off } = watchSongs();
  player().next();
  player().next();
  assert.equal(now(), "d");
  hearDevices([pc("b")]);
  hearDevices([pc("c", { positionMs: 200 })]);
  assert.equal(now(), "d", "the first one arrived on the way");
  hearDevices([pc("d", { positionMs: 200 })]);
  off();
  assert.deepEqual(stood, ["c", "d"]);
});

test("a device that doesn't get there: after a while, what it says counts again", () => {
  followPc();
  const real = Date.now;
  try {
    player().next();
    const later = real() + 6000;
    Date.now = () => later;
    hearDevices([pc("b", { positionMs: 45000 })]);
    assert.equal(now(), "b");
    assert.equal(player().positionMs, 45000);
  } finally {
    Date.now = real;
  }
});

test("a list arriving while a skip is under way keeps the screen on the skip", () => {
  followPc();
  player().next();
  adoptPlayback({ device: { id: "pc", name: "PC" }, at: 2, playing: true, positionMs: 41000, track: t("b"), queueId: "q2" }, { id: "q2", tracks: songs("a", "b", "z", "c", "d") });
  assert.equal(now(), "c");
  assert.equal(player().positionMs, 0);
  assert.deepEqual(ids(), ["a", "b", "z", "c", "d"]);
});

test("Pause shows at once; a moment later the old word doesn't flip it back", () => {
  followPc();
  player().toggle();
  assert.equal(player().isPlaying, false);
  assert.deepEqual(sent.at(-1), { action: "pause" });
  hearDevices([pc("b", { playing: true })]);
  assert.equal(player().isPlaying, false);
  const real = Date.now;
  try {
    const later = real() + 3000;
    Date.now = () => later;
    hearDevices([pc("b", { playing: true })]);
    assert.equal(player().isPlaying, true, "somebody pressed play there");
  } finally {
    Date.now = real;
  }
});

test("a new list started from here: it stays on screen until the device has it", () => {
  followPc();
  player().playTracks(songs("m", "n"), 1, "Mix");
  assert.equal(now(), "n");
  assert.equal(sent.at(-1).action, "playList");
  hearDevices([pc("b", { positionMs: 41000 })]);
  assert.equal(now(), "n", "not back to the old album");
  assert.equal(player().context, "Mix");
  hearDevices([pc("n", { positionMs: 100, queueId: "q9" })]);
  assert.equal(now(), "n");
});

test("a song in the queue twice, heard and asked for again: every word finds the right copy", () => {
  // Heard a, on b, a asked for again.
  followPc("b", songs("a", "b", "a", "c"));
  assert.equal(player().index, 1);
  player().next();
  assert.equal(player().index, 2);
  assert.deepEqual(sent.at(-1), { action: "jump", trackId: "a", by: 1, track: t("a") });
  hearDevices([pc("a", { positionMs: 100 })]);
  assert.equal(player().index, 2, "not the copy that was heard");
  player().next();
  hearDevices([pc("c", { positionMs: 100 })]);
  assert.equal(player().index, 3);
  // Moved on by itself, seen from here.
  usePlayer.setState({ index: 1 });
  hearDevices([pc("a", { positionMs: 100 })]);
  assert.equal(player().index, 2, "ahead rather than behind");
});

test("adopted while it stands on the later copy of a song: that one", () => {
  m.runCommand({ action: "yield", to: "pc" });
  hearDevices([pc("a")]);
  adoptPlayback({ device: { id: "pc", name: "PC" }, at: 1, playing: true, positionMs: 5000, track: t("a"), queueId: "q5", place: 12 }, { id: "q5", from: 10, tracks: songs("a", "b", "a", "c") });
  assert.equal(player().index, 2);
});

test("told to go to a song that's there twice, this phone takes the copy that was meant", () => {
  player().playTracks(songs("a", "b", "c"), 1, "Album");
  player().addToQueue(songs("a"));
  assert.deepEqual(ids(), ["a", "b", "a", "c"]);
  m.runCommand({ action: "jump", trackId: "a", by: 1 });
  assert.deepEqual(globalThis.__native.at(-1), ["skipTo", 2, true]);
  m.runCommand({ action: "jump", trackId: "a", by: -1 });
  assert.deepEqual(globalThis.__native.at(-1), ["skipTo", 0, true]);
});

test("what's asked for shows at once and goes to the device: a song, a branch, taking it back", () => {
  followPc("a");
  assert.equal(player().addToQueue(songs("q")), 1);
  assert.deepEqual(ids(), ["a", "q", "b", "c", "d"]);
  assert.equal(sent.at(-1).action, "enqueue");
  player().branchOff(songs("x", "y"), 0, "Mix");
  assert.deepEqual(ids(), ["a", "q", "x", "y", "b", "c", "d"]);
  assert.equal(sent.at(-1).action, "branchOff");
  assert.equal(sent.at(-1).name, "Mix");
  player().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "q", "b", "c", "d"]);
  assert.deepEqual(sent.at(-1), { action: "cancelBranch", name: "Mix" });
  player().removeAt(1);
  assert.equal(sent.at(-1).action, "setUpcoming");
  assert.equal(sent.at(-1).line, 0);
  assert.deepEqual(sent.at(-1).tracks.map((s) => s.id), ["b", "c", "d"]);
  assert.equal(globalThis.__native.filter((c) => c[0] === "insertItems" || c[0] === "replaceUpcoming").length, 0, "nothing plays here");
});

test("the device's list brings the hand-made part and the branches with it", () => {
  followPc("a", LIST, { lineEnd: 3, branches: [{ name: "Mix", trackId: "b", started: false, ids: ["b", "c"] }] });
  assert.equal(player().lineEnd, 3);
  assert.equal(player().branches[0].name, "Mix");
  // The device moves on: the first song of the branch comes on.
  hearDevices([pc("b", { positionMs: 100 })]);
  assert.equal(now(), "b");
  assert.equal(player().branches[0].started, true);
});

test("what another device changes: the list, the line and the branches go together", () => {
  player().playTracks(songs("a", "b", "c"), 0, "Album");
  m.runCommand({ action: "setUpcoming", line: 1, tracks: songs("q", "c") });
  assert.deepEqual(ids(), ["a", "q", "c"]);
  assert.equal(player().lineEnd, 2);
  m.runCommand({ action: "branchOff", name: "Mix", tracks: songs("x", "y") });
  assert.deepEqual(ids(), ["a", "q", "x", "y", "c"]);
  m.runCommand({ action: "cancelBranch", name: "Mix" });
  assert.deepEqual(ids(), ["a", "q", "c"]);
});

test("told to go to a song by another copy's name: the song, wherever this phone has it", () => {
  player().playTracks(songs("a", "b", "c"), 0, "Album");
  globalThis.__copies = { "local:pc-b": "b" };
  try {
    m.runCommand({ action: "jump", trackId: "local:pc-b", by: 1, track: t("local:pc-b") });
    assert.deepEqual(globalThis.__native.at(-1), ["skipTo", 1, true]);
    // Not known here at all: one step along the list still means the next one.
    nativeSays(1);
    m.runCommand({ action: "jump", trackId: "elsewhere", by: 1, track: t("elsewhere") });
    assert.deepEqual(globalThis.__native.at(-1), ["skipTo", 2, true]);
    // Further away without knowing what's meant: nothing happens.
    nativeSays(0);
    globalThis.__native.length = 0;
    m.runCommand({ action: "jump", trackId: "elsewhere", by: 2, track: t("elsewhere") });
    assert.deepEqual(globalThis.__native.filter((c) => c[0] === "skipTo"), []);
  } finally {
    delete globalThis.__copies;
  }
});

test("following a device, what was meant for this phone before the music moved on is dropped", () => {
  followPc();
  globalThis.__native.length = 0;
  for (const command of [{ action: "pause" }, { action: "play" }, { action: "seek", positionMs: 5000 }, { action: "next" }, { action: "previous" }, { action: "volume", level: 0.2 }, { action: "shuffle", on: true }, { action: "repeat", mode: "all" }, { action: "jump", trackId: "c", by: 1 }]) {
    m.runCommand(command);
    assert.ok(player().remote, `${command.action} leaves the following alone`);
  }
  assert.deepEqual(globalThis.__native, []);
  assert.equal(now(), "b");
  m.runCommand({ action: "takeOver" });
  assert.equal(player().remote, null, "asked to play here, it does");
  assert.ok(globalThis.__native.some((c) => c[0] === "play"));
});

test("a clock behind the other device's doesn't make this phone's own news old", () => {
  const ahead = Date.now() + 90_000;
  followPc();
  adoptPlayback({ device: { id: "pc", name: "PC" }, at: ahead, playing: true, positionMs: 40000, track: t("c"), queueId: "q-ahead", place: 2 }, { id: "q-ahead", from: 0, tracks: LIST });
  player().takeHere();
  const { note } = m.playbackNote({ id: "phone", name: "Phone" });
  assert.ok(note.at > ahead, "newer than what it took over");
  nativeSays(2);
  assert.ok(m.playbackNote({ id: "phone", name: "Phone" }).note.at > note.at, "and every word after that newer still");
  assert.equal(m.wantsPlayback({ device: { id: "pc", name: "PC" }, at: ahead, playing: true, positionMs: 40000, track: t("c"), queueId: "q-ahead" }), false, "what it took over isn't news");
});

test("the music gone to another device: that it's paused here is no news, until somebody starts something here", () => {
  player().playTracks(songs("a", "b"), 0, "Album");
  nativeSays(0);
  assert.ok(m.playbackNote({ id: "phone", name: "Phone" }), "it says where it stands");
  m.runCommand({ action: "yield", to: "pc" });
  assert.equal(m.playbackNote({ id: "phone", name: "Phone" }), null, "it would overwrite what the other device just said");
  // Nothing came of it there, and somebody starts it here again.
  globalThis.__listeners.onState({ index: 0, isPlaying: false, playWhenReady: false, isBuffering: false, isEnded: false, positionMs: 0, durationMs: 100000, repeat: "off", audio: "", bandwidthBps: 0, count: 2 });
  nativeSays(0);
  assert.ok(m.playbackNote({ id: "phone", name: "Phone" }));
});

test("a song only just starting on the other device doesn't know its length yet", () => {
  followPc();
  hearDevices([pc("c", { durationMs: 0, positionMs: 500 })]);
  assert.equal(now(), "c");
  assert.equal(player().durationMs, 100000);
});

test("starting to follow is said right away: the others shouldn't go by what this phone said before", () => {
  let said = 0;
  linkDevices({ self: "phone", send: async () => true, sendList: async () => true, handOver: async () => true, look: () => undefined, presence: () => (said += 1) });
  m.runCommand({ action: "yield", to: "pc" });
  hearDevices([pc("b")]);
  assert.equal(said, 1);
  hearDevices([pc("b", { positionMs: 42000 })]);
  assert.equal(said, 1, "only when it starts");
});

test("a small difference from the clock running here is no move; a real one is", () => {
  followPc();
  hearDevices([pc("b", { positionMs: 40000 })]);
  const before = player().positionMs;
  hearDevices([pc("b", { positionMs: before + 700 })]);
  assert.equal(player().positionMs, before, "the words on screen don't flicker");
  hearDevices([pc("b", { positionMs: before - 900 })]);
  assert.equal(player().positionMs, before, "nor back");
  hearDevices([pc("b", { positionMs: before + 20000 })]);
  assert.equal(player().positionMs, before + 20000, "somebody moved it there");
});

/* ------------------------------------------------------------- repeat, going from device to device */

const lastRepeat = () => globalThis.__native.filter((c) => c[0] === "setRepeat").at(-1)?.[1];

test("taken over from a device, the music goes round the way it did there", () => {
  followPc();
  hearDevices([pc("b", { repeat: "one", shuffle: true })]);
  assert.equal(player().repeat, "one");
  globalThis.__native.length = 0;
  player().takeHere();
  assert.equal(lastRepeat(), "one", "this phone's own player is told");
  assert.ok(globalThis.__native.findIndex((c) => c[0] === "setQueue") >= 0);
  assert.equal(player().shuffle, true);
});

test("handed over, the note says how it goes on, and the list's own order comes along", () => {
  player().playTracks(songs("a", "b", "c", "d"), 0, "Album", true);
  usePlayer.setState({ repeat: "all" });
  nativeSays(0, { repeat: "all" });
  const { note, queue } = m.playbackNote({ id: "phone", name: "Phone" });
  assert.equal(note.shuffle, true);
  assert.equal(note.repeat, "all");
  assert.deepEqual(queue().unshuffled.map((s) => s.id), ["a", "b", "c", "d"]);

  // The other way round.
  player().stop();
  usePlayer.setState({ shuffle: false, repeat: "off" });
  globalThis.__native.length = 0;
  adoptPlayback({ device: { id: "pc", name: "PC" }, at: 5, playing: true, positionMs: 9000, track: t("c"), queueId: "q7", place: 0, shuffle: true, repeat: "one" }, { id: "q7", from: 0, tracks: songs("c", "a", "d", "b"), unshuffled: songs("a", "b", "c", "d") }, true);
  assert.equal(player().shuffle, true);
  assert.equal(player().repeat, "one");
  assert.equal(lastRepeat(), "one");
  player().toggleShuffle();
  assert.deepEqual(ids().slice(0, 2), ["c", "d"], "shuffle off here finds the list's own order");
});

test("sent a song this phone doesn't have: the next one it does, from its start; none at all, it stays as it was", () => {
  const list = songs("elsewhere", "b", "c");
  const note = { device: { id: "pc", name: "PC" }, at: 5, playing: true, positionMs: 9000, track: t("elsewhere"), queueId: "q8", place: 0 };
  assert.equal(adoptPlayback(note, { id: "q8", from: 0, tracks: list }, true), true);
  assert.equal(now(), "b");
  assert.equal(player().positionMs, 0);
  player().stop();
  assert.equal(adoptPlayback(note, { id: "q8", from: 0, tracks: songs("elsewhere") }, true), false);
  assert.equal(now(), undefined);
  // Merely seen, not sent: nothing to say.
  assert.equal(adoptPlayback(note, null), true);
});

/* ------------------------------------------------------------- skipping away from repeat-one */

function onRepeatOne() {
  player().playTracks(songs("a", "b", "c"), 0, "Album");
  usePlayer.setState({ repeat: "one" });
  nativeSays(0, { repeat: "one" });
  globalThis.__native.length = 0;
}

test("repeat-one ends with a skip, however it came: the buttons, a swipe, the queue, the lock screen", () => {
  onRepeatOne();
  player().next();
  nativeSays(1, { repeat: "one" });
  assert.equal(player().repeat, "all", "Next");
  assert.equal(lastRepeat(), "all");

  onRepeatOne();
  nativeSays(1, { repeat: "one" });
  assert.equal(player().repeat, "all", "from outside the app: the lock screen, headphones");
  assert.equal(lastRepeat(), "all");

  onRepeatOne();
  player().skipBy(1);
  assert.equal(player().repeat, "all", "a swipe");
  assert.equal(lastRepeat(), "all");
  nativeSays(1, { repeat: "all" });

  onRepeatOne();
  player().skipTo(2);
  nativeSays(2, { repeat: "one" });
  assert.equal(player().repeat, "all", "from the queue");
});

test("the last song on repeat-one: Next goes round, on a player that would stay there by itself", () => {
  player().playTracks(songs("a", "b"), 1, "Album");
  usePlayer.setState({ repeat: "one" });
  nativeSays(1, { repeat: "one" });
  globalThis.__native.length = 0;
  player().next();
  assert.equal(player().repeat, "all");
  assert.deepEqual(globalThis.__native.map((c) => c[0]).filter((n) => n === "setRepeat" || n === "next"), ["setRepeat", "next"]);
});

test("the same song over, or the end of it, isn't a skip; nor is a song removed from before it", () => {
  onRepeatOne();
  nativeSays(0, { repeat: "one", positionMs: 100 });
  assert.equal(player().repeat, "one");
  player().playTracks(songs("x", "a", "b"), 1, "Album");
  usePlayer.setState({ repeat: "one", isPlaying: true, playWhenReady: true });
  nativeSays(1, { repeat: "one" });
  player().removeAt(0);
  nativeSays(0, { repeat: "one" });
  assert.equal(player().repeat, "one");
});

test("with the setting off, repeat-one stays when skipping", () => {
  globalThis.__skipEnds = false;
  try {
    onRepeatOne();
    player().next();
    nativeSays(1, { repeat: "one" });
    assert.equal(player().repeat, "one");
    assert.equal(lastRepeat(), undefined);
    onRepeatOne();
    player().skipBy(1);
    assert.equal(player().repeat, "one");
    nativeSays(1, { repeat: "one" });
  } finally {
    delete globalThis.__skipEnds;
  }
});

test("Play goes by the shuffle that's on; the Shuffle button turns it on; as on the computer", () => {
  usePlayer.setState({ shuffle: true });
  player().playAll(songs("a", "b", "c", "d"), "Album");
  assert.equal(player().shuffle, true);
  assert.deepEqual(player().unshuffled.map((s) => s.id), ["a", "b", "c", "d"]);
  usePlayer.setState({ shuffle: false, unshuffled: null });
  player().playAll(songs("a", "b", "c", "d"), "Album");
  assert.equal(player().shuffle, false);
  assert.deepEqual(ids(), ["a", "b", "c", "d"]);
  player().playAll(songs("a", "b", "c", "d"), "Album", true);
  assert.equal(player().shuffle, true);
});

test("a new list while something plays is another song too; with nothing on, repeat-one is left alone", () => {
  onRepeatOne();
  usePlayer.setState({ playWhenReady: true });
  player().playTracks(songs("m", "n"), 0, "Mix");
  assert.equal(player().repeat, "all");

  player().stop();
  usePlayer.setState({ repeat: "one", playWhenReady: false, isPlaying: false });
  player().playTracks(songs("m", "n"), 0, "Mix");
  assert.equal(player().repeat, "one");
});

test("what this phone tells the others holds the line and the branches", () => {
  player().playTracks(songs("a", "b"), 0, "Album");
  player().branchOff(songs("x", "y"), 0, "Mix");
  nativeSays(1);
  const doc = m.playbackNote({ id: "phone", name: "Phone" }).queue();
  assert.equal(doc.lineEnd, 3);
  assert.equal(doc.branches[0].name, "Mix");
  assert.equal(doc.context, "Mix");
  assert.equal(doc.home, "Album");
});

/* ------------------------------------------------------------- a copy the server can't make */

/** A store of its own: that the server makes no smaller copies is remembered for as long as the app runs. */
async function freshPlayer(tag) {
  const fresh = await import(`data:text/javascript;base64,${Buffer.from(`${out.outputFiles[0].text}\n// ${tag}`).toString("base64")}`);
  fresh.watchPlayer();
  return fresh;
}
const smallerCopyFails = () => globalThis.__listeners.onError({ message: "not here", code: "ERROR_CODE_IO_BAD_HTTP_STATUS" });

test("a smaller copy the server can't make: the file itself takes over, and a paused player stays paused", async (context) => {
  globalThis.__stream = { kind: "transcode", kbps: 256 };
  context.after(() => {
    globalThis.__stream = undefined;
    watchPlayer();
  });
  const fresh = await freshPlayer("paused");
  fresh.adoptPlayback({ device: { id: "pc", name: "PC" }, at: Date.now(), playing: false, positionMs: 12000, track: t("a"), queueId: "q" }, { id: "q", tracks: songs("a", "b") });
  assert.equal(fresh.usePlayer.getState().playWhenReady, false);
  globalThis.__native.length = 0;
  smallerCopyFails();
  const said = globalThis.__native.map((c) => c[0]);
  assert.ok(said.includes("replaceCurrent"), "the file itself, from the same place");
  assert.ok(!said.includes("play"), "nobody pressed play");
});

test("a smaller copy the server can't make: a song under way goes on from the file", async (context) => {
  globalThis.__stream = { kind: "transcode", kbps: 256 };
  context.after(() => {
    globalThis.__stream = undefined;
    watchPlayer();
  });
  const fresh = await freshPlayer("playing");
  fresh.usePlayer.getState().playTracks(songs("a", "b"), 0, "Album");
  nativeSays(0);
  globalThis.__native.length = 0;
  smallerCopyFails();
  const said = globalThis.__native.map((c) => c[0]);
  assert.ok(said.includes("replaceCurrent"));
  assert.ok(said.includes("play"));
});

test("started with the service away: the others hear of it when it's back", () => {
  let connected = false;
  linkDevices({
    self: "phone",
    send: async (id, command) => {
      sent.push(command);
      return true;
    },
    sendList: async () => true,
    handOver: async () => true,
    look: () => undefined,
    presence: () => undefined,
    connected: () => connected,
  });
  player().playTracks(songs("a", "b"), 0, "Album");
  nativeSays(0);
  assert.equal(sent.filter((c) => c.action === "yield").length, 0, "nobody to tell");
  connected = true;
  hearDevices([pc("x")]);
  assert.deepEqual(sent.filter((c) => c.action === "yield"), [{ action: "yield", to: "phone" }], "back, it says the music is here");
  hearDevices([pc("x")]);
  assert.equal(sent.filter((c) => c.action === "yield").length, 1, "once");
});
