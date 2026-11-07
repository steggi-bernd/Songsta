// The hint on a new version: which number counts as newer, and how seldom GitHub is asked and the listener told.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/newVersion.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { apkOfRelease, isNewerVersion, lookForNewVersion, NO_VERSION_MEMORY, shouldFetchUpdate, versionOfRelease } = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

const DAY = 24 * 60 * 60 * 1000;

test("numbers are compared as numbers", () => {
  assert.equal(isNewerVersion("1.10.0", "1.9.0"), true);
  assert.equal(isNewerVersion("1.4.0", "1.3.0"), true);
  assert.equal(isNewerVersion("2.0", "1.9.9"), true);
  assert.equal(isNewerVersion("1.3.1", "1.3.0"), true);
  assert.equal(isNewerVersion("1.3.0", "1.3.0"), false);
  assert.equal(isNewerVersion("1.3", "1.3.0"), false);
  assert.equal(isNewerVersion("1.2.9", "1.3.0"), false, "a test build ahead of the release hears nothing");
});

test("what isn't a version never counts as newer", () => {
  assert.equal(isNewerVersion("", "1.3.0"), false);
  assert.equal(isNewerVersion("latest", "1.3.0"), false);
  assert.equal(isNewerVersion("1.4.0", ""), false);
});

test("GitHub's answer gives its tag as a version, or none", () => {
  assert.equal(versionOfRelease({ tag_name: "v1.4.0" }), "1.4.0");
  assert.equal(versionOfRelease({ tag_name: "1.4.0" }), "1.4.0");
  assert.equal(versionOfRelease({ tag_name: "v1.4.0-beta" }), null);
  assert.equal(versionOfRelease({ message: "Not Found" }), null);
  assert.equal(versionOfRelease(null), null);
});

function asker(answer) {
  const ask = async () => {
    ask.times += 1;
    return answer;
  };
  ask.times = 0;
  return ask;
}

test("a newer version is told once; the same one stays quiet after that", async () => {
  const ask = asker("1.4.0");
  const first = await lookForNewVersion("1.3.0", NO_VERSION_MEMORY, 10 * DAY, ask);
  assert.equal(first.tell, "1.4.0");
  assert.equal(first.memory.latest, "1.4.0");
  const second = await lookForNewVersion("1.3.0", first.memory, 12 * DAY, ask);
  assert.equal(second.tell, null);
  assert.equal(second.memory.latest, "1.4.0", "the dot and Settings still know of it");
});

test("the next version is told again", async () => {
  const told = { checkedAt: 10 * DAY, latest: "1.4.0", told: "1.4.0" };
  const later = await lookForNewVersion("1.3.0", told, 12 * DAY, asker("1.5.0"));
  assert.equal(later.tell, "1.5.0");
});

test("GitHub hears at most once a day", async () => {
  const ask = asker("1.3.0");
  const first = await lookForNewVersion("1.3.0", NO_VERSION_MEMORY, 10 * DAY, ask);
  assert.equal(ask.times, 1);
  await lookForNewVersion("1.3.0", first.memory, 10 * DAY + DAY - 1, ask);
  assert.equal(ask.times, 1);
  await lookForNewVersion("1.3.0", first.memory, 10 * DAY + DAY, ask);
  assert.equal(ask.times, 2);
});

test("no answer doesn't count as one: the next look asks again, and what was known stays", async () => {
  const known = { checkedAt: 10 * DAY, latest: "1.4.0", told: "1.4.0" };
  const ask = asker(null);
  const { memory, tell } = await lookForNewVersion("1.3.0", known, 12 * DAY, ask);
  assert.equal(tell, null);
  assert.deepEqual(memory, known);
  await lookForNewVersion("1.3.0", memory, 12 * DAY + 1, ask);
  assert.equal(ask.times, 2);
});

test("a clock set back doesn't keep the next question away", async () => {
  const ask = asker("1.3.0");
  await lookForNewVersion("1.3.0", { checkedAt: 100 * DAY, latest: "1.3.0", told: "" }, 10 * DAY, ask);
  assert.equal(ask.times, 1);
});

test("a note missed by a closed app still comes, without asking again", async () => {
  const ask = asker("1.4.0");
  const { tell } = await lookForNewVersion("1.3.0", { checkedAt: 10 * DAY, latest: "1.4.0", told: "" }, 10 * DAY + 1, ask);
  assert.equal(tell, "1.4.0");
  assert.equal(ask.times, 0);
});

test("after the update there's nothing to say", async () => {
  const { tell } = await lookForNewVersion("1.4.0", { checkedAt: 10 * DAY, latest: "1.4.0", told: "" }, 10 * DAY + 1, asker("1.4.0"));
  assert.equal(tell, null);
});

test("fetching by itself: only what's newer, only once, and only where it can install", () => {
  const can = { phase: "none", version: "", percent: 0, canInstall: true };
  assert.equal(shouldFetchUpdate("1.5.0", "1.4.0", can, true), true);
  assert.equal(shouldFetchUpdate("1.5.0", "1.4.0", can, false), false, "switched off");
  assert.equal(shouldFetchUpdate("1.4.0", "1.4.0", can, true), false, "nothing newer");
  assert.equal(shouldFetchUpdate("1.5.0", "1.4.0", { ...can, canInstall: false }, true), false, "this install can't");
  assert.equal(shouldFetchUpdate("1.5.0", "1.4.0", { ...can, phase: "downloading" }, true), false, "already on its way");
  assert.equal(shouldFetchUpdate("1.5.0", "1.4.0", { ...can, phase: "failed" }, true), true, "failed: another try");
  assert.equal(shouldFetchUpdate("1.5.0", "1.4.0", { ...can, phase: "ready", version: "1.5.0" }, true), false, "it's waiting already");
  assert.equal(shouldFetchUpdate("1.5.0", "1.4.0", { ...can, phase: "ready", version: "1.6.0" }, true), false, "what's waiting is newer still");
  assert.equal(shouldFetchUpdate("1.6.0", "1.4.0", { ...can, phase: "ready", version: "1.5.0" }, true), true, "an even newer one came out");
});

test("the phone's APK in a release: only a proper one", () => {
  const url = "https://github.com/steggi-bernd/Songsta/releases/download/v1.5.0/Songsta.apk";
  const hash = "ab".repeat(32);
  const release = (assets) => ({ tag_name: "v1.5.0", assets });
  assert.deepEqual(apkOfRelease(release([{ name: "Songsta-Setup.exe", browser_download_url: "https://x/y" }, { name: "Songsta.apk", browser_download_url: url, size: 123, digest: `sha256:${hash}` }])), {
    version: "1.5.0",
    url,
    size: 123,
    sha256: hash,
  });
  assert.deepEqual(apkOfRelease(release([{ name: "Songsta.apk", browser_download_url: url }])), { version: "1.5.0", url, size: 0, sha256: "" }, "without size and digest it's still that file");
  assert.equal(apkOfRelease(release([{ name: "Songsta-Setup.exe", browser_download_url: url }])), null, "no APK in it (yet)");
  assert.equal(apkOfRelease(release([{ name: "Songsta.apk", browser_download_url: "http://example.com/a.apk" }])), null, "not over plain http");
  assert.equal(apkOfRelease(release([{ name: "Songsta.apk" }])), null);
  assert.equal(apkOfRelease({ assets: [{ name: "Songsta.apk", browser_download_url: url }] }), null, "no version, no use");
  assert.equal(apkOfRelease(release("x")), null);
  assert.equal(apkOfRelease(null), null);
  assert.equal(apkOfRelease(release([null, { name: "Songsta.apk", browser_download_url: url, digest: "md5:abc" }]))?.sha256, "", "another kind of digest doesn't count");
});
