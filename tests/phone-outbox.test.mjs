// What the phone still owes its Jellyfin server (mobile/src/outbox.ts, plan section 5): likes and plays
// kept per account through "not now" answers (401, 429, no answer) and restarts; dropped only when the
// server refuses them for good. Another account never gets them.
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const src = fileURLToPath(new URL("../mobile/src/", import.meta.url));
const stubs = {
  storage: `export const readJson = async (name) => (globalThis.__files?.[name] !== undefined ? JSON.parse(globalThis.__files[name]) : null);
    export const writeJson = (name, value) => { (globalThis.__files ??= {})[name] = JSON.stringify(value); };`,
  // The same kinds the real module gives its errors.
  jellyfin: `export const isNoAnswer = (e) => e?.name === "NoAnswer";
    export const isUnsure = (e) => e?.unsure === true;
    export const statusOf = (e) => (typeof e?.status === "number" ? e.status : undefined);
    export const retryAfterOf = (e) => (typeof e?.retryAfterMs === "number" ? e.retryAfterMs : undefined);`,
};
const out = await build({
  stdin: { contents: `export * from "./outbox";`, resolveDir: src, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        for (const [name, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`[\\\\/]mobile[\\\\/]src[\\\\/]${name}\\.ts$`);
          b.onLoad({ filter }, () => ({ contents, resolveDir: src, loader: "js" }));
        }
      },
    },
  ],
});
const o = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const anna = { server: "http://pi:8096", home: "http://pi:8096", serverId: "srv", token: "t1", userId: "anna", deviceId: "phone" };
const ben = { ...anna, token: "t2", userId: "ben" };
const song = (id) => ({ id, title: id, artist: "Band", duration: 100 });
const library = (...ids) => new Map(ids.map((id) => [id, song(id)]));
const refusal = (status, more = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...more });
const noAnswer = (unsure = false) => Object.assign(new Error("no answer"), { name: "NoAnswer", ...(unsure ? { unsure: true } : {}) });

/** A server that answers what it's told, in turn, and notes what it was asked. */
function server(...answers) {
  const asked = [];
  const next = (what) => {
    asked.push(what);
    const answer = answers.shift();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return {
    asked,
    act: {
      setFavorite: (t, liked) => next(`like ${t.id} ${liked}`),
      markPlayed: (t, at) => next(`play ${t.id} ${at.getTime()}`),
      playedSince: (t, at) => next(`since ${t.id} ${at}`),
    },
  };
}

beforeEach(async () => {
  globalThis.__files = undefined;
  o.dropOutboxes();
  await o.restoreOutbox();
});

test("a like made offline goes once the server takes it: a 401 and a 429 keep it, the 429 with the time it named", async () => {
  o.oweLike(anna, "jf:1", true);
  const first = server(refusal(401));
  await o.sendOutbox(anna, library("jf:1"), first.act, true);
  assert.deepEqual({ ...o.owedLikes(anna) }, { "jf:1": true }, "a login it doesn't take now: kept");
  const second = server(refusal(429, { retryAfterMs: 5000 }));
  const busy = await o.sendOutbox(anna, library("jf:1"), second.act, true);
  assert.equal(busy.retryInMs, 5000, "asked again when the server said");
  assert.deepEqual({ ...o.owedLikes(anna) }, { "jf:1": true });
  const third = server(undefined);
  await o.sendOutbox(anna, library("jf:1"), third.act, true);
  assert.deepEqual(third.asked, ["like jf:1 true"]);
  assert.deepEqual({ ...o.owedLikes(anna) }, {}, "taken: gone from the outbox");
});

test("what's owed outlasts a restart and a sign-in to the same account; another account never gets it", async () => {
  o.oweLike(anna, "jf:2", false);
  o.owePlay(anna, { id: "jf:3", at: 1000 });
  o.dropOutboxes();
  await o.restoreOutbox();
  const other = server();
  await o.sendOutbox(ben, library("jf:2", "jf:3"), other.act, true);
  assert.deepEqual(other.asked, [], "Ben's login hears nothing of Anna's");
  assert.deepEqual({ ...o.owedLikes(ben) }, {});
  const back = server(undefined, undefined);
  await o.sendOutbox({ ...anna, token: "a new login" }, library("jf:2", "jf:3"), back.act, true);
  assert.deepEqual(back.asked, ["like jf:2 false", "play jf:3 1000"], "Anna signed in again: it goes");
});

test("a song the library doesn't know yet waits for it to be read anew; still unknown then, it's dropped and said", async () => {
  o.oweLike(anna, "jf:new", true);
  const early = server();
  await o.sendOutbox(anna, library(), early.act, false);
  assert.deepEqual({ ...o.owedLikes(anna) }, { "jf:new": true }, "waits for the library");
  const late = await o.sendOutbox(anna, library(), server().act, true);
  assert.deepEqual(late.refused, ["jf:new"]);
  assert.deepEqual({ ...o.owedLikes(anna) }, {});
});

test("a play sent once without an answer in time is asked about before it goes again, so it isn't counted twice", async () => {
  o.owePlay(anna, { id: "jf:4", at: 2000, unsure: true });
  o.owePlay(anna, { id: "jf:5", at: 3000, unsure: true });
  const s = server(true, false, undefined);
  await o.sendOutbox(anna, library("jf:4", "jf:5"), s.act, true);
  assert.deepEqual(s.asked, ["since jf:4 2000", "since jf:5 3000", "play jf:5 3000"], "the first was counted already; the second goes");
  // No answer in time again: kept, and asked about next time.
  o.owePlay(anna, { id: "jf:6", at: 4000 });
  const timedOut = server(noAnswer(true));
  await o.sendOutbox(anna, library("jf:6"), timedOut.act, true);
  const next = server(true);
  await o.sendOutbox(anna, library("jf:6"), next.act, true);
  assert.deepEqual(next.asked, ["since jf:6 4000"]);
});

test("refused for good: dropped and said; liked again while it was on its way: the newer wish stays", async () => {
  o.oweLike(anna, "jf:7", true);
  const gone = await o.sendOutbox(anna, library("jf:7"), server(refusal(404)).act, true);
  assert.deepEqual(gone.refused, ["jf:7"]);
  assert.deepEqual({ ...o.owedLikes(anna) }, {});
  o.oweLike(anna, "jf:8", true);
  let release;
  const slow = { setFavorite: () => new Promise((resolve) => (release = resolve)), markPlayed: async () => {}, playedSince: async () => false };
  const sending = o.sendOutbox(anna, library("jf:8"), slow, true);
  await new Promise((resolve) => setImmediate(resolve));
  o.oweLike(anna, "jf:8", false);
  release();
  await sending;
  assert.deepEqual({ ...o.owedLikes(anna) }, { "jf:8": false }, "unliked meanwhile: that goes next");
});

test("an outbox kept before there was one per account goes to the first account it's needed for", async () => {
  globalThis.__files = { "outbox.json": JSON.stringify({ likes: { "jf:9": true }, plays: [{ id: "jf:9", at: 5000 }] }) };
  await o.restoreOutbox();
  assert.deepEqual({ ...o.owedLikes(anna) }, { "jf:9": true });
  const s = server(undefined, undefined);
  await o.sendOutbox(anna, library("jf:9"), s.act, true);
  assert.deepEqual(s.asked, ["like jf:9 true", "play jf:9 5000"]);
});
test("a rate-limited lookup of an uncertain play keeps the play for verification", async () => {
  o.owePlay(anna, { id: "jf:1", at: 1000, unsure: true });
  const s = server(refusal(429, { retryAfterMs: 5000 }));
  const result = await o.sendOutbox(anna, library("jf:1"), s.act, true);
  assert.deepEqual(s.asked, ["since jf:1 1000"]);
  assert.equal(result.retryInMs, 5000);
  const retry = server(true);
  await o.sendOutbox(anna, library("jf:1"), retry.act, true);
  assert.deepEqual(retry.asked, ["since jf:1 1000"]);
});

test("overlapping outbox sends submit a single pending play once", async () => {
  o.owePlay(anna, { id: "jf:1", at: 1000 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let submissions = 0;
  const actions = {
    ...server().act,
    markPlayed: async () => { submissions += 1; await gate; },
  };
  const send = () => o.sendOutbox(anna, library("jf:1"), actions, true);
  const first = send();
  const second = send();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(submissions, 1);
});

/* ------------------------------------------------------------- a check without an answer; a busy server's wait (Codex, section 15) */

test("a check of an unsure play that gets no answer keeps it unsure, and it goes only after a clear no", async () => {
  o.owePlay(anna, { id: "jf:1", at: 1000, unsure: true });
  const first = server(noAnswer());
  await o.sendOutbox(anna, library("jf:1"), first.act, true);
  assert.deepEqual(first.asked, ["since jf:1 1000"], "no play sent");
  const second = server(false, undefined);
  await o.sendOutbox(anna, library("jf:1"), second.act, true);
  assert.deepEqual(second.asked, ["since jf:1 1000", "play jf:1 1000"], "a clear no: it goes");
});

test("a busy server's wait is kept with the account, also through a restart; the round that gets to ask ends it", async () => {
  o.oweLike(anna, "jf:2", true);
  const before = Date.now();
  await o.sendOutbox(anna, library("jf:2"), server(refusal(429, { retryAfterMs: 5000 })).act, true);
  const until = o.owedAfter(anna);
  assert.ok(until >= before + 5000 && until <= Date.now() + 5000, "until when to wait");
  assert.equal(o.owedAfter(ben), 0, "another account isn't held up");
  o.dropOutboxes();
  await o.restoreOutbox();
  assert.equal(o.owedAfter(anna), until, "kept through a restart");
  await o.sendOutbox(anna, library("jf:2"), server(undefined).act, true);
  assert.equal(o.owedAfter(anna), 0);
});
