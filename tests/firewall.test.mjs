// The rule that lets devices at home fetch local files from this computer (electron/firewall.ts):
// this program, this network, and nothing a path could smuggle in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../electron/firewall.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { elevatedScript, ruleArguments } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const EXE = "C:\\Users\\Sam\\AppData\\Local\\Programs\\Songsta\\Songsta.exe";

test("the rule: incoming, for this program only, from the same network only", () => {
  const rule = ruleArguments(EXE);
  assert.match(rule, /^advfirewall firewall add rule name="Songsta \(devices at home\)" /);
  assert.ok(rule.includes(` program="${EXE}" `));
  for (const part of ["dir=in", "action=allow", "enable=yes", "protocol=TCP", "remoteip=localsubnet"]) assert.ok(rule.split(" ").includes(part), part);
  // A network Windows calls public is where the problem shows up, and localsubnet keeps it to the same network there too.
  assert.ok(rule.split(" ").includes("profile=private,public"));
  assert.ok(!/profile=[^ ]*domain/.test(rule));
});

test("the script asks Windows for the OK and says how it went", () => {
  const script = elevatedScript(EXE);
  assert.match(script, /Start-Process netsh -Verb RunAs/);
  assert.match(script, /-Wait -PassThru/);
  assert.match(script, /exit \$p\.ExitCode/);
  assert.match(script, /catch \{ exit 1 \}/);
});

test("a quote in a path stays inside its string", () => {
  const script = elevatedScript("C:\\Users\\O'Brien\\Songsta.exe");
  assert.ok(script.includes("O''Brien"));
  assert.ok(!/[^']'[^',]*O'B/.test(script.replace(/''/g, "")));
  const list = /-ArgumentList '(.*)'; exit/.exec(script)?.[1] ?? "";
  assert.ok(!list.replace(/''/g, "").includes("'"), "no quote left that could end it");
});
