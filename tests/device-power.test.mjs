// Devices going off when the music has left them (src/lib/devicePower.ts): half a minute later,
// unless somebody says otherwise, it plays again, or it has moved on to something else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/devicePower.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { OWN_INPUT, RECEIVER_INPUTS, SWITCH_OFF_AFTER_MS, SwitchOffs, bringToInput, canSwitchOff, inputCode, inputName, isNetworkInput, linksToFollow, looksLikeTv, parsePower, readPower, receiverInUse, sendToReceiver, switchOffAt, wentOffToo } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function setUp(t, { power = { on: true, input: "NET" } } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const world = { power, inUse: false, offs: [], changes: [], told: [] };
  const offs = new SwitchOffs({
    readPower: async () => world.power,
    switchOff: async (id) => {
      world.offs.push(id);
      return true;
    },
    inUse: () => world.inUse,
    changed: (pending) => world.changes.push(pending.map((d) => d.id)),
    counting: (device) => world.told.push(device),
  });
  const pass = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  return { world, offs, pass };
}

test("only brands with a way of being switched off", () => {
  for (const yes of ["Denon AVR-X1800H", "denon Home 150", "Marantz SR6015"]) assert.equal(canSwitchOff(yes), true, yes);
  for (const no of ["", "Sonos One", "Yamaha R-N303", "FRITZ!Box 5530", "Denonish Box"]) assert.equal(canSwitchOff(no), false, no);
});

test("what a device's status page says", () => {
  assert.deepEqual(parsePower("<item><Power><value>ON</value></Power><InputFuncSelect><value>NET</value></InputFuncSelect></item>"), { on: true, input: "NET" });
  assert.deepEqual(parsePower("<item><Power><value>OFF</value></Power><InputFuncSelect><value>TV</value></InputFuncSelect></item>"), { on: false, input: "TV" });
  assert.deepEqual(parsePower("<Power> <value> ON </value></Power>"), { on: true, input: "" });
  assert.equal(parsePower("<html>Not a receiver</html>"), null);
  assert.equal(parsePower(""), null);
});

test("only a device on the home network is asked anything", async (t) => {
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    asked.push(url);
    return new Response(url.includes("Status") ? "<Power><value>ON</value></Power><InputFuncSelect><value>NET</value></InputFuncSelect>" : "");
  });
  assert.equal(await readPower("8.8.8.8"), null);
  assert.equal(await switchOffAt("example.com"), false);
  assert.deepEqual(asked, []);
  assert.deepEqual(await readPower("192.168.1.40"), { on: true, input: "NET" });
  assert.equal(await switchOffAt("192.168.1.40"), true);
  assert.deepEqual(asked, ["http://192.168.1.40:8080/goform/formMainZone_MainZoneXmlStatusLite.xml", "http://192.168.1.40:8080/goform/formiPhoneAppDirect.xml?PWSTANDBY"]);
});

test("a device that doesn't answer is just not switched off", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("nobody home");
  });
  assert.equal(await readPower("192.168.1.40"), null);
  assert.equal(await switchOffAt("192.168.1.40"), false);
});

test("half a minute after the music left, it goes off, and somebody hears of it first", async (t) => {
  const { world, offs, pass } = setUp(t);
  await offs.left("denon", "Receiver");
  assert.deepEqual(offs.pending, [{ id: "denon", name: "Receiver", at: 1_000_000 + SWITCH_OFF_AFTER_MS }]);
  assert.deepEqual(world.told.map((d) => d.id), ["denon"]);
  await pass(SWITCH_OFF_AFTER_MS - 1);
  assert.deepEqual(world.offs, []);
  await pass(1);
  assert.deepEqual(world.offs, ["denon"]);
  assert.deepEqual(offs.pending, []);
  assert.deepEqual(world.changes, [["denon"], []]);
});

test("told twice, it counts once", async (t) => {
  const { world, offs, pass } = setUp(t);
  await offs.left("denon", "Receiver");
  await pass(10_000);
  await offs.left("denon", "Receiver");
  assert.equal(world.told.length, 1);
  await pass(SWITCH_OFF_AFTER_MS - 10_000);
  assert.deepEqual(world.offs, ["denon"]);
});

test("left on when somebody says so", async (t) => {
  const { world, offs, pass } = setUp(t);
  await offs.left("denon", "Receiver");
  offs.forget("denon");
  await pass(SWITCH_OFF_AFTER_MS * 2);
  assert.deepEqual(world.offs, []);
  assert.deepEqual(offs.pending, []);
});

test("left on when it plays again by then", async (t) => {
  const { world, offs, pass } = setUp(t);
  await offs.left("denon", "Receiver");
  world.inUse = true;
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, []);
});

test("left on when it was switched over to something else in between", async (t) => {
  const { world, offs, pass } = setUp(t);
  await offs.left("denon", "Receiver");
  world.power = { on: true, input: "TV" };
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, []);
});

test("no count at all while it's on something else already", async (t) => {
  const { world, offs, pass } = setUp(t, { power: { on: true, input: "SAT/CBL" } });
  await offs.left("denon", "Receiver");
  assert.deepEqual(offs.pending, []);
  await pass(SWITCH_OFF_AFTER_MS * 3);
  assert.deepEqual(world.offs, []);
  assert.deepEqual(world.told, []);
});

test("no count for one that doesn't say how it stands", async (t) => {
  const { world, offs, pass } = setUp(t, { power: null });
  await offs.left("denon", "Receiver");
  await pass(SWITCH_OFF_AFTER_MS * 3);
  assert.deepEqual(offs.pending, []);
  assert.deepEqual(world.offs, []);
});

test("still on its way up when told: one more look, then it counts", async (t) => {
  const { world, offs, pass } = setUp(t, { power: { on: false, input: "NET" } });
  await offs.left("denon", "Receiver");
  assert.deepEqual(offs.pending, []);
  world.power = { on: true, input: "NET" };
  await pass(25_000);
  assert.deepEqual(offs.pending.map((d) => d.id), ["denon"]);
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, ["denon"]);
});

test("off and staying off: left alone", async (t) => {
  const { world, offs, pass } = setUp(t, { power: { on: false, input: "NET" } });
  await offs.left("denon", "Receiver");
  await pass(25_000);
  await pass(SWITCH_OFF_AFTER_MS * 2);
  assert.deepEqual(offs.pending, []);
  assert.deepEqual(world.offs, []);
});

test("by hand: right away, and its music going away after that starts no count", async (t) => {
  const { world, offs, pass } = setUp(t);
  await offs.left("denon", "Receiver");
  assert.equal(await offs.switchOffNow("denon"), true);
  assert.deepEqual(world.offs, ["denon"]);
  assert.deepEqual(offs.pending, []);
  await offs.left("denon", "Receiver");
  assert.deepEqual(offs.pending, []);
  await pass(SWITCH_OFF_AFTER_MS * 2);
  assert.deepEqual(world.offs, ["denon"], "once");
  // Later on it's a device like any other again.
  await offs.left("denon", "Receiver");
  assert.deepEqual(offs.pending.map((d) => d.id), ["denon"]);
});

test("from who's playing now and who was before: the ones that left count, the ones that came back don't", async (t) => {
  const { world, offs, pass } = setUp(t);
  const names = { denon: { name: "Receiver", canSwitchOff: true }, sonos: { name: "Kitchen", canSwitchOff: false } };
  const nameOf = (id) => names[id] ?? null;
  offs.sawDevices(new Set(), new Set(["denon", "sonos", "gone"]), nameOf);
  await flush();
  assert.deepEqual(offs.pending.map((d) => d.id), ["denon"]);
  await pass(10_000);
  offs.sawDevices(new Set(["denon"]), new Set(), nameOf);
  assert.deepEqual(offs.pending, []);
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, []);
});

test("only the words a receiver should hear go out, and only on the home network", async (t) => {
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    asked.push(url);
    return new Response("");
  });
  assert.equal(await sendToReceiver("192.168.1.40", "SISAT/CBL"), true);
  assert.equal(await sendToReceiver("192.168.1.40", "PWON"), true);
  assert.deepEqual(asked, ["http://192.168.1.40:8080/goform/formiPhoneAppDirect.xml?SISAT/CBL", "http://192.168.1.40:8080/goform/formiPhoneAppDirect.xml?PWON"]);
  asked.length = 0;
  for (const word of ["", "SI", "MV99", "PWSTANDBY&x=1", "SIMPLAY?x", "SI../../x y", "NSH"]) assert.equal(await sendToReceiver("192.168.1.40", word), false, word);
  assert.equal(await sendToReceiver("8.8.8.8", "PWON"), false);
  assert.deepEqual(asked, []);
});

test("an input goes by the receiver's word, whatever it calls it on the display", () => {
  assert.equal(inputCode("Media Player"), "MPLAY");
  assert.equal(inputCode("mplay"), "MPLAY");
  assert.equal(inputCode("CBL/SAT"), "SAT/CBL");
  assert.equal(inputCode("HEOS Music"), "NET");
  assert.equal(inputCode(" AUX1 "), "AUX1");
  assert.equal(inputName("MPLAY"), "Media Player");
  assert.equal(inputName("SAT/CBL"), "CBL/SAT");
  assert.equal(inputName("PHONO"), "PHONO", "one it doesn't know keeps its word");
  for (const i of RECEIVER_INPUTS) assert.equal(inputCode(i.name), i.code, i.name);
});

function fakeReceiver(state) {
  const sent = [];
  return {
    sent,
    state,
    read: async () => (state.gone ? null : { on: state.on, input: state.input }),
    send: async (word) => {
      sent.push(word);
      if (word === "PWON") state.on = true;
      else if (state.on && !state.deaf) state.input = word.slice(2);
      return true;
    },
  };
}
/** Lets its waiting go by: the mocked clock needs the promises in between to have run. */
async function runOut(t, promise) {
  let done = false;
  let result;
  void promise.then((v) => {
    done = true;
    result = v;
  });
  for (let i = 0; i < 40 && !done; i++) {
    await flush();
    t.mock.timers.tick(2000);
    await flush();
  }
  assert.ok(done, "it should have come to an end");
  return result;
}

test("a receiver on the right input already is left alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fakeReceiver({ on: true, input: "Media Player" });
  let said = 0;
  assert.equal(await runOut(t, bringToInput(r, "MPLAY", () => true, { onSwitching: () => said++ })), true);
  assert.deepEqual(r.sent, []);
  assert.equal(said, 0);
});

test("on another input: it's told, and looked at again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fakeReceiver({ on: true, input: "NET" });
  let said = 0;
  assert.equal(await runOut(t, bringToInput(r, "SAT/CBL", () => true, { onSwitching: () => said++ })), true);
  assert.deepEqual(r.sent, ["SISAT/CBL"]);
  assert.equal(said, 1, "said once");
});

test("in standby: on first, then the input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fakeReceiver({ on: false, input: "NET" });
  assert.equal(await runOut(t, bringToInput(r, "MPLAY", () => true)), true);
  assert.deepEqual(r.sent, ["PWON", "SIMPLAY"]);
});

test("one that isn't listening yet is told again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fakeReceiver({ on: true, input: "NET", deaf: true });
  const going = bringToInput(r, "MPLAY", () => true);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  r.state.deaf = false;
  assert.equal(await runOut(t, going), true);
  assert.ok(r.sent.length >= 2, String(r.sent));
  assert.ok(r.sent.every((w) => w === "SIMPLAY"));
});

test("one that never answers: it gives up, without a word sent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fakeReceiver({ gone: true, on: false, input: "" });
  assert.equal(await runOut(t, bringToInput(r, "MPLAY", () => true)), false);
  assert.deepEqual(r.sent, []);
});

test("one that doesn't switch: it gives up in the end", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fakeReceiver({ on: true, input: "NET", deaf: true });
  assert.equal(await runOut(t, bringToInput(r, "MPLAY", () => true)), false);
  assert.ok(r.sent.length <= 15, String(r.sent.length));
});

test("the music gone again on the way: it stops trying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fakeReceiver({ on: true, input: "NET", deaf: true });
  let wanted = true;
  const going = bringToInput(r, "MPLAY", () => wanted);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  wanted = false;
  assert.equal(await runOut(t, going), false);
  assert.ok(r.sent.length <= 2, String(r.sent.length));
});

const TV = { device: "tv", receiver: "denon", input: "MPLAY" };

test("a receiver counts as in use while what hangs on it has music", () => {
  assert.equal(receiverInUse("denon", new Set(), [TV]), false);
  assert.equal(receiverInUse("denon", new Set(["denon"]), [TV]), true);
  assert.equal(receiverInUse("denon", new Set(["tv"]), [TV]), true);
  assert.equal(receiverInUse("denon", new Set(["speaker"]), [TV]), false);
  assert.equal(receiverInUse("other", new Set(["tv"]), [TV]), false);
});

test("who needs its receiver now", () => {
  const follow = (now, before) => linksToFollow(new Set(now), new Set(before), [TV]).map((l) => l.device);
  assert.deepEqual(follow(["tv"], []), ["tv"], "it has just got music");
  assert.deepEqual(follow(["tv"], ["denon"]), ["tv"], "moved over from the receiver");
  assert.deepEqual(follow(["tv"], ["tv"]), [], "nothing new");
  assert.deepEqual(follow(["tv"], ["tv", "denon"]), ["tv"], "the receiver has just left the group");
  assert.deepEqual(follow(["tv", "denon"], []), [], "the receiver plays by itself: that's not to be cut off");
  assert.deepEqual(follow([], ["tv"]), [], "the music has gone");
  assert.deepEqual(follow(["speaker"], []), []);
});

test("music moving over to what hangs on the receiver starts no count", async (t) => {
  const { world, offs, pass } = setUp(t);
  const withMusic = new Set(["tv"]);
  world.inUse = receiverInUse("denon", withMusic, [TV]);
  await offs.left("denon", "Receiver");
  assert.deepEqual(offs.pending, []);
  await pass(SWITCH_OFF_AFTER_MS * 2);
  assert.deepEqual(world.offs, []);
});

test("a receiver on its HDMI inputs isn't on the network: no count, also not for the Media Player input", async (t) => {
  const { world, offs, pass } = setUp(t, { power: { on: true, input: "MPLAY" } });
  await offs.left("denon", "Receiver");
  assert.deepEqual(offs.pending, []);
  await pass(SWITCH_OFF_AFTER_MS * 2);
  assert.deepEqual(world.offs, []);
});

test("a receiver's own player: told only when it's not there by itself, and woken by nobody but its song", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const own = { accept: isNetworkInput, noWaking: true };
  const onIt = fakeReceiver({ on: true, input: "NET" });
  assert.equal(await runOut(t, bringToInput(onIt, OWN_INPUT, () => true, own)), true);
  assert.deepEqual(onIt.sent, []);
  const elsewhere = fakeReceiver({ on: true, input: "MPLAY" });
  assert.equal(await runOut(t, bringToInput(elsewhere, OWN_INPUT, () => true, own)), true);
  assert.deepEqual(elsewhere.sent, ["SINET"]);
  const asleep = fakeReceiver({ on: false, input: "MPLAY" });
  assert.equal(await runOut(t, bringToInput(asleep, OWN_INPUT, () => true, own)), false);
  assert.deepEqual(asleep.sent, [], "its song wakes it, not a word from here");
  for (const other of ["IRADIO", "SERVER", "HEOS Music", "USB/IPOD", "FAVORITES"]) assert.ok(isNetworkInput(other), other);
  for (const other of ["MPLAY", "SAT/CBL", "TV", "BD"]) assert.ok(!isNetworkInput(other), other);
});

test("what counts as a TV with a remote of its own", () => {
  for (const d of [{ model: "Google TV Streamer", name: "Living room" }, { model: "Chromecast", name: "x" }, { model: "SHIELD Android TV", name: "x" }, { model: "BRAVIA 4K", name: "x" }, { model: "", name: "Bedroom TV" }]) assert.ok(looksLikeTv(d), d.model);
  for (const d of [{ model: "Nest Audio", name: "Kitchen" }, { model: "Denon AVR-X1700H", name: "Receiver" }, { model: "Sonos One", name: "Bath" }]) assert.ok(!looksLikeTv(d), d.model);
});

/** A home: a receiver and a TV on it, the TV paired or not. */
function home(t, { tvPaired = true, input = "MPLAY", app = false } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const world = { power: { denon: { on: true, input }, tv: { on: true, input: "", tv: true, busy: app } }, offs: [], told: [], music: new Set(), after: [] };
  const links = [{ device: "tv", receiver: "denon", input: "MPLAY" }];
  const offs = new SwitchOffs({
    readPower: async (id) => (id === "tv" && !tvPaired ? null : world.power[id]),
    switchOff: async (id) => {
      world.offs.push(id);
      world.power[id].on = false;
      return true;
    },
    inUse: (id) => receiverInUse(id, world.music, links),
    changed: () => undefined,
    counting: (d) => world.told.push(d.id),
    afterSwitchedOff: (id) => world.after.push(id),
  });
  const names = { denon: { name: "Receiver", canSwitchOff: true }, tv: { name: "Google TV", canSwitchOff: tvPaired }, phone: null };
  const see = async (now, before) => {
    world.music = new Set(now);
    offs.sawDevices(new Set(now), new Set(before), (id) => names[id] ?? null, links);
    await flush();
    await flush();
  };
  const pass = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
    await flush();
  };
  return { world, offs, see, pass };
}

test("gone from the TV and the receiver altogether: both go off within the half minute", async (t) => {
  const { world, offs, see, pass } = home(t);
  await see([], ["tv"]);
  assert.deepEqual(offs.pending.map((d) => d.id).sort(), ["denon", "tv"]);
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs.sort(), ["denon", "tv"]);
  assert.deepEqual(world.after.sort(), ["denon", "tv"]);
});

test("a TV that isn't paired can't go off, the receiver still does", async (t) => {
  const { world, offs, see, pass } = home(t, { tvPaired: false });
  await see([], ["tv"]);
  assert.deepEqual(offs.pending.map((d) => d.id), ["denon"]);
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, ["denon"]);
});

test("back on the receiver: only the TV goes off", async (t) => {
  const { world, offs, see, pass } = home(t);
  await see(["denon"], ["tv"]);
  assert.deepEqual(offs.pending.map((d) => d.id), ["tv"]);
  world.power.denon.input = "NET";
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, ["tv"]);
  assert.equal(world.power.denon.on, true);
});

test("music back on the TV in time: nothing goes off", async (t) => {
  const { world, offs, see, pass } = home(t);
  await see([], ["tv"]);
  await pass(10_000);
  await see(["tv"], []);
  offs.forget("denon");
  assert.deepEqual(offs.pending, []);
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, []);
});

test("a film on the TV by then: the TV stays, and so does the receiver it sounds through", async (t) => {
  const { world, offs, see, pass } = home(t);
  await see([], ["tv"]);
  assert.equal(offs.pending.length, 2);
  await pass(10_000);
  world.power.tv.busy = true;
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, []);
});

test("a film on the TV when the music leaves: no count for either", async (t) => {
  const { world, offs, see, pass } = home(t, { app: true });
  await see([], ["tv"]);
  assert.deepEqual(offs.pending.map((d) => d.id), ["denon"], "the receiver counts, and looks at the TV again before it goes");
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, []);
});

test("the receiver switched over to another input in between: it stays, the TV goes", async (t) => {
  const { world, see, pass } = home(t);
  await see([], ["tv"]);
  await pass(5000);
  world.power.denon.input = "BD";
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, ["tv"]);
});

test("a TV that's off already isn't counted down", async (t) => {
  const { world, offs, see, pass } = home(t);
  world.power.tv.on = false;
  await see([], ["tv"]);
  assert.deepEqual(offs.pending.map((d) => d.id), ["denon"]);
  await pass(SWITCH_OFF_AFTER_MS);
  assert.deepEqual(world.offs, ["denon"]);
});

test("a receiver going off along with the TV is noticed, and only while it has music", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let power = { on: true, input: "NET" };
  let wanted = true;
  const look = wentOffToo(async () => power, () => wanted);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  power = { on: false, input: "NET" };
  assert.equal(await runOut(t, look), true);
  power = { on: true, input: "NET" };
  assert.equal(await runOut(t, wentOffToo(async () => power, () => true)), false, "it stayed on");
  power = { on: false, input: "NET" };
  wanted = false;
  assert.equal(await runOut(t, wentOffToo(async () => power, () => wanted)), false, "nobody's listening any more");
});
