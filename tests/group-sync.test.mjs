// A group brought together (src/lib/groupSync.ts): devices that start late, seeks that cost time, reports in whole seconds.
// Against stand-ins that keep their own clock, in real time, because what's measured here is time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/groupSync.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
const { GroupSync, readPlace } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

/** A device: plays from `from` since `at`, says where in whole seconds or to the millisecond, a seek costs it some time. */
function device(id, { late = 0, seekCost = 0, wholeSeconds = true, nearby = false, playing = true, rtt = 2 } = {}) {
  const d = {
    id,
    nearby,
    from: 0,
    at: Date.now() + late,
    seeks: [],
    playing,
    exact() {
      return this.from + Math.max(0, Date.now() - this.at) / 1000;
    },
    async place() {
      await new Promise((r) => setTimeout(r, rtt));
      if (!this.playing) return null;
      const now = this.exact();
      return wholeSeconds ? Math.floor(now) : now;
    },
    async seek(sec) {
      this.seeks.push(sec);
      this.from = sec;
      this.at = Date.now() + seekCost;
    },
  };
  return d;
}
const apart = (a, b) => Math.abs(a.exact() - b.exact());

test("reports in whole seconds still tell the place to some hundredths: the moment they turn over, looked for closely", { timeout: 25000 }, async () => {
  const d = device("a", { late: -2300 });
  const r = await readPlace(d);
  assert.ok(Number.isInteger(r.position));
  const off = Math.abs(r.position + (Date.now() - r.at) / 1000 - d.exact());
  assert.ok(off < 0.05, `off by ${off.toFixed(3)} s`);
});

test("exact reports need one look", async () => {
  const d = device("a", { wholeSeconds: false, late: -1234 });
  let asked = 0;
  const place = d.place.bind(d);
  d.place = () => {
    asked += 1;
    return place();
  };
  const r = await readPlace(d);
  assert.equal(asked, 1);
  assert.ok(Math.abs(r.position - d.exact()) < 0.05);
});

test("one not playing, or standing still, gives no place", async () => {
  assert.equal(await readPlace(device("a", { playing: false })), null);
  const still = device("a");
  still.at = Date.now() + 60_000;
  assert.equal(await readPlace(still), null);
});

test("a late device is moved on, and comes out close", { timeout: 40000 }, async () => {
  const first = device("first", { late: -5000 });
  const second = device("second", { late: -3500, seekCost: 400 });
  const sync = new GroupSync();
  assert.ok(apart(first, second) > 1.4, "(1.5 seconds apart)");
  await sync.align([first, second], () => true, 300);
  assert.ok(second.seeks.length >= 1 && second.seeks.length <= 3, String(second.seeks));
  assert.deepEqual(first.seeks, [], "the first one sets the place");
  assert.ok(second.seeks.every(Number.isInteger), "whole seconds, what every device takes");
  assert.ok(apart(first, second) < 0.3, `still ${apart(first, second).toFixed(2)} s apart`);
});

test("what a seek costs a device is learned: the next one needs one try", { timeout: 45000 }, async () => {
  const first = device("first", { late: -6000 });
  const second = device("second", { late: -4000, seekCost: 900 });
  const sync = new GroupSync();
  await sync.align([first, second], () => true, 300);
  assert.ok(apart(first, second) < 0.35, `first time ${apart(first, second).toFixed(2)}`);
  second.seeks.length = 0;
  // Out of step again by something else.
  second.from -= 2;
  await sync.align([first, second], () => true, 300);
  assert.equal(second.seeks.length, 1, String(second.seeks));
  assert.ok(apart(first, second) < 0.35, `second time ${apart(first, second).toFixed(2)}`);
});

test("close enough is left alone: a seek leaves a gap on the device", { timeout: 25000 }, async () => {
  const first = device("first", { late: -4000 });
  const second = device("second", { late: -3850 });
  await new GroupSync().align([first, second], () => true, 300);
  assert.deepEqual(second.seeks, []);
});

test("this phone is put right to a tenth, without whole-second steps", { timeout: 25000 }, async () => {
  const first = device("first", { late: -5000 });
  const phone = device("phone", { late: -5900, wholeSeconds: false, nearby: true, seekCost: 40 });
  await new GroupSync().align([first, phone], () => true, 300);
  assert.ok(phone.seeks.length >= 1);
  assert.ok(apart(first, phone) < 0.15, `still ${apart(first, phone).toFixed(2)} s apart`);
});

test("the first device woke up late: the others aren't thrown back, it catches up with them", { timeout: 35000 }, async () => {
  const receiver = device("receiver", { late: -2000, seekCost: 300 });
  const phone = device("phone", { late: -22000, wholeSeconds: false, nearby: true });
  await new GroupSync().align([receiver, phone], () => true, 300);
  assert.deepEqual(phone.seeks, [], "not back to the start");
  assert.ok(receiver.seeks.length >= 1);
  assert.ok(apart(receiver, phone) < 0.35, `still ${apart(receiver, phone).toFixed(2)} s apart`);
});

test("how much later each starts is remembered for the next song: the slowest gets it first", { timeout: 45000 }, async () => {
  const first = device("first", { late: -4000 });
  const slow = device("slow", { late: -2500 });
  const sync = new GroupSync();
  assert.deepEqual([...sync.startDelays(["first", "slow"])], [["first", 0], ["slow", 0]], "nothing known yet");
  await sync.align([first, slow], () => true, 300, new Map());
  const delays = sync.startDelays(["first", "slow"]);
  assert.equal(delays.get("slow"), 0);
  assert.ok(Math.abs(delays.get("first") - 1500) < 200, `the first waits about 1.5 s: ${delays.get("first")}`);
  // A quick one in the group: the first starts right on time then, and the quick one waits for it.
  const quick = device("quick", { late: -5000 });
  const a = device("first", { late: -4000 });
  const sync2 = new GroupSync();
  await sync2.align([a, quick], () => true, 300, new Map());
  const d2 = sync2.startDelays(["first", "quick"]);
  assert.equal(d2.get("first"), 0);
  assert.ok(Math.abs(d2.get("quick") - 1000) < 200, String(d2.get("quick")));
});

test("what each waited is taken out again when learning", { timeout: 35000 }, async () => {
  // It really is 1.5 s slower; the first was held back that long, so they come out together.
  const first = device("first", { late: -4000 });
  const slow = device("slow", { late: -4000 });
  const sync = new GroupSync();
  await sync.align([first, slow], () => true, 300, new Map([["first", 1500], ["slow", 0]]));
  assert.deepEqual(slow.seeks, [], "together: nothing to do");
  assert.ok(Math.abs(sync.startDelays(["first", "slow"]).get("first") - 1500) < 200, "and it stays at that");
});

test("one waking up says nothing about the next song", { timeout: 35000 }, async () => {
  const first = device("first", { late: -30000 });
  const woke = device("woke", { late: -2000, seekCost: 200 });
  const sync = new GroupSync();
  await sync.align([first, woke], () => true, 300, new Map());
  assert.equal(sync.startDelays(["first", "woke"]).get("first"), 0);
});

test("one set by hand to play ahead ends up that far ahead: it sounds that much later than it says", { timeout: 45000 }, async () => {
  const first = device("first", { late: -5000 });
  const ahead = device("ahead", { late: -4900, seekCost: 300 });
  ahead.offset = 0.3;
  await new GroupSync().align([first, ahead], () => true, 300);
  const by = ahead.exact() - first.exact();
  assert.ok(Math.abs(by - 0.3) < 0.1, `ahead by ${by.toFixed(2)} s`);
  assert.deepEqual(first.seeks, []);
});

test("set to play behind: below zero works the other way", { timeout: 45000 }, async () => {
  const first = device("first", { late: -5000 });
  const behind = device("behind", { late: -5000, seekCost: 200 });
  behind.offset = -0.4;
  await new GroupSync().align([first, behind], () => true, 300);
  const by = first.exact() - behind.exact();
  assert.ok(Math.abs(by - 0.4) < 0.1, `behind by ${by.toFixed(2)} s`);
});

test("once one is set by hand, the group is held closer: 0.2 s off is moved too", { timeout: 45000 }, async () => {
  const first = device("first", { late: -4000 });
  const second = device("second", { late: -3850 });
  second.offset = 0.05;
  await new GroupSync().align([first, second], () => true, 300);
  assert.ok(second.seeks.length >= 1, "moved");
  const by = second.exact() - first.exact();
  assert.ok(Math.abs(by - 0.05) < 0.1, `ahead by ${by.toFixed(2)} s`);
});

test("set back to zero by hand: that look is still a close one, so nothing of the old setting stays", { timeout: 45000 }, async () => {
  const first = device("first", { late: -4000 });
  const second = device("second", { late: -3800 });
  await new GroupSync().align([first, second], () => true, 300, null, true);
  assert.ok(second.seeks.length >= 1, "moved");
  const apartNow = Math.abs(second.exact() - first.exact());
  assert.ok(apartNow < 0.1, `still ${apartNow.toFixed(2)} s apart`);
});

test("the first one set to play ahead: the others go by what's heard from it, and it isn't moved", { timeout: 45000 }, async () => {
  const first = device("first", { late: -5000 });
  first.offset = 0.3;
  const second = device("second", { late: -5000, seekCost: 200 });
  await new GroupSync().align([first, second], () => true, 300);
  const by = first.exact() - second.exact();
  assert.ok(Math.abs(by - 0.3) < 0.1, `the first is ahead by ${by.toFixed(2)} s`);
  assert.deepEqual(first.seeks, []);
});

test("this phone set to play ahead, for a Bluetooth speaker on it: put right to the millisecond", { timeout: 35000 }, async () => {
  const first = device("first", { late: -5000 });
  const phone = device("phone", { late: -5000, wholeSeconds: false, nearby: true, seekCost: 40 });
  phone.offset = 0.2;
  await new GroupSync().align([first, phone], () => true, 300);
  const by = phone.exact() - first.exact();
  // A tenth, as everywhere here: with every test file running at once the clock itself wobbles that much.
  assert.ok(Math.abs(by - 0.2) < 0.1, `ahead by ${by.toFixed(2)} s`);
});

test("not at the very end of a song", { timeout: 25000 }, async () => {
  const first = device("first", { late: -5000 });
  const second = device("second", { late: -3000 });
  await new GroupSync().align([first, second], () => true, 6);
  assert.deepEqual(second.seeks, []);
});

test("somebody doing something else in between: it stops at once", { timeout: 25000 }, async () => {
  const first = device("first", { late: -5000 });
  const second = device("second", { late: -3000 });
  await new GroupSync().align([first, second], () => false, 300);
  assert.deepEqual(second.seeks, []);
});

test("one that isn't playing is left out of it", { timeout: 25000 }, async () => {
  const first = device("first", { late: -5000 });
  const paused = device("paused", { playing: false });
  await new GroupSync().align([first, paused], () => true, 300);
  assert.deepEqual(paused.seeks, []);
});

test("a device that can't seek doesn't stop the others", { timeout: 35000 }, async () => {
  const first = device("first", { late: -5000 });
  const stubborn = device("stubborn", { late: -3000 });
  stubborn.seek = async () => {
    throw new Error("Not now");
  };
  const third = device("third", { late: -3000 });
  await new GroupSync().align([first, stubborn, third], () => true, 300);
  assert.ok(third.seeks.length >= 1);
});
