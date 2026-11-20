// The computer's queue (src/stores/player.ts): shuffle orders what's coming, so Previous finds the
// song that was heard; one way to queue, first come, first played; a branch that can be taken back;
// and while another device is followed, what's asked here goes there.
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const stores = fileURLToPath(new URL("../src/stores/", import.meta.url));
const stub = (contents) => ({ contents, resolveDir: stores, loader: "ts" });
const out = await build({
  stdin: { contents: `export { usePlayer, setSteering, setQueueRanOut } from "./player"; export { useMuted } from "./muted"; export { useSettings } from "./settings";`, resolveDir: stores, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onLoad({ filter: /[\\/]lib[\\/]persist\.ts$/ }, () =>
          stub(`export const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }; export const lazyJSONStorage = () => ({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined });`)
        );
        b.onLoad({ filter: /[\\/]stores[\\/]catalog\.ts$/ }, () => stub(`export const songKey = (id) => id; export const versionsOf = (t) => [t];`));
      },
    },
  ],
});
const { usePlayer, setSteering, setQueueRanOut, useSettings } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const t = (id) => ({ id, title: id.toUpperCase(), artist: "Band", duration: 100, thumb: "" });
const songs = (...names) => names.map(t);
const ids = () => usePlayer.getState().queue.map((x) => x.id);
const now = () => usePlayer.getState().queue[usePlayer.getState().index]?.id;
const LIST = songs("a", "b", "c", "d", "e", "f", "g", "h");

beforeEach(() => {
  setSteering(null);
  usePlayer.getState().clearUpcoming();
  usePlayer.setState({ queue: [], index: 0, shuffle: false, repeat: "off", playing: false, position: 0, unshuffled: null, lineEnd: 0, branches: [], remoteVolume: null, volume: 0.8, muted: false });
});

test("shuffled, the queue itself is the order: what's on screen is what plays", () => {
  usePlayer.setState({ shuffle: true });
  usePlayer.getState().playQueue(LIST, 2);
  const order = ids();
  assert.equal(now(), "c", "the asked-for song first");
  assert.equal(usePlayer.getState().index, 0);
  assert.deepEqual([...order].sort(), LIST.map((s) => s.id));
  usePlayer.getState().next(true);
  assert.equal(now(), order[1]);
  usePlayer.getState().next(true);
  assert.equal(now(), order[2]);
});

test("Previous, shuffled: the song that was heard before, and Next again the song it came from", () => {
  usePlayer.setState({ shuffle: true });
  usePlayer.getState().playQueue(LIST, 0);
  const heard = [now()];
  for (let i = 0; i < 4; i++) {
    usePlayer.getState().next(true);
    heard.push(now());
  }
  for (let i = 3; i >= 0; i--) {
    usePlayer.setState({ position: 0 });
    usePlayer.getState().prev();
    assert.equal(now(), heard[i], "back through what was really heard");
  }
  usePlayer.getState().next(true);
  assert.equal(now(), heard[1], "random only forward, and the same way again");
});

test("shuffle turned on keeps what was heard and mixes what's coming; off brings the list's order back", () => {
  usePlayer.getState().playQueue(LIST, 2);
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(ids().slice(0, 3), ["a", "b", "c"]);
  assert.deepEqual([...ids().slice(3)].sort(), ["d", "e", "f", "g", "h"]);
  usePlayer.getState().prev();
  assert.equal(now(), "b", "back as before");
  usePlayer.getState().next(true);
  assert.equal(now(), "c");
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(ids(), ["a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.equal(usePlayer.getState().unshuffled, null);
});

test("a jump further down a shuffled queue: what it jumped stays to come, and Previous finds the song that was on", () => {
  usePlayer.setState({ shuffle: true });
  usePlayer.getState().playQueue(LIST, 0);
  const order = ids();
  usePlayer.getState().jumpTo(4);
  assert.equal(now(), order[4]);
  assert.deepEqual(ids().slice(2), [order[1], order[2], order[3], ...order.slice(5)]);
  usePlayer.getState().prev();
  assert.equal(now(), order[0]);
});

test("at the very start Previous starts the song over, and only Repeat goes round", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c"), 0);
  const nonce = usePlayer.getState().seekNonce;
  usePlayer.getState().prev();
  assert.equal(now(), "a");
  assert.equal(usePlayer.getState().seekNonce, nonce + 1);
  usePlayer.setState({ repeat: "all" });
  usePlayer.getState().prev();
  assert.equal(now(), "c");
});

test("one way to queue: right behind the playing song, first come, first played", () => {
  usePlayer.getState().playQueue(LIST, 0);
  assert.equal(usePlayer.getState().addToQueue(t("x")), 1);
  assert.equal(usePlayer.getState().addToQueue(t("y")), 2);
  assert.equal(usePlayer.getState().addToQueue([t("z")]), 3);
  assert.deepEqual(ids().slice(0, 5), ["a", "x", "y", "z", "b"]);
  usePlayer.getState().next(true);
  assert.equal(now(), "x");
  assert.equal(usePlayer.getState().addToQueue(t("v")), 3, "two still ahead of it");
  assert.deepEqual(ids().slice(1, 6), ["x", "y", "z", "v", "b"]);
});

test("a song further down comes up instead of playing twice; one in the line stays where it is", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c", "d"), 0);
  usePlayer.getState().addToQueue(t("d"));
  assert.deepEqual(ids(), ["a", "d", "b", "c"]);
  usePlayer.getState().addToQueue(t("c"));
  assert.deepEqual(ids(), ["a", "d", "c", "b"]);
  usePlayer.getState().addToQueue(t("d"));
  assert.deepEqual(ids(), ["a", "d", "c", "b"]);
});

test("what was asked to come next stays next when shuffle changes", () => {
  usePlayer.getState().playQueue(LIST, 0);
  usePlayer.getState().addToQueue(t("h"));
  usePlayer.getState().toggleShuffle();
  assert.equal(ids()[1], "h");
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(ids(), ["a", "h", "b", "c", "d", "e", "f", "g"]);
});

test("Branch off behind what was asked for, and taking it back brings back what was coming", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c"), 0);
  usePlayer.getState().addToQueue(t("q"));
  usePlayer.getState().branchOff(songs("x", "y", "b"), "Mix");
  assert.deepEqual(ids(), ["a", "q", "x", "y", "b", "c"]);
  assert.deepEqual(usePlayer.getState().branches, [{ name: "Mix", trackId: "x", started: false, ids: ["x", "y", "b"] }]);
  assert.ok(usePlayer.getState().branchFrom("x", "Mix"));
  assert.equal(usePlayer.getState().branchFrom("x", "Other"), undefined);
  assert.equal(usePlayer.getState().branchFrom("y", "Mix"), undefined);
  usePlayer.getState().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "q", "b", "c"]);
  assert.deepEqual(usePlayer.getState().branches, []);
});

test("first come, first played: what's asked for next goes behind the whole branch, and so does the next branch", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c"), 0);
  usePlayer.getState().branchOff(songs("x", "y"), "Mix");
  usePlayer.getState().addToQueue(t("q"));
  assert.deepEqual(ids(), ["a", "x", "y", "q", "b", "c"]);
  usePlayer.getState().branchOff(songs("r", "s"), "Other");
  assert.deepEqual(ids(), ["a", "x", "y", "q", "r", "s", "b", "c"]);
  usePlayer.getState().addToQueue(t("n"));
  assert.deepEqual(ids(), ["a", "x", "y", "q", "r", "s", "n", "b", "c"]);
  assert.equal(usePlayer.getState().lineEnd, 7);
});

test("each branch goes back by itself; the rest of the line stays as it is", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c"), 0);
  usePlayer.getState().branchOff(songs("x", "y", "b"), "Mix");
  usePlayer.getState().addToQueue(t("q"));
  usePlayer.getState().branchOff(songs("r", "s"), "Other");
  assert.deepEqual(ids(), ["a", "x", "y", "b", "q", "r", "s", "c"]);
  usePlayer.getState().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "q", "r", "s", "b", "c"], "b is back where it was");
  assert.equal(usePlayer.getState().lineEnd, 4);
  assert.deepEqual(usePlayer.getState().branches.map((b) => b.name), ["Other"]);
  usePlayer.getState().cancelBranch("Other");
  assert.deepEqual(ids(), ["a", "q", "b", "c"]);
});

test("a song belongs to the newest branch that brings it", () => {
  usePlayer.getState().playQueue(songs("a", "b"), 0);
  usePlayer.getState().branchOff(songs("x", "y"), "Mix");
  usePlayer.getState().branchOff(songs("y", "z"), "Other");
  assert.deepEqual(ids(), ["a", "x", "y", "z", "b"]);
  usePlayer.getState().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "y", "z", "b"], "y stays with the branch that still has it");
});

test("a song taken out stays out: also when shuffle goes off or a branch goes back", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c"), 0);
  usePlayer.getState().branchOff(songs("x", "y"), "Mix");
  usePlayer.getState().removeAt(1);
  assert.deepEqual(ids(), ["a", "y", "b", "c"]);
  assert.equal(usePlayer.getState().branches[0].trackId, "y", "the mark goes to the next song of the branch");
  usePlayer.getState().removeAt(2);
  usePlayer.getState().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "c"], "b was taken out by hand");
  usePlayer.setState({ shuffle: false });
  usePlayer.getState().playQueue(songs("a", "b", "c", "d"), 0);
  usePlayer.getState().toggleShuffle();
  usePlayer.getState().removeAt(usePlayer.getState().queue.findIndex((s) => s.id === "c"));
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(ids(), ["a", "b", "d"]);
});

test("only what was asked for by hand goes, and the list stays", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c"), 0);
  usePlayer.getState().addToQueue(t("q"));
  usePlayer.getState().branchOff(songs("x", "b"), "Mix");
  assert.deepEqual(ids(), ["a", "q", "x", "b", "c"]);
  usePlayer.getState().clearLine();
  assert.deepEqual(ids(), ["a", "b", "c"]);
  assert.deepEqual(usePlayer.getState().branches, []);
  assert.equal(usePlayer.getState().lineEnd, 0);
});

test("a song of the branch that was asked for already plays with the branch, once", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c"), 0);
  usePlayer.getState().addToQueue(t("y"));
  usePlayer.getState().addToQueue(t("q"));
  usePlayer.getState().branchOff(songs("x", "y"), "Mix");
  assert.deepEqual(ids(), ["a", "q", "x", "y", "b", "c"]);
  usePlayer.getState().addToQueue(t("n"));
  assert.deepEqual(ids(), ["a", "q", "x", "y", "n", "b", "c"]);
});

test("asked for by hand, a song leaves the branch it was in", () => {
  usePlayer.getState().playQueue(songs("a", "b"), 0);
  usePlayer.getState().branchOff(songs("x", "y"), "Mix");
  usePlayer.getState().removeAt(2);
  usePlayer.getState().addToQueue(t("y"));
  assert.deepEqual(ids(), ["a", "x", "y", "b"]);
  assert.deepEqual(usePlayer.getState().branches[0].ids, ["x"]);
  usePlayer.getState().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "y", "b"]);
});

test("another song of the same list: the branch starts there instead", () => {
  usePlayer.getState().playQueue(songs("a", "b"), 0);
  usePlayer.getState().branchOff(songs("x", "y", "z"), "Mix");
  usePlayer.getState().branchOff(songs("y", "z"), "Mix");
  assert.deepEqual(ids(), ["a", "y", "z", "b"]);
  assert.equal(usePlayer.getState().branches.length, 1);
  assert.equal(usePlayer.getState().branches[0].trackId, "y");
  usePlayer.getState().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "b"]);
});

test("the mark goes when the chosen song comes on; taking back still works until the branch is through", () => {
  usePlayer.getState().playQueue(songs("a", "b"), 0);
  usePlayer.getState().branchOff(songs("x", "y"), "Mix");
  usePlayer.getState().next(true);
  assert.equal(usePlayer.getState().branches[0].started, true);
  assert.ok(usePlayer.getState().branchFrom("x", "Mix"));
  usePlayer.getState().cancelBranch("Mix");
  assert.deepEqual(ids(), ["a", "x", "b"]);
  usePlayer.getState().branchOff(songs("y"), "One");
  usePlayer.getState().next(true);
  usePlayer.getState().next(true);
  assert.equal(now(), "b");
  assert.deepEqual(usePlayer.getState().branches, [], "through: nothing left to take back");
});

test("back before a branch's first song, it's chosen again", () => {
  usePlayer.getState().playQueue(songs("a", "b"), 0);
  usePlayer.getState().branchOff(songs("x", "y"), "Mix");
  usePlayer.getState().next(true);
  assert.equal(usePlayer.getState().branches[0].started, true);
  usePlayer.getState().prev();
  assert.equal(now(), "a");
  assert.equal(usePlayer.getState().branches[0].started, false);
});

test("jumped over its first song, a branch starts from the song that's on", () => {
  usePlayer.getState().playQueue(songs("a", "b"), 0);
  usePlayer.getState().branchOff(songs("x", "y", "z"), "Mix");
  usePlayer.getState().jumpTo(2);
  assert.equal(now(), "y");
  assert.equal(usePlayer.getState().branches[0].trackId, "y");
  assert.equal(usePlayer.getState().branches[0].started, true);
});

test("while a device is followed, what's asked here goes there", () => {
  const said = [];
  const say = (name) => (...args) => said.push([name, ...args]);
  setSteering({
    play: say("play"),
    upcoming: say("upcoming"),
    add: say("add"),
    jump: say("jump"),
    branchOff: say("branchOff"),
    cancelBranch: say("cancelBranch"),
    shuffle: say("shuffle"),
    repeat: say("repeat"),
    next: say("next"),
    previous: say("previous"),
    volume: say("volume"),
  });
  usePlayer.setState({ queue: songs("a", "b", "c"), index: 0, playing: true, remoteVolume: 0.5 });
  usePlayer.getState().playQueue(songs("x", "y"), 1);
  assert.deepEqual(said.at(-1)[0], "play");
  assert.equal(said.at(-1)[2], 1);
  assert.deepEqual(ids(), ["a", "b", "c"], "the device playing decides; the screen follows its word");
  usePlayer.getState().addToQueue(t("n"));
  assert.equal(said.at(-1)[0], "add");
  assert.deepEqual(ids(), ["a", "n", "b", "c"], "and it shows here at once");
  usePlayer.getState().next(true);
  assert.equal(said.at(-1)[0], "next");
  usePlayer.getState().prev();
  assert.equal(said.at(-1)[0], "previous");
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(said.at(-1), ["shuffle", true]);
  usePlayer.getState().cycleRepeat();
  assert.deepEqual(said.at(-1), ["repeat", "all"]);
  usePlayer.getState().setVolume(0.25);
  assert.deepEqual(said.at(-1), ["volume", 0.25]);
  assert.equal(usePlayer.getState().volume, 0.8, "this computer's own volume stays");
  usePlayer.getState().toggleMute();
  assert.deepEqual(said.at(-1), ["volume", 0]);
  usePlayer.getState().toggleMute();
  assert.deepEqual(said.at(-1), ["volume", 0.25]);
  usePlayer.getState().removeAt(1);
  assert.deepEqual(said.at(-1)[0], "upcoming");
  assert.deepEqual(said.at(-1)[1].map((s) => s.id), ["b", "c"]);
  usePlayer.getState().branchOff(songs("r", "s"), "Mix");
  assert.equal(said.at(-1)[0], "branchOff");
  assert.ok(usePlayer.getState().branchFrom("r", "Mix"));
  assert.deepEqual(ids(), ["a", "r", "s", "b", "c"], "shows here at once");
  usePlayer.getState().branchOff(songs("s"), "Mix");
  assert.equal(said.filter((w) => w[0] === "cancelBranch").length, 0, "the device starts its branch anew by itself");
  usePlayer.getState().cancelBranch("Mix");
  assert.deepEqual(said.at(-1), ["cancelBranch", "Mix"]);
  assert.deepEqual(ids(), ["a", "b", "c"]);
});

/* ------------------------------------------------------------- skipping away from repeat-one */

function onRepeatOne() {
  useSettings.setState({ skipEndsRepeatOne: true });
  usePlayer.setState({ queue: LIST, index: 1, repeat: "one", playing: true, position: 40 });
}

test("repeat-one ends with a skip: Next, Previous, a song of the queue", () => {
  onRepeatOne();
  usePlayer.getState().next(true);
  assert.equal(now(), "c");
  assert.equal(usePlayer.getState().repeat, "all");

  onRepeatOne();
  usePlayer.setState({ position: 1 });
  usePlayer.getState().prev();
  assert.equal(now(), "a");
  assert.equal(usePlayer.getState().repeat, "all");

  onRepeatOne();
  usePlayer.getState().jumpTo(4);
  assert.equal(now(), "e");
  assert.equal(usePlayer.getState().repeat, "all");
});

test("repeat-one stays when the song stays: Previous well into it, the queue going on by itself, a queue of one", () => {
  onRepeatOne();
  usePlayer.getState().prev();
  assert.equal(now(), "b", "from the top");
  assert.equal(usePlayer.getState().repeat, "one");

  onRepeatOne();
  usePlayer.getState().next(false);
  assert.equal(usePlayer.getState().repeat, "one", "a song that couldn't play isn't somebody skipping");

  usePlayer.setState({ queue: songs("a"), index: 0, repeat: "one", playing: true });
  usePlayer.getState().next(true);
  assert.equal(usePlayer.getState().repeat, "one", "round to the very same song");
});

test("with the setting off, repeat-one stays when skipping", () => {
  onRepeatOne();
  useSettings.setState({ skipEndsRepeatOne: false });
  usePlayer.getState().next(true);
  assert.equal(now(), "c");
  assert.equal(usePlayer.getState().repeat, "one");
  useSettings.setState({ skipEndsRepeatOne: true });
});

test("a new song or list while something plays is another song too; with nothing on, repeat-one is left alone", () => {
  onRepeatOne();
  usePlayer.getState().playQueue(songs("x", "y"), 0);
  assert.equal(usePlayer.getState().repeat, "all");

  onRepeatOne();
  usePlayer.getState().playTrack(t("x"));
  assert.equal(usePlayer.getState().repeat, "all");

  onRepeatOne();
  usePlayer.getState().playQueue(LIST, 1);
  assert.equal(usePlayer.getState().repeat, "one", "the very song that's on");

  onRepeatOne();
  usePlayer.setState({ playing: false });
  usePlayer.getState().playQueue(songs("x", "y"), 0);
  assert.equal(usePlayer.getState().repeat, "one", "turned on first, then the song");
});

test("while a device is followed the skip goes there, and that device says what became of repeat", () => {
  onRepeatOne();
  const asked = [];
  setSteering({ next: () => asked.push("next"), previous: () => asked.push("previous"), jump: () => asked.push("jump") });
  usePlayer.getState().next(true);
  usePlayer.getState().prev();
  usePlayer.getState().jumpTo(3);
  assert.deepEqual(asked, ["next", "previous", "jump"]);
  assert.equal(usePlayer.getState().repeat, "one");
});

test("Next past the last song: round to the start, or with Autoplay on, what the queue's end does", () => {
  const ran = [];
  setQueueRanOut(() => ran.push("autoplay"));
  usePlayer.setState({ queue: songs("a", "b"), index: 1, playing: true });
  usePlayer.getState().next(true);
  assert.equal(now(), "a");
  assert.deepEqual(ran, []);

  useSettings.setState({ autoplay: true });
  try {
    usePlayer.setState({ queue: songs("a", "b"), index: 1, playing: true, repeat: "off" });
    usePlayer.getState().next(true);
    assert.deepEqual(ran, ["autoplay"]);
    assert.equal(now(), "b");

    usePlayer.setState({ repeat: "all" });
    usePlayer.getState().next(true);
    assert.equal(now(), "a", "Repeat goes round");
    assert.deepEqual(ran, ["autoplay"]);

    useSettings.setState({ skipEndsRepeatOne: true });
    usePlayer.setState({ queue: songs("a", "b"), index: 1, repeat: "one" });
    usePlayer.getState().next(true);
    assert.equal(now(), "a", "repeat-one turned into going round the list");
    assert.equal(usePlayer.getState().repeat, "all");
    assert.deepEqual(ran, ["autoplay"]);

    useSettings.setState({ skipEndsRepeatOne: false });
    usePlayer.setState({ queue: songs("a", "b"), index: 1, repeat: "one" });
    usePlayer.getState().next(true);
    assert.deepEqual(ran, ["autoplay", "autoplay"]);
  } finally {
    useSettings.setState({ autoplay: false, skipEndsRepeatOne: true });
    setQueueRanOut(null);
  }
});

test("the song on screen taken out: the next one starts from its top", () => {
  usePlayer.setState({ queue: LIST, index: 1, playing: true, position: 40 });
  usePlayer.getState().removeAt(1);
  assert.equal(now(), "c");
  assert.equal(usePlayer.getState().position, 0);
});

test("an older save, shuffled: its order is mixed once, and it's the queue from then on", async () => {
  const { migrate } = usePlayer.persist.getOptions();
  const old = { queue: LIST, index: 2, shuffle: true, volume: 0.5 };
  const moved = migrate(old, 1);
  assert.deepEqual(moved.queue.slice(0, 3).map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual([...moved.queue.slice(3).map((s) => s.id)].sort(), ["d", "e", "f", "g", "h"]);
  assert.deepEqual(moved.unshuffled.map((s) => s.id), LIST.map((s) => s.id));
  const plain = migrate({ queue: LIST, index: 2, shuffle: false, volume: 0.5 }, 1);
  assert.deepEqual(plain.queue.map((s) => s.id), LIST.map((s) => s.id));
});

/* ------------------------------------------------------------- Codex's review, 2026-11-20 */

const inside = () => {
  const { queue, index } = usePlayer.getState();
  assert.ok(!queue.length || (index >= 0 && index < queue.length), `index ${index} inside a queue of ${queue.length}`);
};

test("a single song with nothing queued: a queue of one that plays it, also after the last song was taken out", () => {
  usePlayer.getState().playTrack(t("x"));
  inside();
  assert.deepEqual(ids(), ["x"]);
  assert.equal(usePlayer.getState().current()?.id, "x", "the song on screen is the song that plays");
  assert.equal(usePlayer.getState().playing, true);
  usePlayer.getState().removeAt(0);
  assert.deepEqual(ids(), []);
  usePlayer.getState().playTrack(t("y"));
  inside();
  assert.equal(usePlayer.getState().current()?.id, "y");
  usePlayer.getState().playTrack(t("z"));
  inside();
  assert.deepEqual(ids(), ["y", "z"], "with a song on, the next one comes after it as before");
  assert.equal(now(), "z");
});

test("cleared with shuffle on: shuffle off brings none of it back, nor what was asked for by hand and cleared", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c"), 0);
  usePlayer.getState().toggleShuffle();
  usePlayer.getState().clearUpcoming();
  assert.deepEqual(ids(), ["a"]);
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(ids(), ["a"], "only what was there");

  usePlayer.getState().playQueue(songs("a", "b", "c", "d"), 0);
  usePlayer.getState().toggleShuffle();
  usePlayer.getState().addToQueue(t("x"));
  usePlayer.getState().clearLine();
  assert.equal(ids().indexOf("x"), -1);
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(ids(), ["a", "b", "c", "d"], "the list's own order, without what was asked for");
});

test("cleared further on with a song in the queue twice: what was heard stays, and shuffle off adds nothing", () => {
  usePlayer.setState({ shuffle: true });
  usePlayer.getState().playQueue(LIST, 0);
  usePlayer.getState().next(true);
  usePlayer.getState().next(true);
  const heard = ids().slice(0, 3);
  usePlayer.getState().addToQueue(t("a"));
  assert.equal(ids().filter((x) => x === "a").length, 2, "the first song again, by hand");
  usePlayer.getState().clearUpcoming();
  assert.deepEqual(ids(), heard);
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(ids(), heard);
  assert.equal(now(), heard[2]);
});

test("edited on another device with shuffle on: what it took out stays out here too, and cleared there is cleared here", () => {
  usePlayer.getState().playQueue(songs("a", "b", "c", "d"), 0);
  usePlayer.getState().toggleShuffle();
  usePlayer.getState().replaceUpcoming(ids().slice(1).filter((x) => x !== "c").map(t), 0);
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(ids(), ["a", "b", "d"], "the list's own order, without what was taken out there");

  usePlayer.getState().toggleShuffle();
  usePlayer.getState().branchOff(songs("r", "s"), "Mix");
  usePlayer.getState().replaceUpcoming([], 0);
  assert.deepEqual(ids(), ["a"]);
  assert.deepEqual(usePlayer.getState().branches, [], "no branch left of what went");
  usePlayer.getState().toggleShuffle();
  assert.deepEqual(ids(), ["a"], "shuffle off brings none of it back");
});

test("cleared while a device is followed: all of that queue goes, also what this computer never saw of it", () => {
  const said = [];
  const quiet = () => undefined;
  setSteering({
    play: quiet, add: quiet, jump: quiet, branchOff: quiet, cancelBranch: quiet, shuffle: quiet, repeat: quiet, next: quiet, previous: quiet, volume: quiet,
    upcoming: (tracks, all) => said.push([tracks.map((s) => s.id), all]),
  });
  usePlayer.setState({ queue: songs("a", "b", "c"), index: 0, playing: true });
  usePlayer.getState().removeAt(1);
  assert.deepEqual(said.at(-1), [["c"], undefined], "an edit: what comes after stays there");
  usePlayer.getState().clearUpcoming();
  assert.deepEqual(said.at(-1), [[], true]);
});
