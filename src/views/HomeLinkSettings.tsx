/**
 * Settings → Connections → Phones at home: this computer as the sync service for the phones paired with
 * it, in homes without one (electron/home-link.ts). A phone pairs once with the code shown here; then
 * playlists, the library's order, what plays where and the shared listening history work as with a sync
 * service, while Songsta is open on this computer.
 */
import { useEffect, useState } from "react";
import { KeyRound, MonitorSmartphone, ShieldCheck, Smartphone, X } from "lucide-react";
import type { HomeLinkStatus } from "../../electron/home-link";
import { Divider, SettingsGroup, SettingsRow, Switch } from "../components/SettingsChrome";
import { useHomeSync } from "../lib/homeSync";
import { T } from "../lib/i18n";
import { useUI } from "../stores/ui";

/** "482913" → "482 913": easier to type in from across the room. */
const spaced = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

export function HomeLinkGroup() {
  // A sync service of your own links the devices already: this is for homes without one.
  const external = useHomeSync((st) => st.linked && !st.home && st.status === "connected");
  const toast = useUI((st) => st.toast);
  const [status, setStatus] = useState<HomeLinkStatus | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const bridge = window.bytune;
    if (!bridge?.homeLinkStatus) return;
    let alive = true;
    const read = (): void => {
      void bridge
        .homeLinkStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    };
    read();
    const off = bridge.onHomeLinkChanged?.(read);
    void Promise.all([bridge.firewallMatters(), bridge.firewallHasRule()])
      .then(([matters, has]) => alive && setBlocked(matters && !has))
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // The code's time, counted down; once it's over, the code goes.
  const pairing = status?.pairing && status.pairing.until > now ? status.pairing : null;
  useEffect(() => {
    if (!status?.pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status?.pairing]);

  if (!status) return null;
  const bridge = window.bytune;
  const apply = (p: Promise<HomeLinkStatus> | undefined): void => {
    void p?.then(setStatus).catch(() => toast(T("That didn't work"), "error"));
  };

  if (external && !status.enabled) {
    return (
      <SettingsGroup header={T("Phones at home")}>
        <SettingsRow icon={MonitorSmartphone} title={T("Link phones without a sync service")} subtitle={T("Your sync service already links your devices. This is for homes without one.")} disabled />
      </SettingsGroup>
    );
  }

  const line = !status.enabled
    ? T("For homes without a sync service: this computer keeps your phones' playlists, library and what plays in step")
    : status.problem === "in-use"
      ? T("Port {port} is taken by another program", { port: "8197" })
      : status.problem
        ? T("Couldn't start")
        : T("Phones paired with this computer stay in step with it while Songsta is open here");
  const minutes = pairing ? Math.max(1, Math.ceil((pairing.until - now) / 60_000)) : 0;

  return (
    <SettingsGroup
      header={T("Phones at home")}
      footer={T("Phones look for this computer on your home network. Only a phone that typed in the code shown here gets in, and only from your home network. What it keeps is on this computer, and a song only this computer has plays on the phone from here.")}
    >
      <SettingsRow
        icon={MonitorSmartphone}
        title={T("Link phones without a sync service")}
        subtitle={line}
        trailing={<Switch checked={status.enabled} onChange={(on) => apply(bridge?.homeLinkSetEnabled(on))} />}
        onClick={() => apply(bridge?.homeLinkSetEnabled(!status.enabled))}
      />
      {status.enabled && blocked && (
        <>
          <Divider />
          <SettingsRow
            icon={ShieldCheck}
            title={T("Let phones in")}
            subtitle={T("Windows keeps phones out of this computer until Songsta may take connections from your home network. Windows asks for your OK.")}
            onClick={() => {
              void bridge
                ?.firewallAllow()
                .then((done) => setBlocked(!done))
                .catch(() => undefined);
            }}
          />
        </>
      )}
      {status.enabled && (
        <>
          <Divider />
          {pairing ? (
            <SettingsRow
              icon={KeyRound}
              title={T("Type this code in on the phone")}
              subtitle={T("On the phone: Settings → Sync and devices → Link to a computer, then {name}. Valid for {minutes} min.", { name: status.name, minutes: String(minutes) })}
              trailing={
                <span className="flex items-center gap-3">
                  <span className="text-[24px] font-black tracking-[0.12em] tabular-nums text-ink-hi">{spaced(pairing.code)}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      apply(bridge?.homeLinkClosePairing());
                    }}
                    aria-label={T("Cancel")}
                    title={T("Cancel")}
                    className="w-8 h-8 rounded-full grid place-items-center text-ink-dim hover:text-ink-hi hover:bg-ink-hi/10"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </span>
              }
            />
          ) : (
            <SettingsRow
              icon={KeyRound}
              title={T("Pair a phone")}
              subtitle={status.running ? T("Shows a code to type in on the phone") : T("Starts as soon as this computer can take connections")}
              disabled={!status.running}
              onClick={() => apply(bridge?.homeLinkOpenPairing())}
            />
          )}
          {status.devices.map((d) => (
            <div key={d.id}>
              <Divider />
              <SettingsRow
                icon={d.kind === "computer" ? MonitorSmartphone : Smartphone}
                title={d.name}
                subtitle={T("Paired on {date}", { date: new Date(d.pairedAt).toLocaleDateString() })}
                value={T("Remove")}
                onClick={() => {
                  apply(bridge?.homeLinkRemove(d.id));
                  toast(T("{name} is no longer paired", { name: d.name }));
                }}
              />
            </div>
          ))}
        </>
      )}
    </SettingsGroup>
  );
}
