// Discord's "Listening to …" carries the name of the application the status goes out under
// (src/lib/discordPresence.ts). Before Songsta had its own, the user had to make one, and the
// app said to call it ByTune: such an ID, saved as "discordClientId", is let go, or Discord
// would go on saying ByTune. An application chosen now stays, across restarts and through a
// backup, and an old backup can't bring the old one back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { envelope, settingsFromBackup, settingsToBackup } from "../.test-build/backup-transfer.mjs";

const dataUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const stores = fileURLToPath(new URL("../src/stores/", import.meta.url));

const bundle = await build({
  entryPoints: [`${stores}settings.ts`],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "disk",
      setup(b) {
        // The store's storage, in memory: what a profile holds before the app starts.
        b.onLoad({ filter: /[\\/]lib[\\/]persist\.ts$/ }, () => ({
          contents: `export const storage = {
            getItem: async (name) => globalThis.__settingsDisk[name] ?? null,
            setItem: async (name, value) => { globalThis.__settingsDisk[name] = value; },
            removeItem: async (name) => { delete globalThis.__settingsDisk[name]; },
          };`,
          loader: "js",
        }));
      },
    },
  ],
});

let starts = 0;
/** A fresh start of the settings store over a profile that holds `saved`. */
async function start(saved) {
  globalThis.__settingsDisk = { settings: JSON.stringify(saved) };
  starts += 1;
  const { useSettings } = await import(dataUrl(`${bundle.outputFiles[0].text}\n// start ${starts}`));
  if (!useSettings.persist.hasHydrated()) await new Promise((done) => useSettings.persist.onFinishHydration(done));
  return useSettings;
}

const onDisk = () => JSON.parse(globalThis.__settingsDisk.settings).state;
const settle = () => new Promise((done) => setTimeout(done, 20));

test("an Application ID from before Songsta had its own is let go, the rest stays", async () => {
  const settings = await start({ state: { discordPresence: true, discordClientId: "1234567890123456789", accent: "teal" }, version: 0 });
  const s = settings.getState();
  assert.equal(s.discordOwnAppId, "", "Songsta's own application");
  assert.equal("discordClientId" in s, false);
  assert.equal(s.discordPresence, true);
  assert.equal(s.accent, "teal");
  s.setAccent("blue");
  await settle();
  assert.equal("discordClientId" in onDisk(), false, "and it's gone from the profile");
  assert.equal(onDisk().discordPresence, true);
});

test("an application chosen now stays across a restart", async () => {
  const first = await start({ state: { discordPresence: true }, version: 0 });
  first.getState().setDiscordOwnAppId(" ID: 9876 5432 1098 7654 321\n");
  await settle();
  assert.equal(first.getState().discordOwnAppId, "9876543210987654321", "only the digits of a paste");
  const again = await start({ state: onDisk(), version: 0 });
  assert.equal(again.getState().discordOwnAppId, "9876543210987654321");
});

test("a backup carries the chosen application, and an old backup can't bring the old one back", () => {
  assert.deepEqual(settingsToBackup(envelope({ discordOwnAppId: "42", discordClientId: "7", accent: "teal" })), { discordOwnAppId: "42", accent: "teal" });
  assert.deepEqual(settingsFromBackup({ discordClientId: "7", discordPresence: true }, envelope({})), { discordPresence: true });
});
