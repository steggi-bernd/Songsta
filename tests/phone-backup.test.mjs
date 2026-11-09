// The phone's backup (mobile/src/backup.ts): one file with what the phone keeps for itself, for a
// new start after the app was uninstalled (a new signature). What's put back takes the place of what's
// there, except what belongs to this phone: the install's own settings, downloads whose files are
// here, likes and plays of its own files, the sync services it found.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function load(file) {
  const out = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false, logLevel: "error" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const { backupFileName, backupSummary, foldersToPick, makeBackup, readBackup, restoreFiles, MAX_BACKUP_BYTES } = await load("../mobile/src/backup.ts");

const PICTURE = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const playlists = {
  playlists: [{ id: "pl_1", name: "Road", tracks: [{ id: "s1", title: "One", artist: "A", album: "X", duration: 100 }], createdAt: 1 }],
  folders: [],
  deletionSync: { clock: 3, adds: { "playlists:pl_1": 2 }, deletes: {}, edits: {}, clears: {} },
};
const albumEdits = {
  artists: { "x|a": "A, B" },
  mergedInto: { "y|a": "x|a" },
  aliases: {},
  songs: {},
  titles: { "x|a": "X (Deluxe)" },
  covers: { "x|a": "file:///data/user/0/app/files/album-pictures/aa-500.jpg", "z|c": "file:///data/user/0/app/files/album-pictures/bb-600.jpg" },
  stamps: { titles: { "x|a": { at: 400 } } },
  coverStamps: { "x|a": 500, "z|c": 600, "w|d": 700 },
};

/** A phone as the stores left it. */
function phoneFiles() {
  return {
    "playlists.json": playlists,
    "album-edits.json": albumEdits,
    "library-sync.json": { clock: 900, pinsAt: 800, pins: ["album:x|a", "liked"], merges: { order: { rev: 4, changed: false } } },
    "explore.json": { tab: "artists", layout: "list", sorts: { albums: "name", artists: "name", genres: "name" }, groups: { albums: [{ id: "g1", name: "Live", items: ["album:x|a"] }], artists: [], genres: [] } },
    "played.json": { at: { "album:x|a": 100, "playlist:pl_1": 300 }, seeded: true },
    "liked-order.json": [{ id: "s1", title: "One", artist: "A", album: "X", duration: 100 }],
    "muted.json": { at: 50, tracks: [] },
    "quality.json": { mode: "auto", keep24Bit: true, leveling: "album" },
    "devices.json": { found: [{ id: "tv", kind: "cast", name: "TV", model: "", host: "192.168.1.9", port: 8009 }], names: { tv: "Living room" } },
    "settings.json": { accent: "teal", fadeSeconds: 4, libraryGroups: [{ id: "lg", name: "Mine", items: ["playlist:pl_1"] }], setupDone: true, lastVersion: "1.5.0", pairedTvs: ["tv"], pairHinted: ["tv"], newVersion: { seen: "1.5.0" } },
    "downloads.json": { kept: { s1: { file: "s1.flac", bytes: 10, compact: false } }, loading: { s2: { job: 3 } }, covers: { c: "c.jpg" }, quality: "compact", overMobile: true, lists: { "album:x|a": true }, notWanted: { s9: true }, listsNoted: true },
    "sync-settings.json": { customAddress: "http://pi:8196", serviceNoted: "old", linked: ["srv|http://pi:8196"] },
    "library.json": { tracks: [{ id: "s1" }], hashes: { s1: "h" }, favorites: ["s1", "local:abc", "local:def"], counts: { s1: { plays: 9, lastAt: 1 }, "local:abc": { plays: 2, lastAt: 7 } }, artistIds: {} },
    "player.json": { queue: ["s1"] },
    "outbox.json": { likes: { s1: true }, plays: [] },
    "local-music.json": { folders: [{ uri: "content://tree/Music", name: "Music" }], files: [], withoutServer: false },
  };
}

function backupOf(files = phoneFiles()) {
  return makeBackup({
    read: (name) => files[name] ?? null,
    picture: (key) => (key === "x|a" ? PICTURE : null),
    folders: [{ uri: "content://tree/Music", name: "Music" }],
    appVersion: "1.6.0",
    now: new Date("2026-11-09T20:00:00Z"),
  });
}

test("a backup holds what the phone keeps for itself, and nothing of the install's or the server's", () => {
  const backup = backupOf();
  assert.equal(backup.app, "songsta-phone");
  assert.equal(backup.appVersion, "1.6.0");
  assert.equal(backup.exportedAt, "2026-11-09T20:00:00.000Z");
  for (const name of ["playlists.json", "album-edits.json", "library-sync.json", "explore.json", "played.json", "liked-order.json", "muted.json", "quality.json", "devices.json"]) {
    assert.deepEqual(backup.files[name], phoneFiles()[name], name);
  }
  // Not the login, the queue, what waits for the server, the folders' permissions.
  for (const name of ["player.json", "outbox.json", "local-music.json"]) assert.equal(backup.files[name], undefined, name);
  const settings = backup.files["settings.json"];
  assert.equal(settings.accent, "teal");
  assert.deepEqual(settings.libraryGroups, [{ id: "lg", name: "Mine", items: ["playlist:pl_1"] }]);
  for (const key of ["setupDone", "lastVersion", "pairedTvs", "pairHinted", "newVersion"]) assert.equal(key in settings, false, key);
  assert.deepEqual(backup.files["downloads.json"], { kept: { s1: { file: "s1.flac", bytes: 10, compact: false } }, quality: "compact", overMobile: true, lists: { "album:x|a": true }, notWanted: { s9: true } });
  assert.deepEqual(backup.files["sync-settings.json"], { customAddress: "http://pi:8196", linked: ["srv|http://pi:8196"] });
  // The server's songs and likes are the server's: only the phone's own files' likes and plays.
  assert.deepEqual(backup.files["library.json"], { favorites: ["local:abc", "local:def"], counts: { "local:abc": { plays: 2, lastAt: 7 } } });
  // A picture that can't be read stays out; the one that can comes along.
  assert.deepEqual(backup.pictures, { "x|a": PICTURE });
  assert.deepEqual(backup.folders, [{ uri: "content://tree/Music", name: "Music" }]);
});

test("a phone that never wrote a file has nothing of it in its backup", () => {
  const backup = backupOf({ "settings.json": { accent: "blue", setupDone: true } });
  assert.deepEqual(Object.keys(backup.files), ["settings.json"]);
  assert.deepEqual(backup.pictures, {});
});

test("read back as written; other files and the computer's backup are told apart", () => {
  const backup = backupOf();
  assert.deepEqual(readBackup(JSON.stringify(backup)), backup);
  assert.equal(readBackup("not json"), "not-a-backup");
  assert.equal(readBackup("[1,2]"), "not-a-backup");
  assert.equal(readBackup(JSON.stringify({ app: "other", version: 1 })), "not-a-backup");
  assert.equal(readBackup(JSON.stringify({ app: "bytune", version: 1, settings: {} })), "computer-backup");
  assert.equal(readBackup(JSON.stringify({ ...backup, version: 2 })), "too-new");
  assert.equal(readBackup(" ".repeat(MAX_BACKUP_BYTES + 1)), "too-big");
  // What isn't one of the phone's files, or no picture, is left out.
  const odd = readBackup(JSON.stringify({ ...backup, files: { ...backup.files, "session.json": { token: "t" }, "quality.json": "loud" }, pictures: { a: "javascript:x", b: 5, c: PICTURE }, folders: [{ uri: 1 }, { uri: "u", name: "N", extra: 1 }] }));
  assert.equal(odd.files["session.json"], undefined);
  assert.equal(odd.files["quality.json"], undefined);
  assert.deepEqual(odd.pictures, { c: PICTURE });
  assert.deepEqual(odd.folders, [{ uri: "u", name: "N" }]);
});

test("put back on a phone just set up: everything as it was, the pictures written anew", () => {
  const backup = readBackup(JSON.stringify(backupOf()));
  const placed = [];
  const fresh = { "settings.json": { setupDone: true, lastVersion: "1.6.0", accent: "violet" } };
  const out = restoreFiles(backup, {
    read: (name) => fresh[name] ?? null,
    placePicture: (key, data, at) => {
      placed.push([key, data, at]);
      return `file:///new/album-pictures/${key}-${at}.jpg`;
    },
  });
  for (const name of ["playlists.json", "explore.json", "liked-order.json", "muted.json", "quality.json", "devices.json"]) assert.deepEqual(out[name], phoneFiles()[name], name);
  assert.deepEqual(placed, [["x|a", PICTURE, 500]]);
  const edits = out["album-edits.json"];
  assert.deepEqual(edits.covers, { "x|a": "file:///new/album-pictures/x|a-500.jpg" });
  // The picture that didn't come along says nothing, so the computer's stays; a picture taken away stays taken away.
  assert.deepEqual(edits.coverStamps, { "x|a": 500, "w|d": 700 });
  assert.deepEqual(edits.titles, albumEdits.titles);
  assert.deepEqual(edits.stamps, albumEdits.stamps);
  // Merged afresh at the next look.
  assert.deepEqual(out["library-sync.json"], { clock: 900, pinsAt: 800, pins: ["album:x|a", "liked"], merges: {} });
  const settings = out["settings.json"];
  assert.equal(settings.accent, "teal");
  assert.equal(settings.fadeSeconds, 4);
  assert.equal(settings.setupDone, true);
  assert.equal(settings.lastVersion, "1.6.0", "this install's");
  assert.equal("pairedTvs" in settings, false);
  assert.deepEqual(out["downloads.json"].lists, { "album:x|a": true });
  assert.deepEqual(out["downloads.json"].kept, { s1: { file: "s1.flac", bytes: 10, compact: false } }, "comes again at the next opening");
  assert.equal(out["downloads.json"].listsNoted, true);
  assert.equal(out["downloads.json"].quality, "compact");
  assert.deepEqual(out["sync-settings.json"], { customAddress: "http://pi:8196", linked: ["srv|http://pi:8196"] });
  assert.deepEqual(out["library.json"], { tracks: [], hashes: {}, favorites: ["local:abc", "local:def"], counts: { "local:abc": { plays: 2, lastAt: 7 } }, artistIds: {} });
  assert.deepEqual(out["played.json"], { at: { "album:x|a": 100, "playlist:pl_1": 300 }, seeded: true });
});

test("put back on a phone in use: what's this phone's stays, nothing doubles", () => {
  const backup = readBackup(JSON.stringify(backupOf()));
  const here = {
    "settings.json": { accent: "blue", setupDone: true, lastVersion: "1.6.0", pairedTvs: ["tv2"], newVersion: { seen: "1.6.0" } },
    "downloads.json": { kept: { s1: { file: "s1-new.flac", bytes: 11, compact: true }, s5: { file: "s5.flac", bytes: 5, compact: false } }, loading: { s6: { job: 9 } }, covers: { d: "d.jpg" }, quality: "original", overMobile: false, lists: { "playlist:pl_2": true }, notWanted: {}, listsNoted: false },
    "sync-settings.json": { customAddress: "", serviceNoted: "api", linked: ["other|", "srv|http://pi:8196"] },
    "library.json": { tracks: [{ id: "s7" }], hashes: {}, favorites: ["local:def", "s7"], counts: { s7: { plays: 1, lastAt: 2 }, "local:abc": { plays: 5, lastAt: 3 } }, artistIds: { A: "1" } },
    "played.json": { at: { "album:x|a": 200, "mix:m": 50 }, seeded: false },
    "library-sync.json": { clock: 5000, merges: { order: { rev: 9, changed: true } } },
  };
  const out = restoreFiles(backup, { read: (name) => here[name] ?? null, placePicture: () => "file:///p.jpg" });
  const settings = out["settings.json"];
  assert.equal(settings.accent, "teal", "the backup's choice");
  assert.deepEqual(settings.pairedTvs, ["tv2"], "this install's pairing");
  assert.deepEqual(settings.newVersion, { seen: "1.6.0" });
  const downloads = out["downloads.json"];
  // The files here stay known as they are; what's in progress goes on.
  assert.deepEqual(downloads.kept, { s1: { file: "s1-new.flac", bytes: 11, compact: true }, s5: { file: "s5.flac", bytes: 5, compact: false } });
  assert.deepEqual(downloads.loading, { s6: { job: 9 } });
  assert.deepEqual(downloads.covers, { d: "d.jpg" });
  assert.deepEqual(downloads.lists, { "playlist:pl_2": true, "album:x|a": true });
  assert.deepEqual(downloads.notWanted, { s9: true });
  assert.equal(downloads.quality, "compact");
  assert.equal(downloads.overMobile, true);
  const sync = out["sync-settings.json"];
  assert.equal(sync.serviceNoted, "api");
  assert.equal(sync.customAddress, "http://pi:8196");
  assert.deepEqual(sync.linked, ["other|", "srv|http://pi:8196"], "once each");
  const library = out["library.json"];
  assert.deepEqual(library.tracks, [{ id: "s7" }], "the server's copy stays");
  assert.deepEqual(library.artistIds, { A: "1" });
  assert.deepEqual(library.favorites, ["local:abc", "local:def", "s7"]);
  assert.deepEqual(library.counts, { s7: { plays: 1, lastAt: 2 }, "local:abc": { plays: 5, lastAt: 7 } });
  assert.deepEqual(out["played.json"], { at: { "album:x|a": 200, "mix:m": 50, "playlist:pl_1": 300 }, seeded: true });
  assert.equal(out["library-sync.json"].clock, 5000, "moments from here on stay after what this phone saw");
  assert.deepEqual(out["library-sync.json"].merges, {});
});

test("an address entered here stays when the backup has none", () => {
  const files = phoneFiles();
  files["sync-settings.json"] = { customAddress: "" };
  const backup = readBackup(JSON.stringify(backupOf(files)));
  const out = restoreFiles(backup, { read: (name) => (name === "sync-settings.json" ? { customAddress: "http://nas:8196" } : null), placePicture: () => null });
  assert.equal(out["sync-settings.json"].customAddress, "http://nas:8196");
  // No picture could be written: the album keeps its edits, without a picture.
  assert.deepEqual(out["album-edits.json"].covers, {});
  assert.deepEqual(out["album-edits.json"].coverStamps, { "w|d": 700 });
});

test("a phone without local songs gets no library file from a backup", () => {
  const files = phoneFiles();
  files["library.json"] = { tracks: [], hashes: {}, favorites: ["s1"], counts: { s1: { plays: 1, lastAt: 1 } }, artistIds: {} };
  const out = restoreFiles(readBackup(JSON.stringify(backupOf(files))), { read: () => null, placePicture: () => null });
  assert.equal(out["library.json"], undefined);
});

test("the folders to pick again, the file's name, and what the question says", () => {
  const backup = backupOf();
  assert.deepEqual(foldersToPick(backup, []), ["Music"]);
  assert.deepEqual(foldersToPick(backup, [{ uri: "content://tree/Music", name: "Music" }]), []);
  assert.equal(backupFileName(new Date(2026, 10, 9, 21, 5)), "songsta-phone-backup-2026-11-09.json");
  assert.deepEqual(backupSummary(backup), { playlists: 1, albumEdits: 3, groups: 2, at: Date.parse("2026-11-09T20:00:00Z") });
});
