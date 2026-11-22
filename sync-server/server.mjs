/**
 * Songsta's sync service: a small store next to Jellyfin for what Jellyfin has
 * no place for, the playlists, where playback stopped and how the library is
 * organised. It knows nothing about music. Documents go in and come out with a
 * revision number; merging is the apps' job (src/lib/syncEngine.ts,
 * src/lib/librarySync.ts). An app that doesn't know a document never asks for
 * it, and one that finds a document missing here keeps it to itself.
 *
 * A login here is a Jellyfin login: the header a client sends to Jellyfin is
 * asked of Jellyfin, and each Jellyfin user has their own documents. An API
 * key belongs to no user, so it names the user it acts for (X-Songsta-User).
 * The desktop app runs this same service for phones at home without one
 * (electron/home-link-server.ts); there its own check says who's paired.
 *
 *   GET  /health                  { ok, service, api, version, docs }: no login needed; the apps look here once they're linked
 *   GET  /v1/docs/:name           { rev, updatedAt, doc }   (rev 0: nothing yet)
 *   PUT  /v1/docs/:name           { rev?, doc } → { rev, seq, updatedAt }, 409 when rev is behind
 *   GET  /v1/changes?since&wait&device   { seq, revs, inbox }: answers at once when seq differs, else within `wait` seconds
 *   GET  /v1/devices              { now, rev, devices: [{ id, updatedAt, doc }] }: who is around and what they play
 *   PUT  /v1/devices/:id          { doc }: what this device says about itself
 *   POST /v1/devices/:id/commands { command, id? } → { ok, id }: a word for that device, kept for a minute (on disk,
 *                                 through a restart); sent again with the same id, it's there once
 *   GET  /v1/devices/:id/commands { commands }: that device's words, handed over once
 *   GET  /v1/devices/:id/commands?keep=1 { commands, ids, started }: its words, kept until it says it's done with them
 *   POST /v1/devices/:id/commands/start { ids }: about to do those; started ones aren't done twice after a restart
 *   POST /v1/devices/:id/commands/done { ids, results? }: done with those; what it made of each, for the sender
 *   GET  /v1/devices/:id/commands/:cid { state, result? }: a word's way: waiting, or done and what came of it
 *   PUT  /v1/lists/:id { doc } · GET /v1/lists/:id { doc }: a list of songs a command points to, kept a while
 *   POST /v1/listens              { device: { id, name, kind }, listens } → { added, count, generation }: plays a device counted
 *   GET  /v1/listens?since&limit  { count, generation, listens, devices, more }: everybody's plays after the first `since`
 *   DELETE /v1/listens?device     { removed, count, generation }: one device's plays taken out (the rest numbered again)
 *
 * The listens are the one thing here that isn't a document: a history every device adds to and reads
 * from (src/lib/listenSync.ts), kept in order, one line each, so Replay counts every play everywhere.
 * Within one generation it only grows at its end; plays taken out, or a history that isn't what this
 * service last wrote (put back from a backup), make a new generation, and a device that read another
 * one reads it again from the start (part 2 of the protocol rework, 2026-11-21).
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** An id for a word its sender didn't name. */
const commandId = () => randomBytes(8).toString("hex");

/**
 * This service's version: the release it came with. The image says it from its tag (the
 * SONGSTA_SYNC_VERSION it was built with); built from this folder, this file says it, and it goes
 * up with each release like the apps' own.
 */
export const VERSION = process.env.SONGSTA_SYNC_VERSION || "1.8.0";

/**
 * `merged` documents are built on a revision and a write must say which; `checkedWhenSaid`: a write that
 * says one is checked too (newer apps), one that doesn't still wins (older apps); the rest is last writer wins.
 */
const DOCS = {
  playlists: { merged: true, keepVersions: 20 },
  queue: {},
  position: {},
  // Liked Songs' order: two computers' changes put together on a revision (plan section 5).
  likes: { checkedWhenSaid: true },
  muted: {},
  // How the library is organised: pins, its sort and when things played; the groups; the album edits and their pictures.
  order: { merged: true, keepVersions: 10 },
  groups: { merged: true, keepVersions: 20 },
  albumedits: { merged: true, keepVersions: 20 },
  albumpictures: { merged: true, keepVersions: 5 },
  // Tempo, key and energy each device measured, and keys set by hand (src/lib/soundShare.ts).
  sounds: { merged: true, keepVersions: 2 },
  keys: { merged: true, keepVersions: 10 },
};
const DEVICES_FILE = "devices.json";
/** The commands waiting for each device, so one taken on is still there after a restart. */
const INBOX_FILE = "inbox.json";
const LISTENS_FILE = "listens.jsonl";
const LISTEN_DEVICES_FILE = "listen-devices.json";
/** The history's generation, and how long it was and its last play when this service last wrote it. */
const LISTENS_META_FILE = "listens-meta.json";
const MAX_LISTENS_PER_POST = 1000;
const MAX_LISTENS_PER_PAGE = 2000;
const EARLIEST_LISTEN = Date.UTC(2000, 0, 1);
/** A device not heard of for this long is forgotten. */
const DEVICE_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DEVICE_BYTES = 64 * 1024;
const COMMAND_KEPT_MS = 60_000;
const MAX_COMMANDS = 20;
/** A word's id, from its sender or given here; "done" is the path for saying so. */
const COMMAND_ID = /^(?!(?:done|start)$)[A-Za-z0-9._:-]{1,80}$/;
/** Words a device said it's done with, remembered a while: sent again after a lost answer, they aren't taken twice. */
const DONE_KEPT = 200;
/** Lists of songs commands point to: one file each, kept this long. */
const LISTS_DIR = "lists";
const LIST_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const LIST_KEPT_MS = 10 * 60_000;
const DEVICE_ID = "[A-Za-z0-9._:-]{1,80}";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const IDENTITY_TTL_MS = 5 * 60_000;
const MAX_WAIT_SEC = 30;
const JELLYFIN_TIMEOUT_MS = 10_000;

const USER_ID = /^[a-f0-9]{32}$/;
const normalizeId = (id) => String(id ?? "").replace(/-/g, "").toLowerCase();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const text = (v, max) => (typeof v === "string" ? v.slice(0, max).trim() : "");

/** A listen as it's kept, or null (the same rules as the apps' src/lib/listenSync.ts). */
function readListen(raw, device) {
  if (!raw || typeof raw !== "object") return null;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? Math.round(raw.at) : NaN;
  const id = text(raw.id, 200);
  const title = text(raw.title, 300);
  if (!(at >= EARLIEST_LISTEN && at <= Date.now() + 86_400_000) || !id || !title) return null;
  const listen = { device, at, id, title, artist: text(raw.artist, 300), ms: typeof raw.ms === "number" && Number.isFinite(raw.ms) ? Math.max(0, Math.min(6 * 3600_000, Math.round(raw.ms))) : 0 };
  const album = text(raw.album, 300);
  if (album) listen.album = album;
  const thumb = text(raw.thumb, 1000);
  if (/^https?:\/\//i.test(thumb)) listen.thumb = thumb;
  return listen;
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // What's left is read and dropped, so the sender gets to hear the answer.
      if (size > MAX_BODY_BYTES) {
        chunks = [];
        return reject(new HttpError(413, "Too large"));
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Not JSON"));
      }
    });
  });
}

/** Whole or not at all: a crash in the middle leaves the last good file. `raw` writes the text as it is. */
/** The newest kept version of a document that still reads, or null. */
async function newestVersion(dir, name) {
  const prefix = `${name}.`;
  const revOf = (file) => Number(file.slice(prefix.length, -".json".length));
  let files;
  try {
    files = (await readdir(path.join(dir, "versions"))).filter((file) => file.startsWith(prefix) && file.endsWith(".json") && Number.isFinite(revOf(file)));
  } catch {
    return null;
  }
  for (const file of files.sort((a, b) => revOf(b) - revOf(a))) {
    try {
      const stored = JSON.parse(await readFile(path.join(dir, "versions", file), "utf8"));
      if (stored && typeof stored.rev === "number" && stored.doc && typeof stored.doc === "object") return stored;
    } catch {
      // That one doesn't read either: the one before it.
    }
  }
  return null;
}

/** A new generation of the shared listening history. */
const newGeneration = () => randomBytes(9).toString("base64url");

/** How the last play of a history is known: who played it, when, what. */
const lastListenKey = (items) => {
  const last = items[items.length - 1];
  return last ? `${last.device}|${last.at}|${last.id}` : "";
};

/** The history's generation with its length and last play, so the next start can tell it's still the same. */
async function writeListensMeta(dir, log) {
  try {
    await writeAtomic(path.join(dir, LISTENS_META_FILE), { generation: log.generation, count: log.items.length, last: lastListenKey(log.items) });
  } catch (err) {
    // Not written: the next start sees a history it can't vouch for and makes a new generation, so
    // devices read it again once. Nothing is lost.
    console.error("[sync] the listening history's generation wasn't written:", err.message);
  }
}

async function writeAtomic(file, value, raw = false) {
  const temp = `${file}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(raw ? value : JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

/**
 * The service's requests, for a server of its own or one that answers some paths itself first.
 * `authenticate(req)`, when given, says whose documents a request is about instead of Jellyfin: a
 * 32-hex user id, or nothing for a request it doesn't let in.
 */
export function createSyncHandler({ dataDir, jellyfinUrl = "", authenticate: ownCheck }) {
  const jellyfin = String(jellyfinUrl).replace(/\/+$/, "");
  /** sha256 of the login → who it is; the login itself is never kept. */
  const identities = new Map();
  /** user id → their documents, in memory after the first read */
  const users = new Map();

  async function askJellyfin(pathname, authorization) {
    try {
      return await fetch(`${jellyfin}${pathname}`, {
        headers: { Authorization: authorization, Accept: "application/json" },
        signal: AbortSignal.timeout(JELLYFIN_TIMEOUT_MS),
      });
    } catch {
      // Jellyfin being away says nothing about the login: the app keeps its data and tries again.
      throw new HttpError(503, "Jellyfin does not answer");
    }
  }

  async function identify(authorization) {
    const key = createHash("sha256").update(authorization).digest("hex");
    const known = identities.get(key);
    if (known && known.until > Date.now()) return known;

    const me = await askJellyfin("/Users/Me", authorization);
    if (me.status >= 500 && me.status !== 500) throw new HttpError(503, "Jellyfin does not answer");
    if (me.status === 401) throw new HttpError(401, "Jellyfin rejected this login");
    let who = null;
    if (me.ok) {
      const id = normalizeId((await me.json())?.Id);
      if (USER_ID.test(id)) who = { userId: id };
    } else {
      // No user behind the login: an API key may still see the server's users.
      const list = await askJellyfin("/Users", authorization);
      if (list.ok) {
        const all = await list.json();
        who = { allowed: new Set((Array.isArray(all) ? all : []).map((u) => normalizeId(u?.Id)).filter((id) => USER_ID.test(id))) };
      }
    }
    if (!who) throw new HttpError(401, "Jellyfin rejected this login");
    who.until = Date.now() + IDENTITY_TTL_MS;
    identities.set(key, who);
    return who;
  }

  async function authenticate(req) {
    if (ownCheck) {
      const userId = await ownCheck(req);
      if (typeof userId !== "string" || !USER_ID.test(userId)) throw new HttpError(401, "Not paired with this service");
      return userId;
    }
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || authorization.length > 2048 || !/Token="[^"]+"/.test(authorization)) {
      throw new HttpError(401, "No login");
    }
    const who = await identify(authorization);
    if (who.userId) return who.userId;
    const claimed = normalizeId(req.headers["x-songsta-user"]);
    if (!claimed) throw new HttpError(400, "An API key must name a user");
    if (!who.allowed.has(claimed)) throw new HttpError(403, "No such user on this server");
    return claimed;
  }

  function userState(userId) {
    let user = users.get(userId);
    if (!user) {
      user = (async () => {
        const dir = path.join(dataDir, "users", userId);
        await mkdir(dir, { recursive: true });
        const docs = {};
        const broken = new Set();
        let seq = 0;
        for (const name of Object.keys(DOCS)) {
          const file = path.join(dir, `${name}.json`);
          try {
            const stored = JSON.parse(await readFile(file, "utf8"));
            docs[name] = stored;
            seq = Math.max(seq, stored.seq ?? 0);
          } catch (err) {
            if (err.code === "ENOENT") continue;
            console.error(`[sync] unreadable ${name} of ${userId}:`, err.message);
            // Not read as empty and written over (Codex's review): the file is kept aside, and the newest
            // version kept of it goes on in its place, numbered past anything a device may know. Without
            // one, a document the apps merge stays shut until it's restored; the others start afresh.
            const aside = `${file}.unreadable-${Date.now()}`;
            await copyFile(file, aside).catch(() => undefined);
            const version = DOCS[name].keepVersions ? await newestVersion(dir, name) : null;
            if (version) {
              const recovered = { ...version, rev: version.rev + 2, updatedAt: Date.now() };
              await writeAtomic(file, recovered);
              docs[name] = recovered;
              seq = Math.max(seq, recovered.seq ?? 0);
              console.error(`[sync] ${name} of ${userId} goes on from version ${version.rev}; the unreadable file is ${path.basename(aside)}`);
            } else if (DOCS[name].merged) {
              broken.add(name);
            } else {
              await rm(file, { force: true });
            }
          }
        }
        const inbox = new Map();
        try {
          const stored = JSON.parse(await readFile(path.join(dir, INBOX_FILE), "utf8"));
          const now = Date.now();
          for (const [id, list] of Object.entries(stored ?? {})) {
            const kept = Array.isArray(list) ? list.filter((c) => c && typeof c.at === "number" && now - c.at <= COMMAND_KEPT_MS && c.command && typeof c.command === "object") : [];
            if (kept.length) inbox.set(id, kept.slice(-MAX_COMMANDS).map((c) => (typeof c.id === "string" && COMMAND_ID.test(c.id) ? c : { ...c, id: commandId() })));
          }
        } catch (err) {
          if (err.code !== "ENOENT") console.error(`[sync] unreadable inbox of ${userId}:`, err.message);
        }
        let devices = {};
        let devicesRev = 0;
        try {
          const stored = JSON.parse(await readFile(path.join(dir, DEVICES_FILE), "utf8"));
          devices = stored.devices ?? {};
          devicesRev = stored.rev ?? 0;
          seq = Math.max(seq, stored.seq ?? 0);
        } catch (err) {
          if (err.code !== "ENOENT") console.error(`[sync] unreadable devices of ${userId}:`, err.message);
        }
        // The shared listening history, kept in memory too: a few megabytes even for years of listening.
        // `cutShort`: the file may end in the middle of a line (a write broke off), so the next plays
        // start on a line of their own, or they'd be glued to the broken one and lost at the next start.
        const listens = { items: [], keys: new Set(), devices: {}, cutShort: false };
        try {
          const content = await readFile(path.join(dir, LISTENS_FILE), "utf8");
          listens.cutShort = content.length > 0 && !content.endsWith("\n");
          for (const line of content.split("\n")) {
            if (!line) continue;
            try {
              const l = JSON.parse(line);
              // A play can stand twice when a write broke off after some lines and the device sent
              // them all again: it counts once.
              const key = `${l.device}|${l.at}|${l.id}`;
              if (listens.keys.has(key)) continue;
              listens.items.push(l);
              listens.keys.add(key);
            } catch {
              /* a line cut short by a crash: the rest stands */
            }
          }
        } catch (err) {
          if (err.code !== "ENOENT") console.error(`[sync] unreadable listens of ${userId}:`, err.message);
        }
        try {
          listens.devices = JSON.parse(await readFile(path.join(dir, LISTEN_DEVICES_FILE), "utf8")) ?? {};
        } catch (err) {
          if (err.code !== "ENOENT") console.error(`[sync] unreadable listen devices of ${userId}:`, err.message);
        }
        // Its generation: kept while the history is exactly what this service last wrote. Another length or
        // another last play (a backup put back, a file changed by hand, a write cut short) is a new one.
        let meta = null;
        try {
          meta = JSON.parse(await readFile(path.join(dir, LISTENS_META_FILE), "utf8"));
        } catch (err) {
          if (err.code !== "ENOENT") console.error(`[sync] unreadable listening history generation of ${userId}:`, err.message);
        }
        if (meta && typeof meta.generation === "string" && meta.generation && meta.count === listens.items.length && meta.last === lastListenKey(listens.items)) {
          listens.generation = meta.generation;
        } else {
          listens.generation = newGeneration();
          await writeListensMeta(dir, listens);
        }
        return { dir, docs, broken, seq, devices, devicesRev, listens, inbox, done: new Map(), waiters: new Set(), writing: Promise.resolve(), inboxWriting: Promise.resolve() };
      })();
      users.set(userId, user);
    }
    return user;
  }

  /** The version being replaced stays for a while: the apps merge, and a bug there must not cost anyone a playlist. */
  async function keepVersion(user, name, current, keep) {
    const dir = path.join(user.dir, "versions");
    await mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, `${name}.${current.rev}.json`), current);
    const prefix = `${name}.`;
    const revOf = (file) => Number(file.slice(prefix.length, -".json".length));
    const old = (await readdir(dir))
      .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
      .sort((a, b) => revOf(b) - revOf(a))
      .slice(keep);
    await Promise.all(old.map((file) => rm(path.join(dir, file), { force: true })));
  }

  /** One write at a time per user, so a revision check and its write can't be overtaken. */
  function write(user, name, expected, doc) {
    const run = user.writing.then(async () => {
      const spec = DOCS[name];
      const current = user.docs[name];
      const rev = current?.rev ?? 0;
      if ((spec.merged || (spec.checkedWhenSaid && typeof expected === "number")) && expected !== rev) return { conflict: true, current: current ?? { rev: 0, updatedAt: 0, doc: null } };
      const next = { rev: rev + 1, seq: user.seq + 1, updatedAt: Date.now(), doc };
      if (spec.keepVersions && current) await keepVersion(user, name, current, spec.keepVersions);
      await writeAtomic(path.join(user.dir, `${name}.json`), next);
      user.docs[name] = next;
      user.seq = next.seq;
      for (const wake of [...user.waiters]) wake();
      return { next };
    });
    // A failed write fails its own request, not the ones behind it.
    user.writing = run.catch(() => undefined);
    return run;
  }

  /** A device says where it stands; everybody else hears of it through the long poll. */
  function writeDevice(user, id, doc) {
    const run = user.writing.then(async () => {
      const now = Date.now();
      for (const [other, entry] of Object.entries(user.devices)) {
        if (now - entry.updatedAt > DEVICE_KEPT_MS) delete user.devices[other];
      }
      user.devices[id] = { updatedAt: now, doc };
      user.devicesRev += 1;
      user.seq += 1;
      await writeAtomic(path.join(user.dir, DEVICES_FILE), { rev: user.devicesRev, seq: user.seq, devices: user.devices });
      for (const wake of [...user.waiters]) wake();
    });
    user.writing = run.catch(() => undefined);
    return run;
  }

  /**
   * Plays a device counted, added to the history in the order they come; one already there (the same
   * device, moment and song: sent again after a lost answer) is left out. Each gets its place, from 1.
   *
   * Nothing counts as stored before it is on disk: a play marked as there before its write failed was
   * answered "0 added" when the device sent it again, and it was lost (found by Codex's review,
   * 2026-11-20). So a failed write fails the request and leaves memory as it was, for the device to
   * send again.
   */
  function appendListens(user, device, raw) {
    const run = user.writing.then(async () => {
      const log = user.listens;
      const added = [];
      const fresh = new Set();
      for (const r of raw) {
        const listen = readListen(r, device.id);
        if (!listen) continue;
        const key = `${listen.device}|${listen.at}|${listen.id}`;
        if (log.keys.has(key) || fresh.has(key)) continue;
        fresh.add(key);
        added.push({ n: log.items.length + added.length + 1, ...listen });
      }
      const known = log.devices[device.id];
      if (!known || known.name !== device.name || known.kind !== device.kind) {
        const devices = { ...log.devices, [device.id]: { name: device.name, ...(device.kind ? { kind: device.kind } : {}) } };
        await writeAtomic(path.join(user.dir, LISTEN_DEVICES_FILE), devices);
        log.devices = devices;
      }
      if (!added.length) return 0;
      const lines = `${added.map((l) => JSON.stringify(l)).join("\n")}\n`;
      try {
        await appendFile(path.join(user.dir, LISTENS_FILE), log.cutShort ? `\n${lines}` : lines, "utf8");
      } catch (err) {
        // Part of it may have reached the file: the next write starts on a fresh line, and plays
        // standing twice count once when the file is read again.
        log.cutShort = true;
        throw err;
      }
      log.cutShort = false;
      for (const key of fresh) log.keys.add(key);
      log.items.push(...added);
      await writeListensMeta(user.dir, log);
      user.seq += 1;
      for (const wake of [...user.waiters]) wake();
      return added.length;
    });
    user.writing = run.catch(() => undefined);
    return run;
  }

  /**
   * A device's plays taken out of the history (its "Remove from the sync service"): the rest keep their
   * order and get their places again from 1. The history is shorter then, so every device reads it from
   * the start once and sends its own plays again; the ones taken out don't come back, the device that
   * sent them keeps them to itself.
   */
  function removeListens(user, deviceId) {
    const run = user.writing.then(async () => {
      const log = user.listens;
      const items = log.items.filter((l) => l.device !== deviceId).map((l, i) => ({ ...l, n: i + 1 }));
      const removed = log.items.length - items.length;
      // The device's name goes too; when its plays are gone already, only that is left to do.
      if (removed) {
        // Written first, kept in memory after: a failed write leaves the plays there for another try,
        // where taking them out of memory first made the next try find nothing to remove.
        await writeAtomic(path.join(user.dir, LISTENS_FILE), items.length ? `${items.map((l) => JSON.stringify(l)).join("\n")}\n` : "", true);
        log.items = items;
        log.keys = new Set(items.map((l) => `${l.device}|${l.at}|${l.id}`));
        log.cutShort = false;
        // Numbered again: a device's place in it means nothing now, so it's a new generation.
        log.generation = newGeneration();
        await writeListensMeta(user.dir, log);
        user.seq += 1;
        for (const wake of [...user.waiters]) wake();
      }
      if (log.devices[deviceId]) {
        const devices = { ...log.devices };
        delete devices[deviceId];
        await writeAtomic(path.join(user.dir, LISTEN_DEVICES_FILE), devices);
        log.devices = devices;
      }
      return removed;
    });
    user.writing = run.catch(() => undefined);
    return run;
  }

  const waitingCommands = (user, id) => {
    const now = Date.now();
    const list = (user.inbox.get(id) ?? []).filter((c) => now - c.at <= COMMAND_KEPT_MS);
    if (list.length) user.inbox.set(id, list);
    else user.inbox.delete(id);
    return list;
  };

  /**
   * The waiting commands on disk as well, for the minute they're kept: one taken on is still there after
   * a restart, and one handed over isn't handed over again (Codex's review: a hand-over taken on was gone).
   */
  function saveInbox(user) {
    const run = user.inboxWriting.then(() => {
      const now = Date.now();
      const all = {};
      for (const [id, list] of user.inbox) {
        const kept = list.filter((c) => now - c.at <= COMMAND_KEPT_MS);
        if (kept.length) all[id] = kept;
      }
      return writeAtomic(path.join(user.dir, INBOX_FILE), all);
    });
    user.inboxWriting = run.catch(() => undefined);
    return run;
  }

  /** What a device said it's done with, lately, by word id: { at, result }. */
  function doneOf(user, id) {
    let done = user.done.get(id);
    if (!done) {
      done = new Map();
      user.done.set(id, done);
    }
    const now = Date.now();
    for (const [key, entry] of done) if (now - entry.at > COMMAND_KEPT_MS) done.delete(key);
    return done;
  }

  /**
   * A word for one device: taken on once it's on disk too. A command means now, or not at all: it's kept
   * for a minute. Sent again with the same id (its answer got lost on the way), it's there once: still
   * waiting, or done already (Codex, 2026-11-21: a lost answer said "failed" though the word arrived).
   */
  async function postCommand(user, id, command, given) {
    const key = typeof given === "string" && COMMAND_ID.test(given) ? given : commandId();
    const waiting = waitingCommands(user, id);
    if (waiting.some((c) => c.id === key) || doneOf(user, id).has(key)) return key;
    const entry = { at: Date.now(), id: key, command };
    user.inbox.set(id, [...waiting, entry].slice(-MAX_COMMANDS));
    try {
      await saveInbox(user);
    } catch (err) {
      // Not on disk: not taken on either.
      const left = (user.inbox.get(id) ?? []).filter((c) => c !== entry);
      if (left.length) user.inbox.set(id, left);
      else user.inbox.delete(id);
      throw err;
    }
    user.seq += 1;
    for (const wake of [...user.waiters]) wake();
    return key;
  }

  /**
   * A device done with some of its words (it took them with keep=1): they go, and what it made of each
   * stays a while for the sender. A word taken but never said done comes again at the next take, so an
   * answer lost on the way loses nothing (Codex, 2026-11-21).
   */
  async function doneCommands(user, id, ids, results) {
    const gone = new Set(ids.filter((key) => typeof key === "string" && COMMAND_ID.test(key)));
    if (!gone.size) return 0;
    const done = doneOf(user, id);
    const now = Date.now();
    for (const key of gone) {
      const result = typeof results?.[key] === "string" ? results[key].slice(0, 20) : "done";
      done.set(key, { at: now, result });
    }
    while (done.size > DONE_KEPT) done.delete(done.keys().next().value);
    const list = waitingCommands(user, id);
    const left = list.filter((c) => !gone.has(c.id));
    if (left.length === list.length) return 0;
    if (left.length) user.inbox.set(id, left);
    else user.inbox.delete(id);
    await saveInbox(user);
    return list.length - left.length;
  }

  /**
   * A device about to do some of its words (taken with keep=1): marked started, on disk too. Started and
   * taken again (the device started anew, and the word that it was done got lost), it isn't done twice:
   * the device says it done (Codex, 2026-11-21: a "next" ran twice).
   */
  async function startCommands(user, id, ids) {
    const wanted = new Set(ids.filter((key) => typeof key === "string" && COMMAND_ID.test(key)));
    const now = Date.now();
    let marked = 0;
    const list = waitingCommands(user, id).map((c) => {
      if (!wanted.has(c.id) || c.started) return c;
      marked += 1;
      return { ...c, started: now };
    });
    if (!marked) return 0;
    user.inbox.set(id, list);
    await saveInbox(user);
    return marked;
  }

  /** A word's way, for its sender: still waiting, or done and what came of it; nothing for one unknown or gone. */
  function commandState(user, id, key) {
    if (waitingCommands(user, id).some((c) => c.id === key)) return { state: "waiting" };
    const done = doneOf(user, id).get(key);
    return done ? { state: "done", result: done.result } : null;
  }

  /** A list of songs a command points to, in a file of its own: two lists sent at once each keep their songs. */
  async function putList(user, listId, doc) {
    const dir = path.join(user.dir, LISTS_DIR);
    await mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, `${listId}.json`), { at: Date.now(), doc });
    // Lists from a while ago go: their commands are long gone.
    const now = Date.now();
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      try {
        const stored = JSON.parse(await readFile(path.join(dir, name), "utf8"));
        if (!(now - stored.at <= LIST_KEPT_MS)) await rm(path.join(dir, name), { force: true });
      } catch {
        await rm(path.join(dir, name), { force: true });
      }
    }
  }

  async function getList(user, listId) {
    try {
      const stored = JSON.parse(await readFile(path.join(user.dir, LISTS_DIR, `${listId}.json`), "utf8"));
      return Date.now() - stored.at <= LIST_KEPT_MS ? stored.doc : null;
    } catch {
      return null;
    }
  }

  /** A device takes its commands: they're gone once that's on disk, so a restart doesn't hand them over twice. */
  async function takeCommands(user, id) {
    const list = waitingCommands(user, id);
    if (!list.length) return list;
    user.inbox.delete(id);
    try {
      await saveInbox(user);
    } catch (err) {
      user.inbox.set(id, [...list, ...(user.inbox.get(id) ?? [])].slice(-MAX_COMMANDS));
      throw err;
    }
    return list;
  }

  const summary = (user, device) => ({
    seq: user.seq,
    revs: {
      ...Object.fromEntries(Object.keys(DOCS).map((name) => [name, user.docs[name]?.rev ?? 0])),
      devices: user.devicesRev,
      listens: user.listens.items.length,
    },
    // Changed also when the length didn't: a play taken out and another one added while a device was away.
    listensGeneration: user.listens.generation,
    inbox: device ? waitingCommands(user, device).length : 0,
  });

  function changes(res, user, since, waitSec, device) {
    if (user.seq !== since || waitSec <= 0 || (device && waitingCommands(user, device).length)) return send(res, 200, summary(user, device));
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      user.waiters.delete(wake);
    };
    const wake = () => {
      finish();
      if (!res.writableEnded && !res.destroyed) send(res, 200, summary(user, device));
    };
    timer = setTimeout(wake, waitSec * 1000);
    user.waiters.add(wake);
    res.on("close", finish);
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://service");
    // Behind a proxy or tunnel it shares Jellyfin's name, under this path.
    const pathname = url.pathname.replace(/^\/songsta-sync(?=\/)/, "");
    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, service: "songsta-sync", api: 1, version: VERSION, docs: Object.keys(DOCS), features: ["listens", "listens-remove", "listens-generation", "commands-kept", "commands-started", "command-results", "lists"] });
    }

    const docMatch = /^\/v1\/docs\/([a-z]+)$/.exec(pathname);
    const deviceMatch = new RegExp(`^/v1/devices(?:/(${DEVICE_ID})(/commands(?:/([A-Za-z0-9._:-]{1,80}))?)?)?$`).exec(pathname);
    const listMatch = /^\/v1\/lists\/([^/]+)$/.exec(pathname);
    if (pathname !== "/v1/changes" && pathname !== "/v1/listens" && !docMatch && !deviceMatch && !listMatch) throw new HttpError(404, "Not found");
    if (docMatch && !Object.hasOwn(DOCS, docMatch[1])) throw new HttpError(404, "No such document");

    const user = await userState(await authenticate(req));

    if (pathname === "/v1/changes") {
      if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
      const since = Number(url.searchParams.get("since"));
      const wait = Math.min(MAX_WAIT_SEC, Math.max(0, Number(url.searchParams.get("wait")) || 0));
      const device = new RegExp(`^${DEVICE_ID}$`).test(url.searchParams.get("device") ?? "") ? url.searchParams.get("device") : null;
      return changes(res, user, Number.isSafeInteger(since) ? since : -1, wait, device);
    }

    if (pathname === "/v1/listens") {
      if (req.method === "GET") {
        const all = user.listens.items;
        const since = Math.min(all.length, Math.max(0, Math.floor(Number(url.searchParams.get("since")) || 0)));
        const limit = Math.min(MAX_LISTENS_PER_PAGE, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || MAX_LISTENS_PER_PAGE)));
        const page = all.slice(since, since + limit);
        return send(res, 200, { count: all.length, generation: user.listens.generation, listens: page, devices: user.listens.devices, more: since + page.length < all.length });
      }
      if (req.method === "DELETE") {
        const device = url.searchParams.get("device") ?? "";
        if (!new RegExp(`^${DEVICE_ID}$`).test(device)) throw new HttpError(400, "Whose plays?");
        const removed = await removeListens(user, device);
        return send(res, 200, { ok: true, removed, count: user.listens.items.length, generation: user.listens.generation });
      }
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      const body = await readBody(req);
      const device = body?.device;
      if (!device || typeof device !== "object" || !new RegExp(`^${DEVICE_ID}$`).test(String(device.id ?? ""))) throw new HttpError(400, "Listens come from a device");
      if (!Array.isArray(body.listens) || body.listens.length > MAX_LISTENS_PER_POST) throw new HttpError(400, `Up to ${MAX_LISTENS_PER_POST} listens at a time`);
      const from = { id: String(device.id), name: text(device.name, 80) || "?", kind: device.kind === "phone" || device.kind === "computer" ? device.kind : undefined };
      const added = await appendListens(user, from, body.listens);
      return send(res, 200, { ok: true, added, count: user.listens.items.length, generation: user.listens.generation });
    }

    if (listMatch) {
      const listId = listMatch[1];
      if (!LIST_ID.test(listId)) throw new HttpError(400, "Not a list's id");
      if (req.method === "GET") {
        const doc = await getList(user, listId);
        if (!doc) throw new HttpError(404, "No such list now");
        return send(res, 200, { doc });
      }
      if (req.method !== "PUT") throw new HttpError(405, "Method not allowed");
      const body = await readBody(req);
      if (!body?.doc || typeof body.doc !== "object" || Array.isArray(body.doc) || !Array.isArray(body.doc.tracks)) throw new HttpError(400, "A list has songs");
      await putList(user, listId, body.doc);
      return send(res, 200, { ok: true });
    }

    if (deviceMatch) {
      const [, id, commands, sub] = deviceMatch;
      if (!id) {
        if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
        const now = Date.now();
        const devices = Object.entries(user.devices)
          .filter(([, entry]) => now - entry.updatedAt <= DEVICE_KEPT_MS)
          .map(([deviceId, entry]) => ({ id: deviceId, updatedAt: entry.updatedAt, doc: entry.doc }));
        // The count of the list described: an answer arriving after a newer one is known to be older.
        return send(res, 200, { now, rev: user.devicesRev, devices });
      }
      if (commands && sub === "start") {
        if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
        const body = await readBody(req);
        if (!Array.isArray(body?.ids) || body.ids.length > MAX_COMMANDS * 2) throw new HttpError(400, "Starting which?");
        const marked = await startCommands(user, id, body.ids);
        return send(res, 200, { ok: true, marked });
      }
      if (commands && sub === "done") {
        if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
        const body = await readBody(req);
        if (!Array.isArray(body?.ids) || body.ids.length > MAX_COMMANDS * 2) throw new HttpError(400, "Done with which?");
        const removed = await doneCommands(user, id, body.ids, body.results && typeof body.results === "object" ? body.results : null);
        return send(res, 200, { ok: true, removed });
      }
      if (commands && sub) {
        if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
        const state = COMMAND_ID.test(sub) ? commandState(user, id, sub) : null;
        if (!state) throw new HttpError(404, "No such word now");
        return send(res, 200, state);
      }
      if (commands) {
        if (req.method === "GET") {
          // Kept until it says it's done with them: an answer lost on the way loses nothing.
          if (url.searchParams.get("keep") === "1") {
            const list = waitingCommands(user, id);
            return send(res, 200, { commands: list.map((c) => c.command), ids: list.map((c) => c.id), started: list.filter((c) => c.started).map((c) => c.id) });
          }
          const list = await takeCommands(user, id);
          return send(res, 200, { commands: list.map((c) => c.command) });
        }
        if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
        const body = await readBody(req);
        if (!body?.command || typeof body.command !== "object" || JSON.stringify(body.command).length > MAX_DEVICE_BYTES) {
          throw new HttpError(400, "A command is a small object");
        }
        const key = await postCommand(user, id, body.command, body.id);
        return send(res, 200, { ok: true, id: key });
      }
      if (req.method !== "PUT") throw new HttpError(405, "Method not allowed");
      const body = await readBody(req);
      if (!body?.doc || typeof body.doc !== "object" || Array.isArray(body.doc) || JSON.stringify(body.doc).length > MAX_DEVICE_BYTES) {
        throw new HttpError(400, "A device says a small object about itself");
      }
      await writeDevice(user, id, body.doc);
      return send(res, 200, { ok: true });
    }

    const name = docMatch[1];
    // Its file couldn't be read and nothing kept could stand in: nothing goes out as if it were empty, and
    // nothing is written over it, until somebody restores the file.
    if (user.broken.has(name)) throw new HttpError(423, `The service can't read its ${name} file; nothing is written over it until it's restored`);
    if (req.method === "GET") {
      const stored = user.docs[name];
      return send(res, 200, stored ? { rev: stored.rev, updatedAt: stored.updatedAt, doc: stored.doc } : { rev: 0, updatedAt: 0, doc: null });
    }
    if (req.method !== "PUT") throw new HttpError(405, "Method not allowed");
    const body = await readBody(req);
    if (!body || typeof body !== "object" || !body.doc || typeof body.doc !== "object" || Array.isArray(body.doc)) {
      throw new HttpError(400, "A document is an object");
    }
    const result = await write(user, name, body.rev, body.doc);
    if (result.conflict) {
      const { rev, updatedAt, doc } = result.current;
      return send(res, 409, { rev, updatedAt, doc });
    }
    return send(res, 200, { rev: result.next.rev, seq: result.next.seq, updatedAt: result.next.updatedAt });
  }

  return (req, res) => {
    handle(req, res).catch((err) => {
      if (!(err instanceof HttpError)) console.error("[sync] request failed:", err);
      if (res.headersSent) return res.destroy();
      send(res, err instanceof HttpError ? err.status : 500, { error: err instanceof HttpError ? err.message : "Something went wrong" });
    });
  };
}

export function createSyncServer(options) {
  return createServer(createSyncHandler(options));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8196);
  const server = createSyncServer({
    dataDir: process.env.DATA_DIR || "./data",
    jellyfinUrl: process.env.JELLYFIN_URL || "http://jellyfin:8096",
  });
  server.listen(port, () => console.log(`[sync] listening on ${port}`));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      // Long polls would hold the door open; everything on disk is already whole.
      server.closeAllConnections();
    });
  }
}
