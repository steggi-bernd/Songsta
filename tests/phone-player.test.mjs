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
  // Linked to a computer at home: a song only it has comes from there (homeLink.ts).
  homeLink: `export const songFromComputer = (id) => (globalThis.__computer && id === "elsewhere" ? "http://computer/v1/files/elsewhere" : null);
    export const handOutToComputer = async () => globalThis.__pendingShare?.ready;
    export const toHandOut = (tracks) => tracks.some((track) => track.id === globalThis.__pendingShare?.id);
    export const handedOutAddress = (id) => globalThis.__handedOut?.[id];`,
  storage: `export const readJson = async () => null; export const writeJson = () => undefined; export const removeJson = () => undefined;`,
  jellyfin: `export const streamUrl = () => "http://test/song";`,
  addresses: `export const withoutServer = (x) => x;`,
  quality: `export const ORIGINAL = { kind: "original" }; export const chooseStream = () => globalThis.__stream ?? ORIGINAL; export const levelGain = () => 0; export const sameChoice = () => true; export const stepDown = () => null;`,
};
const out = await build({
  stdin: { contents: `export { usePlayer, adoptPlayback, hearDevices, linkDevices, playbackNote, runCommand, wantsPlayback, watchPlayer } from "./player"; export { servingComputer } from "../serving";`, resolveDir: stores, loader: "ts" },
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

test("a later remote play choice stays last when preparing a local file takes time", async () => {
  followPc();
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  globalThis.__pendingShare = { id: "local:a", ready };
  try {
    player().playTracks([{ ...t("local:a"), localPath: "content://music/a" }], 0, "First", false);
    player().playTracks(songs("jf:b"), 0, "Second", false);
    assert.equal(now(), "jf:b");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    const last = sent.filter((command) => command.action === "playList").at(-1);
    assert.ok(last, "the player received a selection");
    assert.equal(last.tracks[last.start]?.id, "jf:b");
  } finally {
    release();
    delete globalThis.__pendingShare;
  }
});

test("a pending remote play belongs to the link on which it was requested", async () => {
  followPc();
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  globalThis.__pendingShare = { id: "local:a", ready };
  const onNewLink = [];
  try {
    player().playTracks([{ ...t("local:a"), localPath: "content://music/a" }], 0, "First", false);
    await new Promise((resolve) => setImmediate(resolve));
    linkDevices(null);
    linkDevices({
      self: "phone",
      send: async () => true,
      sendList: async (target, tracks) => { onNewLink.push({ target, ids: tracks.map((song) => song.id) }); return true; },
      handOver: async () => true,
      look() {},
      presence() {},
    });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(onNewLink, []);
  } finally {
    release();
    delete globalThis.__pendingShare;
  }
});

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

test("linked to a computer at home: a song only the computer has stays in the list and plays from there", () => {
  globalThis.__computer = true;
  try {
    player().stop();
    globalThis.__native.length = 0;
    const note = { device: { id: "pc", name: "PC" }, at: 6, playing: true, positionMs: 9000, track: t("elsewhere"), queueId: "q9", place: 0 };
    assert.equal(adoptPlayback(note, { id: "q9", from: 0, tracks: songs("elsewhere", "b") }, true), true);
    assert.deepEqual(ids(), ["elsewhere", "b"], "nothing left out");
    assert.equal(now(), "elsewhere", "the computer's song, not the next one");
    assert.equal(player().positionMs, 9000, "from where it was");
    const set = globalThis.__native.filter((c) => c[0] === "setQueue").at(-1);
    assert.equal(set[1][0].url, "http://computer/v1/files/elsewhere", "fetched from the computer");
  } finally {
    globalThis.__computer = false;
    player().stop();
  }
});

test("a song only this phone has goes to the linked computer with the address it fetches it from", () => {
  const address = "http://192.168.1.5:4000/song/0123456789abcdef0123456789abcdef.flac";
  globalThis.__handedOut = { b: address };
  try {
    player().stop();
    player().playTracks(songs("a", "b", "c"), 0, "Album");
    nativeSays(0);
    const note = m.playbackNote({ id: "phone", name: "Phone" });
    const doc = note.queue();
    assert.equal(doc.tracks.find((w) => w.id === "b").src, address, "handed out: with its address");
    assert.equal(doc.tracks.find((w) => w.id === "a").src, undefined, "not handed out: without");
  } finally {
    globalThis.__handedOut = undefined;
    player().stop();
  }
});

test("while the computer it follows plays this phone's songs, the phone stays awake for it; taken back, it rests", () => {
  globalThis.__handedOut = { b: "http://192.168.1.5:4000/song/0123456789abcdef0123456789abcdef.flac" };
  try {
    followPc("a", songs("a", "b", "c"));
    assert.deepEqual(m.servingComputer(), { name: "PC", title: "A", playing: true }, "b of this phone's comes up there");
    player().takeHere();
    assert.equal(m.servingComputer(), null);
    globalThis.__handedOut = {};
    followPc("a", songs("a", "b", "c"));
    assert.equal(m.servingComputer(), null, "nothing of this phone's there: nothing to stay awake for");
  } finally {
    globalThis.__handedOut = undefined;
    if (player().remote) player().takeHere();
    player().stop();
  }
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

/* ------------------------------------------------- edits where only a stretch of the queue is known */

// Codex's review (2026-11-20): the phone knew 800 of the other device's 1,200 songs, removed one, and the
// other device's queue ended at song 800. The phone now says up to which song it knew the queue.
const many = (n) => Array.from({ length: n }, (_, i) => t(`s${i}`));

test("an edit made while only a stretch of the followed queue is known says up to which song it knew", () => {
  const window = many(801);
  m.runCommand({ action: "yield", to: "pc" });
  hearDevices([pc("s0")]);
  adoptPlayback({ device: { id: "pc", name: "PC" }, at: 1, playing: true, positionMs: 0, track: t("s0"), queueId: "q-long", place: 0 }, { id: "q-long", from: 0, tracks: window, total: 1200 });
  assert.equal(player().queue.length, 801);
  player().removeAt(2);
  const edit = sent.at(-1);
  assert.equal(edit.action, "setUpcoming");
  assert.equal(edit.tracks.length, 799);
  assert.deepEqual(edit.keepAfter, { track: t("s800"), ahead: 800 }, "the last song known, 800 after the one playing");
  // A second edit before that device answers anchors on what it has now.
  player().removeAt(3);
  assert.deepEqual(sent.at(-1).keepAfter, { track: t("s800"), ahead: 799 });
});

test("a whole queue known: an edit replaces what comes next, as before", () => {
  followPc("b", LIST, { from: 0, total: 4 });
  player().removeAt(3);
  assert.equal(sent.at(-1).action, "setUpcoming");
  assert.equal(sent.at(-1).keepAfter, undefined);
});

test("the device playing keeps what comes after the song the edit was anchored to", () => {
  player().playTracks(many(1200), 0, "Long list", false);
  assert.equal(player().queue.length, 1200);
  // The other device knew songs up to s800, removed s2, and sent the 799 it has left.
  const kept = many(801).slice(1).filter((x) => x.id !== "s2");
  m.runCommand({ action: "setUpcoming", tracks: kept, keepAfter: { track: t("s800"), ahead: 800 } });
  assert.equal(player().queue.length, 1199, "only the removed song is gone");
  assert.equal(ids().at(-1), "s1199");
  assert.equal(ids().indexOf("s2"), -1);
  // Played on two songs meanwhile: the anchor is found a little nearer.
  player().playTracks(many(1200), 2, "Long list", false);
  m.runCommand({ action: "setUpcoming", tracks: many(801).slice(3), keepAfter: { track: t("s800"), ahead: 800 } });
  assert.equal(player().queue.length, 1200);
  assert.equal(ids().at(-1), "s1199");
});

test("cleared here while only a stretch of the followed queue is known: all of that queue goes, also what this phone never saw", () => {
  m.runCommand({ action: "yield", to: "pc" });
  hearDevices([pc("s0")]);
  adoptPlayback({ device: { id: "pc", name: "PC" }, at: 1, playing: true, positionMs: 0, track: t("s0"), queueId: "q-long", place: 0 }, { id: "q-long", from: 0, tracks: many(801), total: 1200 });
  player().removeAt(2);
  assert.ok(sent.at(-1).keepAfter, "an edit keeps the rest there");
  player().clearUpcoming();
  assert.equal(sent.at(-1).action, "setUpcoming");
  assert.deepEqual(sent.at(-1).tracks, []);
  assert.equal(sent.at(-1).keepAfter, undefined, "nothing of it stays");
});

/* ------------------------------------------------- shuffle after the queue was cleared (Codex's review, 2026-11-20) */

test("cleared with shuffle on: shuffle off brings none of it back, nor what was asked for by hand and cleared", () => {
  player().playTracks(songs("a", "b", "c"), 0, "List", false);
  player().toggleShuffle();
  player().clearUpcoming();
  assert.deepEqual(ids(), ["a"]);
  player().toggleShuffle();
  assert.deepEqual(ids(), ["a"], "only what was there");

  player().playTracks(songs("a", "b", "c", "d"), 0, "List", false);
  player().toggleShuffle();
  player().addToQueue([t("x")]);
  player().clearLine();
  assert.equal(ids().indexOf("x"), -1);
  player().toggleShuffle();
  assert.deepEqual(ids(), ["a", "b", "c", "d"], "the list's own order, without what was asked for");
});

test("cleared further on with a song in the queue twice: what was heard stays, and shuffle off adds nothing", () => {
  player().playTracks(songs("a", "b", "c", "d", "e", "f"), 0, "List", true);
  nativeSays(1);
  nativeSays(2);
  const heard = ids().slice(0, 3);
  assert.equal(now(), heard[2]);
  player().addToQueue([t(heard[0])]);
  assert.equal(ids().filter((x) => x === heard[0]).length, 2, "the first song again, by hand");
  player().clearUpcoming();
  assert.deepEqual(ids(), heard);
  player().toggleShuffle();
  assert.deepEqual(ids(), heard);
});

test("edited on another device with shuffle on: what it took out stays out here too, and cleared there is cleared here", () => {
  player().playTracks(songs("a", "b", "c", "d"), 0, "List", false);
  player().toggleShuffle();
  m.runCommand({ action: "setUpcoming", line: 0, tracks: ids().slice(1).filter((x) => x !== "c").map(t) });
  player().toggleShuffle();
  assert.deepEqual(ids(), ["a", "b", "d"], "the list's own order, without what was taken out there");

  player().toggleShuffle();
  player().branchOff(songs("r", "s"), 0, "Mix");
  m.runCommand({ action: "setUpcoming", line: 0, tracks: [] });
  assert.deepEqual(ids(), ["a"]);
  assert.deepEqual(player().branches, [], "no branch left of what went");
  player().toggleShuffle();
  assert.deepEqual(ids(), ["a"], "shuffle off brings none of it back");
});

/* ------------------------------------------------- the volume of the device being followed (Codex's review, 2026-11-20) */

const kitchen = (id, more = {}) => ({ id: "kitchen", ageMs: 0, lastSeen: Date.now(), presence: { name: "Kitchen", kind: "speaker", playing: true, positionMs: 1000, durationMs: 100000, track: t(id), queueId: "qk", ...more } });

test("a volume meant for the PC and not sent yet doesn't reach the kitchen once the music moved there", async () => {
  const to = [];
  linkDevices({
    self: "phone",
    send: async (id, command) => {
      to.push([id, command]);
      return true;
    },
    sendList: async () => true,
    handOver: async () => true,
    look: () => undefined,
    presence: () => undefined,
  });
  followPc("b");
  player().setRemoteVolume(0.3);
  player().setRemoteVolume(0.8);
  // The music moves on to the kitchen within the moment the second value waits.
  m.runCommand({ action: "yield", to: "kitchen" });
  hearDevices([pc("b", { playing: false }), kitchen("c", { volume: 0.4 })]);
  assert.equal(player().remote?.id, "kitchen");
  await new Promise((r) => setTimeout(r, 250));
  const volumes = () => to.filter(([, c]) => c.action === "volume").map(([id, c]) => [id, c.level]);
  assert.deepEqual(volumes(), [["pc", 0.3]], "0.8 was for the PC");
  assert.equal(player().remoteVolume, 0.4, "the kitchen's own volume shows");
  player().setRemoteVolume(0.6);
  assert.deepEqual(volumes().at(-1), ["kitchen", 0.6], "its first own value goes at once");
});

/* ------------------------------------------------- a list sent by another device */

test("told to play a list from the second copy of a song in it: that copy, and what comes after it", () => {
  m.runCommand({ action: "playList", start: 2, tracks: songs("a", "b", "a", "c"), context: "Mix" });
  assert.equal(player().index, 2);
  assert.deepEqual(ids().slice(player().index), ["a", "c"]);
  // A song this phone doesn't have: the next one it does.
  m.runCommand({ action: "playList", start: 1, tracks: [t("a"), t("elsewhere"), t("c"), t("d")], context: "Mix" });
  assert.equal(now(), "c");
  assert.deepEqual(ids(), ["a", "c", "d"]);
});

test("two controllers removing different songs from one queue preserve both deletions", () => {
  const original = many(1200);
  player().playTracks(original, 0, "Long list", false);
  player().removeAt(800);
  const earlierWindow = original.slice(1, 801).filter((song) => song.id !== "s2");
  m.runCommand({ action: "setUpcoming", tracks: earlierWindow, keepAfter: { track: t("s800"), ahead: 800 } });
  const expected = original.filter((song) => song.id !== "s2" && song.id !== "s800").map((song) => song.id);
  assert.equal(ids().includes("s800"), false, "the earlier removal must survive the second edit");
  assert.deepEqual(ids(), expected);
});

test("an edit anchored to a song another controller took out meanwhile keeps what came after it", () => {
  player().playTracks(many(1200), 0, "Long list", false);
  // One controller took out s800, the last song another one knew; that one, from the earlier window, takes out s2.
  player().removeAt(800);
  m.runCommand({ action: "setUpcoming", tracks: many(801).slice(1).filter((x) => x.id !== "s2"), keepAfter: { track: t("s800"), ahead: 800 } });
  assert.ok(ids().includes("s801"), "the song after the anchor stays");
  assert.equal(ids().indexOf("s2"), -1);
  assert.equal(ids().at(-1), "s1199");
  assert.equal(new Set(ids()).size, ids().length, "nothing twice");
  // Moved on by one meanwhile as well: what was just sent doesn't come twice.
  player().playTracks(many(1200), 0, "Long list", false);
  player().addToQueue([t("x")]);
  player().removeAt(801);
  m.runCommand({ action: "setUpcoming", tracks: many(801).slice(1), keepAfter: { track: t("s800"), ahead: 800 } });
  assert.equal(new Set(ids()).size, ids().length, "nothing twice");
  assert.ok(ids().includes("s801"));
});

test("a word still waiting when the link changes goes nowhere: the new link hears only what's said on it", async () => {
  followPc();
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.__pendingShare = { id: "local:w", ready };
  const heard = [];
  try {
    player().playTracks([{ ...t("local:w"), localPath: "content://music/w" }], 0, "Waiting", false);
    linkDevices({
      self: "phone",
      send: async (target, command) => {
        heard.push(command.action);
        return true;
      },
      sendList: async (target, tracks, context, command) => {
        heard.push(command.action);
        return true;
      },
      handOver: async () => true,
      look() {},
      presence() {},
    });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(heard, [], "the old word stayed with the old link");
  } finally {
    release();
    delete globalThis.__pendingShare;
    // Not following any more: its ticking would keep the test run alive.
    if (player().remote) player().takeHere();
    player().stop();
  }
});

test("an edit from an older app that saw only a stretch of this queue keeps what comes after that stretch", () => {
  try {
    player().playTracks(Array.from({ length: 1200 }, (_, i) => t(`s${i}`)), 0, "Long");
    nativeSays(0);
    const shown = m.playbackNote({ id: "phone", name: "Phone" }).queue();
    assert.equal(shown.tracks.length, 800, "the others see a stretch");
    assert.equal(shown.total, 1200);
    // An older app takes the second song out of what it saw, and says nothing of how much that was.
    m.runCommand({ action: "setUpcoming", line: 0, tracks: shown.tracks.slice(1).filter((w) => w.id !== "s1") });
    assert.equal(player().queue.length, 1199, "what it never saw stays");
    assert.equal(player().queue[1].id, "s2");
    assert.equal(player().queue.at(-1).id, "s1199");
  } finally {
    player().stop();
  }
});

/* ------------------------------------------------------------- edits by entry (part 3 of the protocol rework) */

test("edits by entry from two devices at once, and a song put in behind place 1,000 by a third: all of it stays here, in one order", () => {
  try {
    player().playTracks(many(1200), 300, "Long list", false);
    nativeSays(300);
    const doc = m.playbackNote({ id: "phone", name: "Phone" }).queue();
    assert.equal(doc.entries.length, doc.tracks.length, "an id for every song said");
    const id = (song) => doc.entries[doc.tracks.findIndex((w) => w.id === song)];
    const playing = id("s300");
    const edit = (ops) => m.runCommand({ action: "editQueue", session: doc.session, ops, playing });
    assert.equal(edit([{ op: "remove", entry: id("s302") }]), "done");
    assert.equal(edit([{ op: "remove", entry: id("s800") }]), "done");
    assert.equal(edit([{ op: "insert", after: [id("s1000")], tracks: [t("new")], entries: ["n1"] }]), "done");
    const expected = many(1200).map((x) => x.id).filter((x) => x !== "s302" && x !== "s800");
    expected.splice(expected.indexOf("s1000") + 1, 0, "new");
    assert.deepEqual(ids(), expected);
    assert.equal(now(), "s300", "the song playing plays on");
    const later = m.playbackNote({ id: "phone", name: "Phone" }).queue();
    assert.equal(later.entries[later.tracks.findIndex((w) => w.id === "new")], "n1", "the new song has the id it was sent with");
    assert.equal(edit([{ op: "remove", entry: id("s302") }]), "partial", "gone already: nothing to apply to");
    assert.equal(m.runCommand({ action: "editQueue", session: "another list", ops: [{ op: "remove", entry: id("s303") }] }), "stale");
    assert.ok(ids().includes("s303"), "an edit of another list changes nothing");
  } finally {
    player().stop();
  }
});

test("of a song in the queue twice, an edit by entry takes out just the one chosen", () => {
  try {
    player().playTracks(songs("a", "x", "b", "x", "c"), 0, "Twice", false);
    nativeSays(0);
    const doc = m.playbackNote({ id: "phone", name: "Phone" }).queue();
    assert.equal(m.runCommand({ action: "editQueue", session: doc.session, ops: [{ op: "remove", entry: doc.entries[3] }], playing: doc.entries[0] }), "done");
    assert.deepEqual(ids(), ["a", "x", "b", "c"]);
  } finally {
    player().stop();
  }
});

test("following a computer that takes edits by entry: an edit made here goes out as edits of its entries, never the whole list", async () => {
  m.runCommand({ action: "yield", to: "pc" });
  const abilities = ["lists", "kept", "edits", "handover"];
  hearDevices([pc("b", { abilities })]);
  adoptPlayback(
    { device: { id: "pc", name: "PC" }, at: 1, playing: true, positionMs: 40000, track: t("b"), queueId: "q1", place: 1 },
    { id: "q1", from: 0, tracks: songs("a", "b", "c", "d", "c"), entries: ["e1", "e2", "e3", "e4", "e5"], session: "s-pc" }
  );
  try {
    assert.deepEqual(ids(), ["a", "b", "c", "d", "c"]);
    player().removeAt(4);
    assert.deepEqual(sent.at(-1), { action: "editQueue", session: "s-pc", ops: [{ op: "remove", entry: "e5" }], playing: "e2" }, "the second C, by its entry");
    player().moveItem(3, 2);
    assert.deepEqual(sent.at(-1).ops, [{ op: "move", entry: "e4", after: ["e2", "e1"] }]);
    player().addToQueue([t("x")]);
    const word = sent.at(-1);
    assert.equal(word.action, "enqueue");
    assert.equal(word.entries?.length, 1, "the song goes with the id it's to have there");
    await Promise.resolve();
    player().removeAt(ids().indexOf("x"));
    assert.deepEqual(sent.at(-1).ops, [{ op: "remove", entry: word.entries[0] }], "taken out again right away: by that id");
    player().clearUpcoming();
    assert.deepEqual(sent.at(-1).ops, [{ op: "clear" }]);
    assert.equal(sent.some((command) => command.action === "setUpcoming"), false);
  } finally {
    player().takeHere();
    player().stop();
  }
});
test("turning shuffle on and off at a second occurrence preserves the following queue", () => {
  try {
    player().playTracks(songs("a", "x", "b", "x", "c"), 3, "Duplicates", false);
    nativeSays(3);
    assert.equal(now(), "x");
    player().toggleShuffle();
    player().toggleShuffle();
    assert.deepEqual(ids(), ["a", "x", "b", "x", "c"]);
  } finally {
    player().stop();
  }
});
test("independent removals of adjacent copies keep the surviving entry addressable", () => {
  try {
    player().playTracks(songs("a", "x", "x", "b"), 0, "Copies", false);
    nativeSays(0);
    const doc = m.playbackNote({ id: "phone", name: "Phone" }).queue();
    for (const entry of doc.entries.slice(1, 3)) {
      const result = m.runCommand({ action: "editQueue", session: doc.session, playing: doc.entries[0], ops: [{ op: "remove", entry }] });
      assert.equal(result, "done");
    }
    assert.deepEqual(ids(), ["a", "b"]);
  } finally {
    player().stop();
  }
});

/* ------------------------------------------------------------- shuffle with a song in the queue twice (Codex, section 15) */

test("shuffle on and off at the first of two copies: B comes next; started shuffled from the second copy: shuffle off goes on after it", () => {
  try {
    player().playTracks(songs("a", "x", "b", "x", "c"), 1, "Duplicates", false);
    nativeSays(1);
    player().toggleShuffle();
    player().toggleShuffle();
    assert.deepEqual(ids(), ["a", "x", "b", "x", "c"]);
    assert.equal(player().queue[player().index + 1].id, "b");
    player().playTracks(songs("a", "x", "b", "x", "c"), 3, "Duplicates", true);
    nativeSays(0);
    player().toggleShuffle();
    assert.equal(now(), "x");
    assert.deepEqual(ids().slice(player().index + 1), ["c"], "what came after the second copy");
  } finally {
    player().stop();
  }
});

test("the same song object twice in a list (as the library hands it out): shuffle off still finds the copy that plays", () => {
  const x = t("x");
  try {
    player().playTracks([t("a"), x, t("b"), x, t("c")], 3, "One object twice", false);
    nativeSays(3);
    player().toggleShuffle();
    player().toggleShuffle();
    assert.deepEqual(ids(), ["a", "x", "b", "x", "c"]);
    assert.equal(player().queue[player().index + 1].id, "c");
  } finally {
    player().stop();
  }
});

test("starting an overlapping playlist rejects a clear from the previous session", () => {
  try {
    player().playTracks(songs("a", "b", "c"), 0, "First", false);
    nativeSays(0);
    const note = () => m.playbackNote({ id: "phone", name: "Phone" }).queue();
    const old = note();
    player().playTracks(songs("a", "c", "d"), 0, "Second", false);
    nativeSays(0);
    const current = note();
    assert.notEqual(current.session, old.session);
    const clear = (doc) => m.runCommand({ action: "editQueue", session: doc.session, playing: doc.entries[0], ops: [{ op: "clear" }] });
    assert.equal(clear(old), "stale");
    assert.deepEqual(ids(), ["a", "c", "d"]);
    assert.equal(clear(current), "done");
    assert.deepEqual(ids(), ["a"]);
  } finally {
    player().stop();
  }
});

/* ------------------------------------------------------------- copies side by side, a step from an entry, lists from elsewhere (Codex, sections 16 and 17) */

test("two to five copies side by side taken out by their entries in every order (152 in all): each removal done, the ids left the ones not taken out", () => {
  const orders = (list) => (list.length <= 1 ? [list] : list.flatMap((x, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest])));
  let cases = 0;
  try {
    for (let n = 2; n <= 5; n++) {
      // One song object n times over, as the library hands it out.
      const x = t("x");
      for (const order of orders([...Array(n).keys()])) {
        player().playTracks([t("a"), ...Array(n).fill(x), t("b")], 0, "Copies", false);
        nativeSays(0);
        const doc = m.playbackNote({ id: "phone", name: "Phone" }).queue();
        const copies = doc.entries.slice(1, 1 + n);
        let left = [...copies];
        for (const k of order) {
          const result = m.runCommand({ action: "editQueue", session: doc.session, playing: doc.entries[0], ops: [{ op: "remove", entry: copies[k] }] });
          assert.equal(result, "done", `n=${n}, order ${order}`);
          left = left.filter((id) => id !== copies[k]);
          const now = m.playbackNote({ id: "phone", name: "Phone" }).queue().entries;
          assert.deepEqual(now.slice(1, 1 + left.length), left, `the ids left, n=${n}, order ${order}`);
        }
        assert.deepEqual(ids(), ["a", "b"]);
        cases += 1;
      }
    }
  } finally {
    player().stop();
  }
  assert.equal(cases, 152);
});

test("on to the next song from a named entry: the word coming twice goes on once; from another entry, it stays", () => {
  try {
    player().playTracks(songs("a", "b", "c", "d"), 0, "Steps", false);
    nativeSays(0);
    const doc = m.playbackNote({ id: "phone", name: "Phone" }).queue();
    m.runCommand({ action: "next", from: doc.entries[0] });
    nativeSays(1);
    m.runCommand({ action: "next", from: doc.entries[0] });
    assert.equal(now(), "b", "the same word again: still at B");
    m.runCommand({ action: "next", from: doc.entries[1] });
    nativeSays(2);
    assert.equal(now(), "c");
  } finally {
    player().stop();
  }
});

test("a list started from another device is a new list, also when it shares songs with the last one: a late clear of that one finds nothing", () => {
  try {
    player().playTracks(songs("a", "b", "c"), 0, "First", false);
    nativeSays(0);
    const old = m.playbackNote({ id: "phone", name: "Phone" }).queue();
    m.runCommand({ action: "playList", tracks: songs("a", "c", "d"), start: 0, keepOrder: true });
    nativeSays(0);
    const current = m.playbackNote({ id: "phone", name: "Phone" }).queue();
    assert.notEqual(current.session, old.session);
    assert.equal(m.runCommand({ action: "editQueue", session: old.session, playing: old.entries[0], ops: [{ op: "clear" }] }), "stale");
    assert.deepEqual(ids(), ["a", "c", "d"]);
  } finally {
    player().stop();
  }
});
