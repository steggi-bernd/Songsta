#!/usr/bin/env node
/** Lightweight QA of the Songsta localization drafts; no dependencies required. */
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const languages = ["fr", "es", "ru", "zh", "ja"];
const keyPattern = /^\s{2}("(?:\\.|[^"\\])*"):\s*("(?:\\.|[^"\\])*"),?\s*$/gm;
const parse = (file) => {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const dict = new Map();
  for (const match of text.matchAll(keyPattern)) {
    const key = JSON.parse(match[1]);
    if (dict.has(key)) throw new Error(file + ": duplicate key: " + key);
    dict.set(key, JSON.parse(match[2]));
  }
  return dict;
};
const placeholders = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(x => x[1]).sort().join("|");
const reference = parse("en.ts");
let problems = 0;
for (const lang of languages) {
  const dict = parse(lang + ".ts");
  let wrong = 0;
  for (const [key, value] of dict) {
    if (!reference.has(key)) {
      console.error(lang + ": unknown key " + JSON.stringify(key));
      wrong++;
    }
    if (placeholders(key) !== placeholders(value)) {
      console.error(lang + ": placeholders differ: " + JSON.stringify(key));
      wrong++;
    }
  }
  problems += wrong;
  console.log(lang + ": " + dict.size + "/" + reference.size + " keys (" + (100*dict.size/reference.size).toFixed(1) + "%), " + wrong + " errors");
}
if (problems) process.exitCode = 1;
