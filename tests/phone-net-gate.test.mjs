// The phone's switches (mobile/src/netGate.ts): every request of the app's own passes them; your server,
// the sync service and the home network always go, a server address typed in goes while it's set up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const mobile = fileURLToPath(new URL("../mobile/src/", import.meta.url));
const lib = (name) => fileURLToPath(new URL(`../src/lib/${name}.ts`, import.meta.url)).replace(/\\/g, "/");
const stubs = {
  shared: `export { hostsOf, judgeRequest, NET_SERVICES } from "${lib("netServices")}"; export { defaultSyncAddress } from "${lib("syncEngine")}";`,
  "stores/settings": `export const useSettings = { getState: () => globalThis.__phone.settings };`,
  "stores/session": `export const useSession = { getState: () => ({ session: globalThis.__phone.session }) };`,
  sync: `export const useSync = { getState: () => ({ customAddress: globalThis.__phone.custom }) };`,
};
const out = await build({
  stdin: { contents: `export { allowedUrl, installNetGate, trustEntered } from "./netGate"; export { NET_SERVICES } from "./shared";`, resolveDir: mobile, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        for (const [name, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`[\\\\/]mobile[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`);
          b.onLoad({ filter }, () => ({ contents, resolveDir: mobile, loader: "ts" }));
        }
      },
    },
  ],
});
const gate = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
const PHONE = gate.NET_SERVICES.filter((s) => s.phone);

const session = { server: "https://jellyfin.example.work", home: "http://192.168.1.50:8096", away: "https://jellyfin.example.work" };
globalThis.__phone = { settings: { netOwnOnly: false, netOff: [] }, session, custom: "" };

test("every combination of the phone's switches: each service by its own switch, your servers always", () => {
  const ids = PHONE.map((s) => s.id);
  assert.ok(ids.length >= 5, "the phone's services are marked");
  for (let mask = 0; mask < 2 ** ids.length; mask++) {
    for (const netOwnOnly of [false, true]) {
      const netOff = ids.filter((_, i) => mask & (2 ** i));
      globalThis.__phone.settings = { netOwnOnly, netOff };
      for (const s of PHONE) {
        for (const name of s.hosts) {
          const url = `https://${name.startsWith(".") ? `x${name}` : name}/q`;
          assert.equal(gate.allowedUrl(url), !netOwnOnly && !netOff.includes(s.id), `${url} with ${JSON.stringify({ netOwnOnly, netOff })}`);
        }
      }
      for (const url of ["https://jellyfin.example.work/Items", "http://192.168.1.50:8096/Audio/1", "https://jellyfin.example.work:8196/v1/changes", "http://10.0.0.9/x"]) assert.equal(gate.allowedUrl(url), true, url);
      assert.equal(gate.allowedUrl("https://somewhere.example/x"), !netOwnOnly);
    }
  }
});

test("a server address typed in goes through with only my own servers on, for ten minutes", () => {
  const realNow = Date.now;
  let now = Date.UTC(2026, 10, 15, 12);
  Date.now = () => now;
  try {
    globalThis.__phone = { settings: { netOwnOnly: true, netOff: [] }, session: null, custom: "" };
    assert.equal(gate.allowedUrl("https://music.example.net/System/Info/Public"), false, "before it was typed in");
    gate.trustEntered("music.example.net");
    assert.equal(gate.allowedUrl("https://music.example.net/System/Info/Public"), true);
    now += 9 * 60_000;
    assert.equal(gate.allowedUrl("http://music.example.net:8096/Users/AuthenticateByName"), true);
    now += 2 * 60_000;
    assert.equal(gate.allowedUrl("https://music.example.net/Items"), false, "not signed in after ten minutes");
    // Signed in: it's the session's, for as long as it lasts.
    globalThis.__phone.session = { server: "https://music.example.net", home: "https://music.example.net" };
    assert.equal(gate.allowedUrl("https://music.example.net/Items"), true);
    // The sync address typed in counts the moment it's saved.
    globalThis.__phone.custom = "https://sync.example.org";
    assert.equal(gate.allowedUrl("https://sync.example.org/v1/changes"), true);
    for (const odd of ["", null, 7]) gate.trustEntered(odd);
    assert.equal(gate.allowedUrl("https://lrclib.net/api/get"), false);
  } finally {
    Date.now = realNow;
    globalThis.__phone = { settings: { netOwnOnly: false, netOff: [] }, session, custom: "" };
  }
});

test("the phone's fetch: held back when switched off, through when on", async () => {
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return { ok: true };
  };
  try {
    gate.installNetGate();
    globalThis.__phone.settings = { netOwnOnly: false, netOff: ["lrclib"] };
    await assert.rejects(globalThis.fetch("https://lrclib.net/api/get?track_name=x"));
    await globalThis.fetch("https://musicbrainz.org/ws/2/artist?query=x");
    await globalThis.fetch(new URL("https://jellyfin.example.work/Items"));
    assert.deepEqual(asked, ["https://musicbrainz.org/ws/2/artist?query=x", "https://jellyfin.example.work/Items"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
