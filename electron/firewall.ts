/**
 * A device on the network fetches local files from this computer (cast.ts), and on
 * Windows it only gets in with a rule for this app. Windows doesn't always ask by
 * itself, so a device just waits for ever with the song's name on its display.
 * Songsta says what's going on and, on the listener's word, adds the rule: for
 * devices on the same network only. Windows asks for the OK itself.
 */
import { execFile } from "child_process";

const RULE = "Songsta (devices at home)";

function run(file: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 120_000 }, (err) => {
      if (!err) resolve(0);
      else resolve(typeof err.code === "number" ? err.code : 1);
    });
  });
}

export const firewallMatters = (): boolean => process.platform === "win32";

export async function hasFirewallRule(): Promise<boolean> {
  return (await run("netsh", ["advfirewall", "firewall", "show", "rule", `name=${RULE}`])) === 0;
}

/** What goes to netsh: this program, this network, nothing else. */
export function ruleArguments(exe: string): string {
  return `advfirewall firewall add rule name="${RULE}" dir=in action=allow program="${exe}" enable=yes profile=private,public protocol=TCP remoteip=localsubnet`;
}

/** PowerShell, because only that can ask Windows for the OK. The script goes as base64, so no quote in a path can change what it says. */
export function elevatedScript(exe: string): string {
  const quoted = ruleArguments(exe).replace(/'/g, "''");
  return `try { $p = Start-Process netsh -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '${quoted}'; exit $p.ExitCode } catch { exit 1 }`;
}

/** Answers whether the rule is there now: saying no at Windows' question leaves things as they were. */
export async function addFirewallRule(exe = process.execPath): Promise<boolean> {
  if (!firewallMatters()) return true;
  const encoded = Buffer.from(elevatedScript(exe), "utf16le").toString("base64");
  await run("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
  return hasFirewallRule();
}
