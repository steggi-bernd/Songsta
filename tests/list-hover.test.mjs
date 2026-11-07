// Rows of a list swap their number for a play button on hover. If that changes the spot's size, the browser's
// scroll anchoring "corrects" the scroll position for it, the pointer lands on the next row, and the list shakes
// by itself with the mouse standing still.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const sources = fs
  .readdirSync(src, { recursive: true })
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(src, f), "utf8") }));

test("a row that swaps its number and play button on hover keeps that spot's size", () => {
  const swapping = sources.filter((s) => s.text.includes("hidden group-hover:block"));
  assert.ok(swapping.length >= 2, "the list rows are found");
  for (const { file, text } of swapping) {
    const swaps = text.split("hidden group-hover:block").length - 1;
    const spots = text.split("row-number").length - 1;
    assert.equal(spots, swaps, `${file}: every number and play button sit in a .row-number`);
  }
});

test("that spot has a size of its own and is never the scroll anchor", () => {
  const css = fs.readFileSync(path.join(src, "index.css"), "utf8");
  const rule = /\.row-number\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /height:\s*[\d.]+rem/);
  assert.match(rule, /overflow-anchor:\s*none/);
});
