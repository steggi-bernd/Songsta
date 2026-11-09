import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  __testing,
  configureDiscord,
  discordStatus,
  LOGO_URL,
  sanitizeActivity,
  setDiscordActivity,
  setDiscordCover,
  SONGSTA_PAGE,
  stopDiscord,
} from "../.test-build/discord.mjs";

const ID = "123456789012345678";
const newPipe = () =>
  process.platform === "win32"
    ? `\\\\?\\pipe\\bytune-test-${randomUUID()}`
    : path.join(os.tmpdir(), `bytune-test-${randomUUID()}.sock`);

/** A fake Discord on `pipe`: decodes frames, answers the handshake, records SET_ACTIVITY. */
function fakeDiscord({ pipe = newPipe(), refuseId = false, rejectListening = false, rejectAssets = false } = {}) {
  const frames = [];
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    let inbox = Buffer.alloc(0);
    const send = (op, payload) => {
      const body = Buffer.from(JSON.stringify(payload));
      const head = Buffer.alloc(8);
      head.writeUInt32LE(op, 0);
      head.writeUInt32LE(body.length, 4);
      s.write(Buffer.concat([head, body]));
    };
    s.on("data", (chunk) => {
      inbox = Buffer.concat([inbox, chunk]);
      while (inbox.length >= 8) {
        const op = inbox.readUInt32LE(0);
        const len = inbox.readUInt32LE(4);
        if (inbox.length < 8 + len) return;
        const msg = JSON.parse(inbox.subarray(8, 8 + len).toString("utf8"));
        inbox = inbox.subarray(8 + len);
        frames.push({ op, msg, at: Date.now() });
        if (op === 0 && refuseId) {
          send(2, { code: 4000, message: "Invalid Client ID" });
          s.end();
        } else if (op === 0) {
          send(1, { cmd: "DISPATCH", evt: "READY", data: { v: 1, user: { username: "tester", global_name: "Tester" } } });
        } else if (op === 1 && msg.cmd === "SET_ACTIVITY") {
          const a = msg.args.activity;
          if (rejectListening && a && "type" in a) {
            send(1, { cmd: "SET_ACTIVITY", evt: "ERROR", nonce: msg.nonce, data: { code: 4000, message: '"type" is not allowed' } });
          } else if (rejectAssets && a && "assets" in a) {
            send(1, { cmd: "SET_ACTIVITY", evt: "ERROR", nonce: msg.nonce, data: { code: 4000, message: '"assets" is not allowed' } });
          } else {
            send(1, { cmd: "SET_ACTIVITY", evt: null, nonce: msg.nonce, data: a ?? null });
          }
        }
      }
    });
    s.on("error", () => undefined);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) =>
    server.listen(pipe, () =>
      resolve({
        pipe,
        frames,
        handshakes: () => frames.filter((f) => f.op === 0),
        activities: () => frames.filter((f) => f.op === 1 && f.msg.cmd === "SET_ACTIVITY").map((f) => f.msg.args.activity ?? null),
        sentAt: () => frames.filter((f) => f.op === 1 && f.msg.cmd === "SET_ACTIVITY").map((f) => f.at),
        dropClients: () => {
          for (const s of sockets) s.destroy();
        },
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      })
    )
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(10);
  }
}
const song = (title, startedAt = Date.now()) => ({ title, artist: "Artist", startedAt, endsAt: startedAt + 180_000 });

test.beforeEach(() => {
  Object.assign(__testing.timing, { gapMs: 50, retryMs: 120, connectMs: 500, readyMs: 1500 });
});
test.afterEach(() => {
  stopDiscord();
  setDiscordActivity(null);
  __testing.usePipes(null);
});

test("handshake carries the Application ID; the song shows as a Listening status, paused clears it", async () => {
  const d = await fakeDiscord();
  __testing.usePipes([d.pipe]);
  try {
    configureDiscord(true, ID);
    await until(() => discordStatus().state === "connected");
    assert.deepEqual(d.handshakes()[0].msg, { v: 1, client_id: ID });
    assert.equal(discordStatus().user, "Tester");
    await sleep(150);
    assert.equal(d.activities().length, 0, "nothing playing on connect: no call at all");

    const start = Date.now() - 30_000;
    setDiscordActivity(song("First Song", start));
    await until(() => d.activities().length === 1);
    const [a] = d.activities();
    assert.equal(a.details, "First Song");
    assert.equal(a.state, "Artist");
    assert.equal(a.type, 2, "Listening, not Playing");
    assert.deepEqual(a.timestamps, { start, end: start + 180_000 });
    assert.deepEqual(a.assets, { large_image: LOGO_URL, large_text: "Songsta" }, "without an album and a cover: Songsta's logo");
    assert.ok(!("buttons" in a), "no button unless asked for");

    setDiscordActivity(null);
    await until(() => d.activities().length === 2);
    assert.equal(d.activities()[1], null, "paused: the status is cleared");
  } finally {
    await d.close();
  }
});

test("the album's cover from the open databases shows, with Songsta's logo in its corner; only public addresses go out", async () => {
  const d = await fakeDiscord();
  __testing.usePipes([d.pipe]);
  try {
    configureDiscord(true, ID);
    await until(() => discordStatus().state === "connected");
    const onNow = { ...song("Cover Song"), album: "Night Ferry", albumArtist: "" };
    setDiscordActivity(onNow);
    await until(() => d.activities().length === 1);
    assert.deepEqual(d.activities()[0].assets, { large_image: LOGO_URL, large_text: "Night Ferry" }, "the album's name, the logo until a cover is known");

    const cover = "https://coverartarchive.org/release-group/0d8ae6e1/front-500";
    setDiscordCover(sanitizeActivity(onNow), cover);
    await until(() => d.activities().length === 2);
    assert.deepEqual(d.activities()[1].assets, { large_image: cover, large_text: "Night Ferry", small_image: LOGO_URL, small_text: "Songsta" });

    // A cover that comes late for another song, or isn't a public https address, changes nothing.
    setDiscordCover(sanitizeActivity({ ...song("Another Song"), album: "Another Album" }), "https://example.org/a.jpg");
    setDiscordCover(sanitizeActivity(onNow), "http://192.168.1.2:8096/Items/1/Images/Primary");
    setDiscordCover(sanitizeActivity(onNow), `https://example.org/${"a".repeat(300)}.jpg`);
    await sleep(200);
    assert.equal(d.activities().length, 2);
    assert.equal(d.activities()[1].assets.large_image, cover);

    // The next song starts with the logo again, until its own cover is found.
    setDiscordActivity({ ...song("Next Song"), album: "Lanterns", albumArtist: "" });
    await until(() => d.activities().length === 3);
    assert.deepEqual(d.activities()[2].assets, { large_image: LOGO_URL, large_text: "Lanterns" });
  } finally {
    await d.close();
  }
});

test("asked for, a button to Songsta's page", async () => {
  const d = await fakeDiscord();
  __testing.usePipes([d.pipe]);
  try {
    configureDiscord(true, ID);
    setDiscordActivity({ ...song("Button Song"), button: true });
    await until(() => d.activities().length === 1);
    assert.deepEqual(d.activities()[0].buttons, [{ label: "Songsta", url: SONGSTA_PAGE }]);
  } finally {
    await d.close();
  }
});

test("a Discord that refuses pictures as well gets the plain status, a step at a time", async () => {
  const d = await fakeDiscord({ rejectListening: true, rejectAssets: true });
  __testing.usePipes([d.pipe]);
  try {
    setDiscordActivity({ ...song("Plain Song"), album: "Album", button: true });
    configureDiscord(true, ID);
    await until(() => d.activities().length === 3);
    const [, withoutListening, plain] = d.activities();
    assert.ok(!("type" in withoutListening) && "assets" in withoutListening);
    assert.equal(plain.details, "Plain Song");
    assert.ok(!("assets" in plain) && !("buttons" in plain) && !("type" in plain));
    assert.equal(discordStatus().state, "connected");
  } finally {
    await d.close();
  }
});

test("a burst of song changes is spaced out, and only the newest one is sent", async () => {
  __testing.timing.gapMs = 300;
  const d = await fakeDiscord();
  __testing.usePipes([d.pipe]);
  try {
    setDiscordActivity(song("Song A"));
    configureDiscord(true, ID);
    await until(() => d.activities().length === 1);
    for (const t of ["Song B", "Song C", "Song D", "Song E"]) setDiscordActivity(song(t));
    await sleep(700);
    assert.deepEqual(d.activities().map((a) => a.details), ["Song A", "Song E"]);
    const [first, second] = d.sentAt();
    assert.ok(second - first >= 280, `updates ${second - first} ms apart`);
  } finally {
    await d.close();
  }
});

test("an older Discord that refuses the Listening fields still gets the plain status", async () => {
  const d = await fakeDiscord({ rejectListening: true });
  __testing.usePipes([d.pipe]);
  try {
    setDiscordActivity(song("Old Client Song"));
    configureDiscord(true, ID);
    await until(() => d.activities().length === 2);
    const [rejected, plain] = d.activities();
    assert.equal(rejected.type, 2);
    assert.equal(plain.details, "Old Client Song");
    assert.ok(!("type" in plain) && !("status_display_type" in plain));
    assert.equal(discordStatus().state, "connected");
  } finally {
    await d.close();
  }
});

test("a refused Application ID is reported and not retried; a new ID tries again", async () => {
  const d = await fakeDiscord({ refuseId: true });
  __testing.usePipes([d.pipe]);
  try {
    configureDiscord(true, ID);
    await until(() => discordStatus().state === "error");
    assert.match(discordStatus().message, /Application ID/);
    await sleep(400);
    assert.equal(d.handshakes().length, 1, "no retry loop against a refused ID");
    configureDiscord(true, "876543210987654321");
    await until(() => d.handshakes().length === 2);
    assert.equal(d.handshakes()[1].msg.client_id, "876543210987654321");
  } finally {
    await d.close();
  }
});

test("Discord not running: waits for it; a Discord restart gets the song again", async () => {
  const pipe = newPipe();
  __testing.usePipes([pipe]);
  setDiscordActivity(song("Waiting Song"));
  configureDiscord(true, ID);
  await until(() => discordStatus().state === "unavailable");
  assert.match(discordStatus().message, /isn't running/);

  const d = await fakeDiscord({ pipe });
  try {
    await until(() => d.activities().length === 1);
    assert.equal(d.activities()[0].details, "Waiting Song");
    d.dropClients();
    await until(() => d.handshakes().length === 2);
    await until(() => d.activities().length === 2);
    assert.equal(d.activities()[1].details, "Waiting Song", "the reconnect restores the status");
  } finally {
    await d.close();
  }
});

test("turning it off closes the connection; an invalid ID never connects", async () => {
  const d = await fakeDiscord();
  __testing.usePipes([d.pipe]);
  try {
    configureDiscord(true, "not-an-id");
    await sleep(200);
    assert.equal(d.handshakes().length, 0);
    assert.equal(discordStatus().state, "off");
    configureDiscord(true, ` ${ID}\n`);
    await until(() => discordStatus().state === "connected");
    configureDiscord(false, ID);
    assert.equal(discordStatus().state, "off");
    await sleep(300);
    assert.equal(d.handshakes().length, 1, "off means no reconnects");
  } finally {
    await d.close();
  }
});

test("lines fit Discord's 2–128 characters", async () => {
  const d = await fakeDiscord();
  __testing.usePipes([d.pipe]);
  try {
    configureDiscord(true, ID);
    setDiscordActivity({ title: "X", artist: "", startedAt: Date.now(), endsAt: 0 });
    await until(() => d.activities().length === 1);
    const [short] = d.activities();
    assert.equal(short.details.length, 2);
    assert.equal(short.state, "Unknown artist");
    assert.deepEqual(Object.keys(short.timestamps), ["start"], "unknown length: elapsed time only");
    setDiscordActivity(song("😀".repeat(100)));
    await until(() => d.activities().length === 2);
    const long = d.activities()[1].details;
    assert.ok(long.length <= 128 && long.length >= 126, `length ${long.length}`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(long), "no emoji cut in half");
  } finally {
    await d.close();
  }
});

test("the renderer's input is checked: anything malformed means nothing playing", () => {
  for (const junk of [null, undefined, 42, "x", [], {}, { title: 5 }, { title: "   " }, JSON.parse('{"__proto__":{"title":"x"}}')]) {
    assert.equal(sanitizeActivity(junk), null, JSON.stringify(junk));
  }
  const a = sanitizeActivity({ title: "T".repeat(5000), artist: 7, startedAt: Number.NaN, endsAt: -1 });
  assert.equal(a.title.length, 512);
  assert.equal(a.artist, "");
  assert.ok(Math.abs(a.startedAt - Date.now()) < 1000);
  assert.equal(a.endsAt, 0);
  assert.equal(sanitizeActivity({ title: "T", startedAt: 2000, endsAt: 1000 }).endsAt, 0, "an end before the start is dropped");
  const full = sanitizeActivity({ title: "T", artist: "A", album: "  Night Ferry ", albumArtist: 3, button: "yes" });
  assert.equal(full.album, "Night Ferry");
  assert.equal(full.albumArtist, "");
  assert.equal(full.button, false, "only a real true asks for the button");
});
