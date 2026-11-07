import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

async function bundle(entry, externs) {
  // Bundles must live under the project so externalized deps resolve from
  // node_modules at require time (and stay out of the packaged asar).
  fs.mkdirSync(".test-build", { recursive: true });
  const outfile = path.resolve(".test-build", `perf-${path.basename(entry)}.cjs`.replace(/\.ts$/, ".cjs"));
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: externs,
    plugins: [{
      name: "stub-relative",
      setup(b) {
        b.onResolve({ filter: /^\.\.?\/|^\.\/stores\/|\.\/bridge$/ }, (a) => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
          contents: a.path.endsWith("persist")
            ? "module.exports = globalThis.__persistStub;"
            : "module.exports = globalThis.__stub;",
          loader: "js",
        }));
      },
    }],
  });
  fs.writeFileSync(outfile, outputFiles[0].text);
  return outfile;
}

test("createProgressBuffer: a 4Hz progress storm applies at most once per tick, latest payload wins", async () => {
  globalThis.__stub = {};
  const outfile = await bundle("../src/lib/downloads.ts", ["zustand"]);
  const { createProgressBuffer } = require(outfile);


  const applied = [];
  const buf = createProgressBuffer((id, downloaded, total) => applied.push({ id, downloaded, total }), 500);
  // Two concurrent downloads x 10 events at 100ms intervals.
  for (let i = 0; i < 10; i++) {
    buf.push("a", i * 100, 1000);
    buf.push("b", i * 200, 2000);
    await new Promise((r) => setTimeout(r, 100));
  }
  const aEvents = applied.filter((x) => x.id === "a");
  assert.ok(aEvents.length <= 3, `expected ≤3 applies for 10 events in 1s, got ${aEvents.length}`);
  assert.equal(aEvents.at(-1).downloaded, 900, "the latest payload must be the one applied");

  // A terminal event flushes the buffer: nothing stale may apply afterwards.
  buf.flush("a");
  const count = applied.length;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(applied.length, count, "flush must cancel pending ticks");
});
