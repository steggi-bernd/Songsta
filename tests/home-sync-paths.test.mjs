// The desktop's line to the sync service (electron/home-sync.ts) lets through every request the sync
// engine (src/lib/syncEngine.ts) makes, and nothing else. A path the engine came to use that the line
// didn't know (the shared listening history's) threw on every round and held up the whole sync.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

const stubs = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/(jellyfin|persist)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
      loader: "js",
      contents:
        a.path === "./jellyfin"
          ? `export const syncLogin = () => ({ userId: "u1", server: "http://127.0.0.1:8096", serverId: "s1", deviceId: "d1", authorization: "MediaBrowser Token=stand-in" });
             export const normalizeServer = (v) => v;`
          : `export const readData = () => ({ address: "http://127.0.0.1:8196" }); export const writeData = async () => {};`,
    }));
  },
};

const asked = [];
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../electron/home-sync.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  external: ["electron"],
  plugins: [stubs],
});
const line = { exports: {} };
vm.runInNewContext(outputFiles[0].text, {
  module: line,
  exports: line.exports,
  require,
  console,
  URL,
  AbortSignal,
  fetch: async (url, init) => {
    asked.push(`${init.method} ${String(url)}`);
    return { status: 200, text: async () => "{}" };
  },
});
const { request } = line.exports;

/** Every request the engine makes, with its placeholders filled in as it would. */
function enginePaths() {
  const source = fs.readFileSync(new URL("../src/lib/syncEngine.ts", import.meta.url), "utf8");
  const found = [];
  for (const m of source.matchAll(/(?:call|request)\("(GET|PUT|POST)",\s*(?:"([^"]+)"|`([^`]+)`)/g)) {
    const path = (m[2] ?? m[3]).replace(/\/docs\/\$\{[^}]+\}/g, "/docs/order").replace(/\$\{[^}]+\}/g, "1");
    found.push({ method: m[1], path });
  }
  return found;
}

test("every request the engine makes gets through", async () => {
  const paths = enginePaths();
  assert.ok(paths.length >= 20, `the engine's requests are found (${paths.length})`);
  for (const p of ["/v1/listens", "/v1/listens?since=1&limit=1", "/v1/changes?since=1&wait=1&device=1"]) {
    assert.ok(paths.some((e) => e.path === p), `${p} is among them`);
  }
  for (const { method, path } of paths) {
    await assert.doesNotReject(request(method, path, method === "GET" ? undefined : {}, 1000), `${method} ${path}`);
  }
  assert.ok(asked.includes("POST http://127.0.0.1:8196/v1/listens"));
  assert.ok(asked.includes("GET http://127.0.0.1:8196/v1/listens?since=1&limit=1"));
});

test("taking this computer's plays off the service, on asking: that one DELETE gets through", async () => {
  await assert.doesNotReject(request("DELETE", "/v1/listens?device=pc-1234", undefined, 1000));
  assert.ok(asked.includes("DELETE http://127.0.0.1:8196/v1/listens?device=pc-1234"));
});

test("and nothing else", async () => {
  for (const [method, path] of [
    ["GET", "/v1/listens/../docs"],
    ["GET", "/v1/listens?since=1&limit=1&extra=1"],
    ["DELETE", "/v1/listens"],
    ["DELETE", "/v1/docs/playlists"],
    ["DELETE", "/v1/listens?device=a&since=1"],
    ["DELETE", "/v1/devices/pc"],
    ["GET", "/v1/other"],
    ["POST", "/health"],
    ["GET", "http://elsewhere/v1/docs/order"],
  ]) {
    await assert.rejects(request(method, path, undefined, 1000), /Not a request for the sync service/, `${method} ${path}`);
  }
});
