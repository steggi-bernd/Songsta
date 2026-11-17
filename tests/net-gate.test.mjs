// The gate every request of the desktop passes (electron/net-gate.ts): a service switched off gets
// nothing, your own servers always go, and the connection log notes service and address name only.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const services = await build({ stdin: { contents: `export * from "./netServices";`, resolveDir: lib, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { NET_SERVICES } = await import(`data:text/javascript;base64,${Buffer.from(services.outputFiles[0].text).toString("base64")}`);

/** `clock`: { now } stands for the time, where a test needs it to pass. */
async function load(settings, clock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "songsta-net-gate-"));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  if (settings) fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify({ state: settings, version: 0 }));
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL("../electron/net-gate.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false });
  const asked = [];
  const sandbox = {
    module: { exports: {} },
    console,
    URL,
    Date: clock ? class extends Date { static now() { return clock.now; } } : Date,
    setTimeout,
    clearTimeout,
    Promise,
    require: (name) => (name === "electron" ? { app: { getPath: () => root } } : require(name)),
    fetch: async (url) => {
      asked.push(String(url));
      return { ok: true, status: 200 };
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(outputFiles[0].text, sandbox);
  return { gate: sandbox.module.exports, sandbox, asked, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("before the page says anything, the saved settings hold: a switched-off service gets nothing", async () => {
  const { gate, sandbox, asked, close } = await load({ netOff: ["genius"], netOwnOnly: false, recordListening: false });
  try {
    gate.installNetGate(() => ["https://jellyfin.example.work"]);
    await sandbox.fetch("https://musicbrainz.org/ws/2/release-group?query=x");
    await assert.rejects(sandbox.fetch("https://genius.com/api/search/multi?q=secret+song"), (err) => err.name === "NetBlocked");
    await sandbox.fetch("https://jellyfin.example.work/Items?api_key=x");
    assert.deepEqual(asked, ["https://musicbrainz.org/ws/2/release-group?query=x", "https://jellyfin.example.work/Items?api_key=x"]);
    assert.equal(gate.privacy().recordListening, false, "plays not kept, as saved");
  } finally {
    close();
  }
});

test("only my own servers: nothing but your server and the home network", async () => {
  const { gate, sandbox, asked, close } = await load(null);
  try {
    gate.installNetGate(() => ["https://jellyfin.example.work"]);
    gate.setPrivacy({ ownOnly: true, off: [], recordListening: true });
    await assert.rejects(sandbox.fetch("https://lrclib.net/api/get"));
    await assert.rejects(sandbox.fetch("https://somewhere.example/x"));
    await sandbox.fetch("https://jellyfin.example.work/Audio/1/stream.mp3");
    await sandbox.fetch("http://192.168.1.50:8196/v1/changes?since=0&wait=0");
    assert.equal(asked.length, 2);
    // And open again.
    gate.setPrivacy({ ownOnly: false, off: [], recordListening: true });
    await sandbox.fetch("https://lrclib.net/api/get");
    assert.equal(asked.length, 3);
  } finally {
    close();
  }
});

test("the log: when, which service, which name; no paths, no queries; your own servers only counted", async () => {
  const { gate, sandbox, close } = await load(null);
  try {
    gate.installNetGate(() => ["https://jellyfin.example.work"]);
    gate.setPrivacy({ ownOnly: false, off: ["tidal"], recordListening: true });
    await sandbox.fetch("https://musicbrainz.org/ws/2/artist?query=Some+Artist");
    await sandbox.fetch("https://api.tidal.com/v1/search?query=private").catch(() => undefined);
    await sandbox.fetch("https://jellyfin.example.work/Users/Me");
    const activity = JSON.parse(JSON.stringify(gate.netActivity()));
    assert.deepEqual(
      activity.log.map((e) => [e.service, e.host, e.blocked]),
      [
        ["tidal", "api.tidal.com", true],
        ["musicbrainz", "musicbrainz.org", false],
      ]
    );
    assert.ok(!JSON.stringify(activity).includes("Some+Artist") && !JSON.stringify(activity).includes("private"), "no query in the log");
    assert.deepEqual(activity.services.tidal, { count: 0, blocked: 1, last: activity.services.tidal.last });
    assert.equal(activity.own.count, 1);
    assert.equal(gate.passes("https://images.genius.com/x.jpg"), true, "a page's picture is judged the same way");
    gate.setPrivacy({ ownOnly: false, off: ["genius"], recordListening: true });
    assert.equal(gate.passes("https://images.genius.com/x.jpg"), false);
  } finally {
    close();
  }
});

test("random combinations of every switch: a request goes out exactly when its switch says so, and the log says the same", async () => {
  const { gate, sandbox, asked, close } = await load(null);
  try {
    gate.installNetGate(() => ["https://jellyfin.example.work", "http://192.168.1.50:8196"]);
    const ids = NET_SERVICES.map((s) => s.id);
    let seed = 20261115;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = (list) => list[Math.floor(rand() * list.length)];
    for (let round = 0; round < 600; round++) {
      const off = ids.filter(() => rand() < 0.5);
      const ownOnly = rand() < 0.2;
      const recordListening = rand() < 0.5;
      gate.setPrivacy({ ownOnly, off, recordListening });
      assert.equal(gate.privacy().recordListening, recordListening);
      const kind = rand();
      const before = asked.length;
      if (kind < 0.7) {
        const service = pick(NET_SERVICES);
        const name = pick(service.hosts);
        const host = name.startsWith(".") ? `cdn${name}` : name;
        const goes = !ownOnly && !off.includes(service.id);
        const outcome = await sandbox.fetch(`https://${host}/q?song=private`).then(() => "out", (err) => err.name);
        assert.equal(outcome, goes ? "out" : "NetBlocked", `${host} with ${JSON.stringify({ ownOnly, off })}`);
        assert.equal(asked.length - before, goes ? 1 : 0);
        const last = gate.netActivity().log[0];
        assert.deepEqual([last.service, last.host, last.blocked], [service.id, host, !goes]);
      } else if (kind < 0.85) {
        // Your own servers and the home network: whatever is switched off.
        await sandbox.fetch(pick(["https://jellyfin.example.work/Items", "http://192.168.1.50:8196/v1/changes", "http://10.0.0.7/description.xml"]));
        assert.equal(asked.length - before, 1);
      } else {
        const outcome = await sandbox.fetch("https://somewhere.example/x").then(() => "out", (err) => err.name);
        assert.equal(outcome, ownOnly ? "NetBlocked" : "out");
      }
    }
    const activity = gate.netActivity();
    assert.ok(activity.own.count > 50, "your own servers are counted, not logged one by one");
    assert.ok(!JSON.stringify(activity).includes("private"), "no query in the log");
  } finally {
    close();
  }
});

test("a server address typed in goes through with only my own servers on while it's set up; saved, it's yours", async () => {
  const clock = { now: Date.UTC(2026, 10, 15, 12) };
  const { gate, sandbox, asked, close } = await load(null, clock);
  try {
    let saved = ["https://jellyfin.example.work"];
    gate.installNetGate(() => saved);
    gate.setPrivacy({ ownOnly: true, off: [], recordListening: true });
    await assert.rejects(sandbox.fetch("https://music.example.net/System/Info/Public"), (err) => err.name === "NetBlocked");
    // Typed in without http:// and with a port, as people do.
    gate.trustEntered("music.example.net:8920");
    await sandbox.fetch("https://music.example.net:8920/System/Info/Public");
    clock.now += 9 * 60_000;
    await sandbox.fetch("https://music.example.net:8920/Users/AuthenticateByName");
    assert.equal(asked.length, 2);
    // Not saved after ten minutes: no longer let through by itself.
    clock.now += 2 * 60_000;
    await assert.rejects(sandbox.fetch("https://music.example.net/Items"), (err) => err.name === "NetBlocked");
    // Saved: the list is read again at once (main.ts says so after every login), not only after 20 s.
    saved = ["https://jellyfin.example.work", "https://music.example.net:8920"];
    gate.ownServersChanged();
    await sandbox.fetch("https://music.example.net/Items");
    assert.equal(asked.length, 3);
    // Nothing else comes along with it.
    for (const odd of ["", "   ", null, 42, { toString: () => "evil.example" }]) gate.trustEntered(odd);
    await assert.rejects(sandbox.fetch("https://evil.example/x"));
    await assert.rejects(sandbox.fetch("https://lrclib.net/api/get"));
  } finally {
    close();
  }
});

test("signed out of the last server: it's no longer one of yours", async () => {
  const { gate, sandbox, asked, close } = await load(null);
  try {
    let saved = ["https://jellyfin.example.work"];
    gate.installNetGate(() => saved);
    gate.setPrivacy({ ownOnly: true, off: [], recordListening: true });
    await sandbox.fetch("https://jellyfin.example.work/Items");
    saved = [];
    gate.ownServersChanged();
    await assert.rejects(sandbox.fetch("https://jellyfin.example.work/Items"), (err) => err.name === "NetBlocked");
    assert.equal(asked.length, 1);
    // A list that can't be read right now (a login being written) keeps the last one.
    saved = ["https://jellyfin.example.work"];
    gate.ownServersChanged();
    await sandbox.fetch("https://jellyfin.example.work/Items");
    gate.installNetGate(() => {
      throw new Error("being written");
    });
    gate.ownServersChanged();
    await sandbox.fetch("https://jellyfin.example.work/Items");
    assert.equal(asked.length, 3);
  } finally {
    close();
  }
});
