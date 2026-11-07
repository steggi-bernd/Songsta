import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Bundle a module with the given relative imports stubbed. */
async function bundle(entry, stubs, externals = []) {
  fs.mkdirSync(".test-build", { recursive: true });
  const outfile = path.resolve(".test-build", `sec-${path.basename(entry)}.cjs`.replace(/\.ts$/, ".cjs"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: externals,
    plugins: [{
      name: "sec-stub",
      setup(b) {
        // Intercept ALL relative imports: keys get their stub source, anything
        // else gets an empty module, so nothing heavy enters these bundles.
        b.onResolve({ filter: /^\.\/|^\.\.\// }, (a) => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
          contents: a.path.endsWith("artwork")
            ? "export function artworkUrlOk(u){return /^(https?:\\/\\/|data:image\\/|blob:|localart:)/i.test(u);}"
            : stubs[a.path.replace(/^.*\//, "").replace(/\.ts$/, "")] ?? "module.exports = {};",
          loader: "js",
        }));
      },
    }],
  });
  fs.writeFileSync(outfile, outputFiles[0].text);
  return outfile;
}

test("canvas manifest URLs are https-only", async () => {
  const outfile = await bundle("../electron/canvas.ts", {}, []);
  const { canvasUrlOk } = require(outfile);
  assert.equal(canvasUrlOk("https://example.com/v.mp4"), true);
  assert.equal(canvasUrlOk("http://example.com/v.mp4"), false, "http must not enter <video src>");
  assert.equal(canvasUrlOk("file://attacker.com/share/v.mp4"), false, "file/UNC must not enter <video src>");
  assert.equal(canvasUrlOk("file:///C:/Users/x/v.mp4"), false);
  assert.equal(canvasUrlOk("javascript:alert(1)"), false);
  assert.equal(canvasUrlOk("not a url"), false);
  assert.equal(canvasUrlOk(""), false);
});

test("artwork scheme gate: web/data/blob/localart only, hostile schemes collapse to empty", async () => {
  const outfile = await bundle("../src/lib/artwork.ts", {}, []);
  const { upgradeArtwork } = require(outfile);
  const ok = "https://example.com/covers/x.jpg";
  assert.equal(upgradeArtwork(ok), ok);
  assert.equal(upgradeArtwork("localart://0123456789abcdef.jpg"), "localart://0123456789abcdef.jpg");
  assert.ok(upgradeArtwork("data:image/png;base64,AAAA").startsWith("data:image/"));
  assert.equal(upgradeArtwork("javascript:alert(1)"), "", "javascript: must not reach <img src>");
  assert.equal(upgradeArtwork("file://attacker.com/share/x.jpg"), "", "file/UNC must not reach <img src>");
  assert.equal(upgradeArtwork("file:///C:/Users/x/secret.png"), "");
  assert.equal(upgradeArtwork("data:text/html,<script>alert(1)</script>"), "", "non-image data URLs must not reach <img src>");
  assert.equal(upgradeArtwork("ftp://x/y.jpg"), "");
  assert.equal(upgradeArtwork(undefined), "");
});

test("stream proxy: origins outside the app are refused; media/null/dev still allowed", async () => {
  const outfile = await bundle("../electron/stream-proxy.ts", { "local-library": "export const localStreamPath = () => null;" }, []);
  const { originAllowed } = require(outfile);
  assert.equal(originAllowed(undefined, "127.0.0.1:5000"), true, "media element sends no Origin");
  assert.equal(originAllowed("null", "127.0.0.1:5000"), true, "packaged renderer fetch (file:// origin)");
  assert.equal(originAllowed("http://127.0.0.1:5173", "127.0.0.1:5000"), true, "dev renderer");
  assert.equal(originAllowed("http://localhost:5173", "localhost:5000"), true);
  assert.equal(originAllowed("https://evil.com", "127.0.0.1:5000"), false, "hostile website origin must be refused");
  assert.equal(originAllowed("https://evil.com", undefined), false);
  assert.equal(originAllowed(undefined, "evil.com"), false, "DNS-rebound Host must be refused");
});

test("download filenames: traversal, reserved names and bidi spoofing are neutralized", async () => {
  const outfile = await bundle("../electron/downloads.ts", {
    persist: "export const readData = () => null; export const writeData = async () => {}; export const writeDataSync = () => {}; export const drainWrites = async () => {}; export const resetAppData = async () => {};",
  }, ["electron", "music-metadata", "./stream-proxy", "./canvas", "./local-library"]);
  const { sanitizeFilename } = require(outfile);
  for (const hostile of ["../../etc/passwd", "C:\\Windows\\evil", "..", "CON", "NUL.mp3", "aux"]) {
    const s = sanitizeFilename(hostile);
    assert.equal(s.includes("/") || s.includes("\\"), false, `separators must be gone: ${hostile}`);
    assert.equal(/^(con|nul|aux|com\d|lpt\d)(\.\w+)?$/i.test(s), false, `reserved device name must not survive alone: ${hostile}`);
  }
  assert.equal(sanitizeFilename("Evil\u202Eexe.m4a").includes("\u202E"), false, "bidi override must be stripped");
  assert.equal(sanitizeFilename(""), "track", "empty names fall back");
  assert.ok(sanitizeFilename("x".repeat(5000)).length <= 120, "names are length-capped");
});

test("local-library scan bounds hostile tag strings and oversize artwork", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-sec-lib-"));
  const store = new Map();
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/local-library.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{
      name: "sec-lib-stub",
      setup(b) {
        b.onResolve({ filter: /^electron$|^\.\/persist$|^\.\/local-paths$|^music-metadata$/ }, (a) => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
          contents: a.path === "electron" ? "module.exports = globalThis.__es;"
            : a.path === "./persist" ? "module.exports = { readData: () => null, writeData: async (n, v) => { globalThis.__store.set(n, v); }, writeDataSync: () => {} };"
            : a.path === "./local-paths" ? "export const isUnderPath = (p, root) => p.startsWith(root); export const foldPathCase = (p) => p.toLowerCase();"
            : "module.exports = globalThis.__parse;",
          loader: "js",
        }));
      },
    }],
  });
  const outfile = path.resolve(".test-build", "sec-lib-full.cjs");
  fs.writeFileSync(outfile, outputFiles[0].text);
  globalThis.__es = { app: { getPath: () => path.join(dir, "userdata") } };
  globalThis.__store = store;
  globalThis.__parse = {
    parseFile: async () => ({
      common: {
        title: "T".repeat(5000),
        artist: "A".repeat(5000),
        album: "B".repeat(5000),
        genre: ["G".repeat(5000)],
        // A hostile 64 MB APIC frame must not be extracted or stored.
        picture: [{ data: new Uint8Array(64 * 1024 * 1024).fill(1), format: "image/jpeg" }],
      },
      format: { duration: 120 },
    }),
  };
  try {
    const lib = require(outfile);
    const music = path.join(dir, "music");
    fs.mkdirSync(music, { recursive: true });
    fs.writeFileSync(path.join(music, "hostile.mp3"), "x");
    await lib.addLibraryFolders([music]);
    const scanned = await lib.scanLibrary(false);
    assert.equal(scanned.tracks.length, 1);
    const t = scanned.tracks[0];
    assert.equal(t.title.length, 200, "title must be length-bounded");
    assert.equal(t.artist.length, 200, "artist must be length-bounded");
    assert.equal(t.album.length, 200, "album must be length-bounded");
    assert.equal(t.genre.length, 200, "genre must be length-bounded");
    assert.equal(t.art, undefined, "oversize artwork must be refused");
    const artDir = path.join(dir, "userdata", "local-art");
    assert.ok(!fs.existsSync(artDir) || fs.readdirSync(artDir).length === 0, "no art file may be written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outfile, { force: true });
  }
});
