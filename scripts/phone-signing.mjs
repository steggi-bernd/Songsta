#!/usr/bin/env node
/**
 * The phone app's signature, for releases. Up to 1.6 every Songsta.apk was signed with the public
 * debug key of the React Native template, which anybody can sign with. From then on the APK also
 * carries Songsta's own key, together with a proof that the old key handed over to it (APK key
 * rotation): Android 9 and newer take it as an ordinary update, the old key's data stays, and from
 * then on they take updates only with the new key. Android 7 and 8 know no rotation and go on
 * checking the old key, as before.
 *
 *   node scripts/phone-signing.mjs setup [--old <debug.keystore>]   once: the new key and the hand-over
 *   node scripts/phone-signing.mjs sign <app-release.apk> [<out.apk>] each release: Gradle's APK signed with both
 *   node scripts/phone-signing.mjs check <apk>                        what an APK is signed with; no password needed
 *
 * The key lives in a folder outside the repo: %USERPROFILE%\.songsta-signing, or SONGSTA_SIGNING_DIR.
 * Keep a copy of that folder and of its password somewhere safe: without them no update can go over
 * the app again, and Android would only take a new install after the old app is gone.
 * The password is asked for without showing it; SONGSTA_SIGNING_PASSWORD gives it instead.
 * Needs the Android SDK's build-tools 33 or newer and a Java (Android Studio brings one).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The public debug key every release up to 1.6 was signed with: the one the new key takes over from. */
const OLD_KEY_SHA256 = "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c";
const OLD_ALIAS = "androiddebugkey";
const OLD_PASSWORD = "android";
const NEW_ALIAS = "songsta";
/** Android 9: the first that knows rotation. Older ones keep checking the old key. */
const ROTATION_FROM_SDK = 28;
const MIN_SDK = 24;
const FILES = { old: "old-debug.keystore", key: "songsta.jks", lineage: "rotation.lineage" };
/** How the password reaches keytool and apksigner: never on a command line. */
const PASS_ENV = "SONGSTA_KEY_PASS";

const win = platform() === "win32";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

const signingDir = () => resolve(process.env.SONGSTA_SIGNING_DIR || join(homedir(), ".songsta-signing"));

function sdkDir() {
  const named = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (named) return named;
  if (win) return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Android", "Sdk");
  return platform() === "darwin" ? join(homedir(), "Library", "Android", "sdk") : join(homedir(), "Android", "Sdk");
}

const versionParts = (v) => v.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
function newerFirst(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/** The newest apksigner, run as a jar: no .bat in between. */
function apksignerJar() {
  const tools = join(sdkDir(), "build-tools");
  const found = existsSync(tools) ? readdirSync(tools).filter((v) => existsSync(join(tools, v, "lib", "apksigner.jar"))).sort(newerFirst) : [];
  if (!found.length) fail(`No apksigner under ${tools}. Install the Android SDK's build-tools, or set ANDROID_HOME.`);
  if (versionParts(found[0])[0] < 33) fail(`apksigner ${found[0]} is too old for this: build-tools 33 or newer are needed.`);
  return join(tools, found[0], "lib", "apksigner.jar");
}

/** java or keytool: JAVA_HOME's, Android Studio's, or whatever the PATH has. */
function javaTool(name) {
  const exe = win ? `${name}.exe` : name;
  const homes = [
    process.env.JAVA_HOME,
    win ? "C:\\Program Files\\Android\\Android Studio\\jbr" : null,
    platform() === "darwin" ? "/Applications/Android Studio.app/Contents/jbr/Contents/Home" : null,
    platform() === "linux" ? join(homedir(), "android-studio", "jbr") : null,
  ].filter(Boolean);
  for (const home of homes) if (existsSync(join(home, "bin", exe))) return join(home, "bin", exe);
  return name;
}

function run(tool, args, password) {
  const env = { ...process.env, ...(password !== undefined ? { [PASS_ENV]: password } : {}) };
  const out = spawnSync(tool, args, { encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 });
  if (out.error) fail(`${basename(tool)} didn't start: ${out.error.message}`);
  return { ok: out.status === 0, text: `${out.stdout ?? ""}${out.stderr ?? ""}` };
}

const apksigner = (args, password) => run(javaTool("java"), ["-jar", apksignerJar(), ...args], password);

const sha256Of = (text) => /SHA-?256[^:]*:\s*([0-9a-f:]{64,95})/i.exec(text)?.[1]?.replace(/:/g, "").toLowerCase() ?? null;

/** The SHA-256 of a keystore's certificate. */
function keystoreSha256(keystore, alias, password) {
  const passArgs = password === OLD_PASSWORD ? ["-storepass", OLD_PASSWORD] : [`-storepass:env`, PASS_ENV];
  const out = run(javaTool("keytool"), ["-list", "-v", "-keystore", keystore, "-alias", alias, ...passArgs], password === OLD_PASSWORD ? undefined : password);
  if (!out.ok) return null;
  return sha256Of(out.text);
}

/** Asks without showing what's typed. */
function askHidden(question) {
  if (!process.stdin.isTTY) fail("No terminal to ask in: run this in your own terminal, or set SONGSTA_SIGNING_PASSWORD.");
  process.stdout.write(question);
  return new Promise((done) => {
    const stdin = process.stdin;
    let value = "";
    const stop = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stop();
          done(value);
          return;
        }
        if (ch === "\u0003") {
          stop();
          fail("Stopped.");
        }
        if (ch === "\b" || ch === "\u007f") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function password(confirm) {
  const given = process.env.SONGSTA_SIGNING_PASSWORD;
  if (given) return given;
  const first = await askHidden("Password of Songsta's signing key: ");
  if (confirm) {
    if (first.length < 8) fail("At least 8 characters, please.");
    if ((await askHidden("Once more: ")) !== first) fail("The two didn't match. Nothing was made.");
  }
  return first;
}

function folderFiles() {
  const dir = signingDir();
  const files = Object.fromEntries(Object.entries(FILES).map(([k, name]) => [k, join(dir, name)]));
  return { dir, files };
}

async function setup(args) {
  const { dir, files } = folderFiles();
  if (existsSync(files.key) || existsSync(files.lineage)) {
    fail(`${dir} has a key already. Setup runs once: a second key would split the phones in two. Move the folder away first if you really mean to start over.`);
  }
  const at = args.indexOf("--old");
  const candidates = at >= 0 ? [resolve(args[at + 1] ?? "")] : [join(repo, "mobile", "android", "app", "debug.keystore")];
  const old = candidates.find((p) => existsSync(p));
  if (!old) fail(`The old debug key isn't at ${candidates.join(" or ")}. Run "npx expo prebuild --platform android" in mobile/ first, or pass --old <path to debug.keystore>.`);
  if (keystoreSha256(old, OLD_ALIAS, OLD_PASSWORD) !== OLD_KEY_SHA256) fail(`${old} isn't the key the released apps are signed with (SHA-256 ${OLD_KEY_SHA256}).`);

  console.log(`The new key goes to ${dir}.`);
  const secret = await password(true);
  mkdirSync(dir, { recursive: true });
  copyFileSync(old, files.old);
  const made = run(
    javaTool("keytool"),
    ["-genkeypair", "-keystore", files.key, "-storetype", "PKCS12", "-alias", NEW_ALIAS, "-keyalg", "RSA", "-keysize", "4096", "-validity", "36500", "-dname", "CN=Songsta", "-storepass:env", PASS_ENV, "-keypass:env", PASS_ENV],
    secret
  );
  if (!made.ok || !existsSync(files.key)) fail(`keytool couldn't make the key:\n${made.text}`);
  // The old key hands over to the new one; it keeps no right to sign updates of its own after that.
  const handed = apksigner(
    ["rotate", "--out", files.lineage, "--old-signer", "--ks", files.old, "--ks-key-alias", OLD_ALIAS, "--ks-pass", `pass:${OLD_PASSWORD}`, "--key-pass", `pass:${OLD_PASSWORD}`, "--new-signer", "--ks", files.key, "--ks-key-alias", NEW_ALIAS, "--ks-pass", `env:${PASS_ENV}`, "--key-pass", `env:${PASS_ENV}`],
    secret
  );
  if (!handed.ok || !existsSync(files.lineage)) fail(`apksigner couldn't make the hand-over:\n${handed.text}`);
  const newKey = keystoreSha256(files.key, NEW_ALIAS, secret);
  console.log(`\nDone. Songsta's key: SHA-256 ${newKey}`);
  console.log(`Back up the folder ${dir} (all three files) and the password, apart from this computer, now.`);
  console.log("Without them no update can go over the app again. Never put them in the repo.");
}

/** What an APK is signed with, for the two kinds of phones. */
function inspect(apk) {
  const old = apksigner(["verify", "--print-certs", "--min-sdk-version", String(MIN_SDK), "--max-sdk-version", String(ROTATION_FROM_SDK - 1), apk]);
  const fresh = apksigner(["verify", "--print-certs", "-v", "--min-sdk-version", String(ROTATION_FROM_SDK), apk]);
  const lineage = apksigner(["lineage", "--in", apk, "--print-certs"]);
  const chain = lineage.ok ? [...lineage.text.matchAll(/certificate SHA-256 digest:\s*([0-9a-f]{64})/gi)].map((m) => m[1].toLowerCase()) : [];
  return {
    olderPhones: old.ok ? sha256Of(old.text) : null,
    newerPhones: fresh.ok ? sha256Of(fresh.text) : null,
    v3: /Verified using v3(\.1)? scheme[^:]*:\s*true/i.test(fresh.text),
    chain,
    problem: !old.ok ? old.text.trim() : !fresh.ok ? fresh.text.trim() : null,
  };
}

/** Whether the APK can go out: the old key for Android 7–8, a new key handed over from it for Android 9+. */
function check(apk, quiet = false) {
  if (!existsSync(apk)) fail(`No file ${apk}.`);
  const seen = inspect(apk);
  const problems = [];
  if (seen.problem) problems.push(`apksigner says: ${seen.problem}`);
  if (seen.olderPhones !== OLD_KEY_SHA256) problems.push(`Android 7–8 would check ${seen.olderPhones ?? "nothing"}, not the old key: their installed Songsta would refuse it.`);
  if (!seen.v3 || seen.newerPhones === OLD_KEY_SHA256) problems.push("Android 9+ would see the old key only: phones that have the new key already would refuse it. Sign it with: node scripts/phone-signing.mjs sign");
  else if (seen.chain[0] !== OLD_KEY_SHA256 || seen.chain.at(-1) !== seen.newerPhones) problems.push("The new key isn't handed over from the old one in this APK: Android 9+ would refuse it as an update.");
  const { files } = folderFiles();
  if (!problems.length && existsSync(files.lineage)) {
    const known = apksigner(["lineage", "--in", files.lineage, "--print-certs"]);
    const ours = [...known.text.matchAll(/certificate SHA-256 digest:\s*([0-9a-f]{64})/gi)].map((m) => m[1].toLowerCase()).at(-1);
    if (ours && ours !== seen.newerPhones) problems.push(`Signed with another new key (${seen.newerPhones}) than the one in ${files.lineage} (${ours}).`);
  }
  if (problems.length) fail(`${basename(apk)} can't go out:\n- ${problems.join("\n- ")}`);
  if (!quiet) {
    console.log(`${basename(apk)} is fine to release:`);
    console.log(`  Android 7–8 check the old key   ${seen.olderPhones}`);
    console.log(`  Android 9+ check Songsta's key  ${seen.newerPhones}, handed over from the old one`);
  }
  return seen;
}

async function sign(args) {
  const [input, output] = args;
  if (!input) fail("Which APK? node scripts/phone-signing.mjs sign <app-release.apk> [<out.apk>]");
  const from = resolve(input);
  const to = resolve(output ?? join(dirname(from), "Songsta.apk"));
  if (!existsSync(from)) fail(`No file ${from}.`);
  if (from === to) fail("Write it to another file than the one it's read from.");
  const { dir, files } = folderFiles();
  for (const file of Object.values(files)) if (!existsSync(file)) fail(`${file} is missing. The key is set up once with: node scripts/phone-signing.mjs setup (or set SONGSTA_SIGNING_DIR to where it is).`);
  const secret = await password(false);
  const signed = apksigner(
    [
      "sign",
      "--ks", files.old, "--ks-key-alias", OLD_ALIAS, "--ks-pass", `pass:${OLD_PASSWORD}`, "--key-pass", `pass:${OLD_PASSWORD}`,
      "--next-signer", "--ks", files.key, "--ks-key-alias", NEW_ALIAS, "--ks-pass", `env:${PASS_ENV}`, "--key-pass", `env:${PASS_ENV}`,
      "--lineage", files.lineage,
      "--rotation-min-sdk-version", String(ROTATION_FROM_SDK),
      "--v4-signing-enabled", "false",
      "--out", to,
      from,
    ],
    secret
  );
  if (!signed.ok) fail(`apksigner couldn't sign it${/password|keystore was tampered|Failed to load signer/i.test(signed.text) ? " (wrong password?)" : ""}:\n${signed.text.trim()}`);
  check(to);
  console.log(`Written to ${to} (key folder ${dir}).`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "setup") await setup(rest);
else if (command === "sign") await sign(rest);
else if (command === "check") {
  if (!rest[0]) fail("Which APK? node scripts/phone-signing.mjs check <apk>");
  check(resolve(rest[0]));
} else {
  console.log("node scripts/phone-signing.mjs setup [--old <debug.keystore>] | sign <app-release.apk> [<out.apk>] | check <apk>");
  process.exit(command ? 1 : 0);
}
// The terminal that was asked in would otherwise keep it waiting.
process.exit(0);
