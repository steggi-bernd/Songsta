// Every store the page keeps on disk (zustand's persist, a `name:` beside its `storage:`) must be one
// the main process lets it write (electron/main.ts RENDERER_STORES): one left off is never saved and
// starts empty at every start, as the skips, the albums' moments and the shared history's place did
// before this test. And "Reset app data" must erase each of them (electron/persist.ts resetAppData).
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function sources(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The names of the page's persisted stores: `name: "x"` with `storage` close by. */
function pageStores() {
  const names = new Map();
  for (const file of sources(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("persist")) continue;
    for (const m of text.matchAll(/name:\s*"([a-z][a-z0-9-]*)"/g)) {
      const around = text.slice(Math.max(0, m.index - 1500), m.index + 1500);
      if (/storage:/.test(around) && /persist\(/.test(text)) names.set(m[1], path.relative(root, file));
    }
  }
  return names;
}

const setIn = (text, start) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `found ${start}`);
  const body = text.slice(from, text.indexOf("]", from));
  return new Set([...body.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]));
};

test("every store the page keeps may be written by it, and Reset app data erases it", () => {
  const stores = pageStores();
  assert.ok(stores.size >= 14, `the page's stores are found (${[...stores.keys()].join(", ")})`);
  const allowed = setIn(read("electron/main.ts"), "const RENDERER_STORES = new Set([");
  const erased = setIn(read("electron/persist.ts"), "const names = new Set([");
  const notAllowed = [...stores].filter(([name]) => !allowed.has(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(notAllowed, [], "a store the main process refuses to write: add it to RENDERER_STORES");
  const notErased = [...stores].filter(([name]) => !erased.has(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(notErased, [], "a store Reset app data leaves behind: add it to resetAppData's names");
  const stale = [...allowed].filter((name) => !stores.has(name));
  assert.deepEqual(stale, [], "a name allowed that no store of the page uses any more");
});
