/**
 * Devices: a small smart-home room for everything that can make sound. One click
 * moves the music to a device; the plus lets another one play along; a device can
 * also play something of its own (lib/zones.ts). This computer's own outputs are
 * here too, and the other computers and phones running Songsta, with what they play.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Bluetooth, Cable, Check, Headphones, Laptop, ListChecks, Loader2, MoreHorizontal, Pause, Play, Plus, Power, RefreshCw, SkipForward, Smartphone, Speaker, Split, Timer, Tv, Volume2, X, Pencil } from "lucide-react";
import { listOutputDevices } from "../lib/audio";
import type { OutputDeviceChoice } from "../lib/audio-output";
import { castTo, joinCast, leaveCast, searchCastDevices, setCastVolume, setMemberVolume, stopCasting, useCast, type CastDevice } from "../lib/cast";
import { canSwitchOff, inputName, looksLikeTv } from "../lib/devicePower";
import { keepDeviceOn, pairTv, switchDeviceOff, useSwitchOffs } from "../lib/deviceSwitchOff";
import { PlugDialog } from "./PlugDialog";
import { playAheadText, TimingDialog } from "./TimingDialog";
import { isAround, otherDevices, useHomeSync } from "../lib/homeSync";
import { pickMusicFor, useZones, zoneJoin, zoneLeave, zoneNext, zoneStop, zoneToggle, zoneVolume, type ZoneView } from "../lib/zones";
import { useDeviceNames } from "../stores/deviceNames";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI, type MenuItem } from "../stores/ui";
import { T } from "../lib/i18n";

function kindIcon(device: CastDevice) {
  if (device.kind === "cast" || device.kind === "firetv") return Tv;
  return Speaker;
}

function Tile({
  icon: Icon,
  name,
  line,
  active,
  busy,
  dim,
  wide,
  picked,
  onClick,
  onMenu,
  actions,
  children,
}: {
  icon: typeof Speaker;
  name: string;
  line: string;
  active?: boolean;
  busy?: boolean;
  dim?: boolean;
  /** across the whole panel: there's more to it than a name */
  wide?: boolean;
  /** choosing several: on or off */
  picked?: boolean;
  onClick?: () => void;
  /** a right click: what else it can do */
  onMenu?: (e: React.MouseEvent) => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      title={line}
      onClick={onClick}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(e);
            }
          : undefined
      }
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={`flex min-h-[104px] min-w-0 cursor-pointer flex-col justify-between rounded-2xl p-3 transition-colors ${wide ? "col-span-2" : ""} ${
        active ? "bg-accent/[0.16] text-ink-hi ring-1 ring-inset ring-accent/45" : "bg-ink-hi/[0.06] text-ink-hi hover:bg-ink-hi/[0.1]"
      } ${dim ? "opacity-60" : ""} ${picked ? "ring-2 ring-accent" : ""}`}
    >
      <div className="flex items-start justify-between gap-1">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${active ? "bg-accent/25 text-accent" : "bg-ink-hi/[0.08]"}`}>
          {busy ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <Icon className="h-[18px] w-[18px]" />}
        </span>
        {picked !== undefined ? (
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 ${picked ? "border-accent bg-accent text-on-primary" : "border-ink-dim"}`}>
            {picked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </span>
        ) : (
          actions && <div className="-mr-1 -mt-1 flex shrink-0 items-center">{actions}</div>
        )}
      </div>
      <div className="mt-2 min-w-0">
        <span className="block truncate text-[14px] font-semibold">{name}</span>
        <span className={`mt-0.5 block truncate text-[12px] ${active ? "text-ink-hi/70" : "text-ink-dim"}`}>{line}</span>
      </div>
      {children}
    </div>
  );
}

function SmallButton({ title, onClick, children }: { title: string; onClick: (e: React.MouseEvent) => void; children: ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className="grid h-7 w-7 place-items-center rounded-full opacity-80 transition hover:bg-ink-hi/10 hover:opacity-100"
    >
      {children}
    </button>
  );
}

function VolumeRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className="mt-2.5 flex items-center gap-2 text-[12px]" onClick={(e) => e.stopPropagation()}>
      <Volume2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="min-w-0 flex-1 accent-current"
        aria-label={T("Volume")}
      />
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-2 px-1 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{title}</h3>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </section>
  );
}

/** A receiver the music has left, counting down to switching off. */
function SwitchingOff() {
  const pending = useSwitchOffs((s) => s.pending);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!pending.length) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [pending.length]);
  return (
    <>
      {pending.map((d) => (
        <div key={d.id} className="mx-1 mt-2 flex items-center gap-2 rounded-xl bg-ink-hi/[0.08] px-3 py-2 text-[13px] text-ink-hi">
          <Power className="h-4 w-4 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 [text-wrap:balance]">{T("{name} switches off in {seconds} s", { name: d.name, seconds: Math.max(0, Math.ceil((d.at - Date.now()) / 1000)) })}</span>
          <button className="shrink-0 font-semibold underline" onClick={() => keepDeviceOn(d.id)}>{T("Keep on")}</button>
        </div>
      ))}
    </>
  );
}

function zoneLine(zone: ZoneView): string {
  const song = zone.state.queue[zone.state.index];
  if (zone.state.error) return zone.state.error;
  if (!song) return T("Ready");
  return `${zone.state.state === "playing" ? "" : zone.state.state === "loading" ? T("Waiting for it to start · ") : T("Paused · ")}${song.title}`;
}

export function DevicesPanel({ onClose }: { onClose: () => void }) {
  const devices = useCast((s) => s.devices);
  const searching = useCast((s) => s.searching);
  const active = useCast((s) => s.active);
  const connecting = useCast((s) => s.connecting);
  const members = useCast((s) => s.members);
  const castVolume = useCast((s) => s.volume);
  const others = useHomeSync((s) => s.others);
  const followed = useHomeSync((s) => s.followed);
  const secondStream = useHomeSync((s) => s.secondStream);
  const remoteVolume = usePlayer((s) => s.remoteVolume);
  const syncStatus = useHomeSync((s) => s.status);
  const zones = useZones((s) => s.zones);
  const pickingFor = useZones((s) => s.pickingFor);
  const pickingWith = useZones((s) => s.pickingWith);
  const names = useDeviceNames((s) => s.names);
  const track = usePlayer((s) => s.queue[s.index] ?? null);
  const playing = usePlayer((s) => s.playing);
  const sinkId = useSettings((s) => s.audioSinkId);
  const [outputs, setOutputs] = useState<OutputDeviceChoice[]>([]);
  const [openOutputs, setOpenOutputs] = useState(false);
  /** choosing several at once; a click on a tile then only marks it */
  const [choosing, setChoosing] = useState<Set<string> | null>(null);
  const toggleChosen = (id: string): void => {
    if (!choosing) return;
    const next = new Set(choosing);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChoosing(next);
  };

  useEffect(() => {
    void searchCastDevices();
    const refresh = (): void => void listOutputDevices().then(setOutputs);
    refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", refresh);
    return () => md?.removeEventListener?.("devicechange", refresh);
  }, []);

  const nameOf = (d: CastDevice): string => names[d.id] ?? d.name;
  const playable = devices.filter((d) => d.kind === "upnp" || d.kind === "cast");
  const receivers = playable.filter((d) => canSwitchOff(d.model));
  const deviceLinks = useSettings((s) => s.deviceLinks);
  const pairedTvs = useSettings((s) => s.pairedTvs);
  const [plugging, setPlugging] = useState<CastDevice | null>(null);
  const [timing, setTiming] = useState<CastDevice | null>(null);
  const playAhead = useSettings((s) => s.playAhead);
  /** "On Den Receiver · Media Player", for what's plugged into one. */
  const plugLine = (id: string): string | null => {
    const link = deviceLinks.find((l) => l.device === id);
    if (!link) return null;
    const receiver = devices.find((d) => d.id === link.receiver);
    return T("On {name} · {input}", { name: receiver ? nameOf(receiver) : T("the receiver"), input: inputName(link.input) });
  };
  const pairOnly = devices.filter((d) => d.kind === "echo" || d.kind === "firetv");
  const around = others.filter(isAround);
  const here = !active && !followed;
  const inGroup = (id: string): boolean => members.some((m) => m.id === id);
  const zoneOn = (id: string): ZoneView | undefined => zones.find((z) => z.members.some((m) => m.id === id) || z.device.id === id);
  const withOthers = (zone: ZoneView, id: string): string => {
    const rest = zone.members.filter((m) => m.id !== id);
    return rest.length ? T(" · with {names}", { names: rest.map((m) => names[m.id] ?? m.name).join(" + ") }) : "";
  };

  const outputLabel = (): string => {
    if (sinkId) return outputs.find((o) => o.deviceId === sinkId)?.label ?? T("Chosen output");
    return outputs.find((o) => o.deviceId !== "" && o.activeDefault)?.label ?? T("System default");
  };

  const takeHere = (): void => {
    if (followed) otherDevices.takeHere();
    else if (active) void stopCasting();
  };

  const chosen = (): CastDevice[] => playable.filter((d) => choosing?.has(d.id));

  const playTogether = async (): Promise<void> => {
    const [first, ...rest] = chosen();
    setChoosing(null);
    if (!first) return;
    await moveTo(first);
    for (const d of rest) await joinCast(d);
  };

  /** The device being followed plays on until this one answers, and this computer stays silent on the way. */
  const moveTo = (d: CastDevice): Promise<void> => castTo(d, followed ? () => otherDevices.takeHere(false) : undefined);

  const sendToDevice = (id: string, name: string): void => {
    if (active) void stopCasting(false);
    void otherDevices.sendTo(id).then((sent) => useUI.getState().toast(sent ? T("Playing on {name}", { name }) : T("{name} can't be reached right now", { name }), sent ? "info" : "error"));
  };

  const menu = (e: React.MouseEvent, d: CastDevice): void => {
    const zone = zoneOn(d.id);
    const items: MenuItem[] = [
      { label: T("Play something else here"), icon: Play, action: () => pickMusicFor(d) },
      { label: T("Choose several devices"), icon: ListChecks, action: () => setChoosing(new Set([d.id])) },
      { label: playAhead[d.id] ? T("Timing: {value}", { value: playAheadText(playAhead[d.id]) }) : T("Fine-tune timing…"), icon: Timer, action: () => setTiming(d) },
      ...(zone ? [{ label: T("Stop the music here"), icon: X, action: () => void zoneStop(zone.id) }] : []),
      ...(canSwitchOff(d.model) || pairedTvs.includes(d.id) ? [{ label: T("Switch off"), icon: Power, action: () => void switchDeviceOff(d) }] : []),
      ...(!canSwitchOff(d.model) && receivers.length ? [{ label: plugLine(d.id) ?? T("Plugged into a receiver"), icon: Cable, action: () => setPlugging(d) }] : []),
      ...(looksLikeTv(d) && !pairedTvs.includes(d.id) ? [{ label: T("Pair to switch it off"), icon: Power, action: () => void pairTv(d) }] : []),
      ...zones
        .filter((z) => !z.members.some((m) => m.id === d.id))
        .map((z): MenuItem => ({ label: T("Play along with {value}", { value: names[z.device.id] ?? z.device.name }), icon: Plus, action: () => void zoneJoin(z.id, d) })),
      {
        label: T("Rename…"),
        icon: Pencil,
        action: () =>
          useUI.getState().openDialog({
            title: T("Rename this device"),
            initialValue: nameOf(d),
            confirmLabel: T("Save"),
            onConfirm: (value) => useDeviceNames.getState().rename(d.id, value === d.name ? "" : value),
          }),
      },
    ];
    useUI.getState().openContextMenu(e.clientX, e.clientY, items);
  };

  /** This computer's own menu: a second stream next to what plays elsewhere, and back to one. */
  const hereMenu = (e: React.MouseEvent): void => {
    const items: MenuItem[] = [];
    if (followed) items.push({ label: T("Start a second stream"), icon: Split, action: () => otherDevices.startSecondStream() });
    if (secondStream) items.push({ label: T("End the second stream"), icon: X, action: () => otherDevices.endSecondStream() });
    if (items.length) useUI.getState().openContextMenu(e.clientX, e.clientY, items);
  };

  const askBluetooth = (d: CastDevice): void => {
    const canOpenBluetooth = d.kind === "echo" && navigator.userAgent.includes("Windows");
    useUI.getState().openDialog({
      title: nameOf(d),
      body:
        d.kind === "echo" ? T("Amazon lets no app send music to an Echo directly. It works as a Bluetooth speaker: say \"Alexa, connect\", then pick it in Windows under Settings > Bluetooth. It then shows up here as an output of this computer.") : T("A Fire TV can't be sent music directly yet. Songsta on the Fire TV itself would show up here like your other devices."),
      confirmLabel: canOpenBluetooth ? T("Bluetooth settings") : "OK",
      cancelLabel: T("Close"),
      onConfirm: () => {
        if (canOpenBluetooth) window.open("ms-settings:bluetooth");
      },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-4">
        <h2 className="text-[20px] font-extrabold tracking-[-0.4px] text-ink-hi">{T("Devices")}</h2>
        <div className="flex items-center gap-0.5 text-ink-hi">
          <SmallButton title={T("Choose several devices")} onClick={() => setChoosing(choosing ? null : new Set())}>
            <ListChecks className="h-4 w-4" />
          </SmallButton>
          <SmallButton title={T("Look again")} onClick={() => void searchCastDevices()}>
            <RefreshCw className={`h-4 w-4 ${searching ? "animate-spin" : ""}`} />
          </SmallButton>
          <SmallButton title={T("Close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </SmallButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {pickingFor && (
          <div className="mx-1 mt-2 flex items-center gap-2 rounded-xl bg-accent/20 px-3 py-2 text-[13px] text-ink-hi">
            <span className="min-w-0 flex-1">{T("Choose a song or list: it plays on")}{" "}{[pickingFor, ...pickingWith].map(nameOf).join(" + ")}.</span>
            <button className="shrink-0 font-semibold underline" onClick={() => pickMusicFor(null)}>{T("Cancel")}</button>
          </div>
        )}

        <SwitchingOff />

        <Section title={T("This computer")}>
          <Tile
            icon={Laptop}
            name={T("This computer")}
            line={`${secondStream ? T("Second stream · ") : ""}${here && playing && track ? T("Playing · ") : ""}${outputLabel()}`}
            active={here}
            wide
            onClick={takeHere}
            onMenu={followed || secondStream ? hereMenu : undefined}
            actions={
              <>
                <SmallButton title={T("Choose the output")} onClick={() => setOpenOutputs(!openOutputs)}>
                  <Headphones className="h-4 w-4" />
                </SmallButton>
                {(followed || secondStream) && (
                  <SmallButton title={T("More")} onClick={hereMenu}>
                    <MoreHorizontal className="h-4 w-4" />
                  </SmallButton>
                )}
              </>
            }
          >
            {openOutputs && (
              <div className="mt-2 flex flex-col gap-0.5">
                {outputs.map((o) => (
                  <button
                    key={o.deviceId || "default"}
                    onClick={() => useSettings.getState().setAudioSinkId(o.deviceId)}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-ink-hi/10"
                  >
                    <Check className={`h-3.5 w-3.5 shrink-0 ${o.deviceId === sinkId ? "" : "opacity-0"}`} />
                    <span className="truncate">{o.label}</span>
                  </button>
                ))}
              </div>
            )}
          </Tile>
        </Section>

        {(around.length > 0 || syncStatus === "connected") && (
          <Section title={T("Your other devices")}>
            {around.length === 0 && <p className="col-span-2 px-1 text-[13px] text-ink-dim">{T("None of them is on right now.")}</p>}
            {around.map((d) => {
              const Icon = d.presence.kind === "computer" ? Laptop : Smartphone;
              const song = d.presence.track;
              const isFollowed = followed?.id === d.id;
              return (
                <Tile
                  key={d.id}
                  icon={Icon}
                  name={d.presence.name}
                  line={song ? `${d.presence.separate ? T("Second stream · ") : ""}${d.presence.playing ? "" : T("Paused · ")}${song.title}` : T("Ready")}
                  active={isFollowed}
                  wide={isFollowed}
                  onClick={() => (isFollowed ? undefined : sendToDevice(d.id, d.presence.name))}
                  actions={
                    song ? (
                      <SmallButton
                        title={d.presence.playing ? T("Pause there") : T("Play there")}
                        onClick={() => void otherDevices.send(d.id, { action: d.presence.playing ? "pause" : "play" })}
                      >
                        {d.presence.playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
                      </SmallButton>
                    ) : undefined
                  }
                >
                  {isFollowed && remoteVolume !== null && <VolumeRow value={remoteVolume} onChange={(v) => usePlayer.getState().setVolume(v)} />}
                </Tile>
              );
            })}
          </Section>
        )}

        <Section title={T("Speakers, receivers and TVs")}>
          {playable.length === 0 && <p className="col-span-2 px-1 text-[13px] text-ink-dim">{searching ? T("Looking on your network…") : T("Nothing found on your network.")}</p>}
          {playable.map((d) => {
            const zone = zoneOn(d.id);
            const isMain = inGroup(d.id) || active?.id === d.id;
            const Icon = kindIcon(d);
            const line = isMain ? (track ? `${connecting === d.id ? T("Waiting for it to start · ") : playing ? "" : T("Paused · ")}${track.title}` : T("Ready")) : zone ? zoneLine(zone) + withOthers(zone, d.id) : plugLine(d.id) ?? (d.model || T("Ready"));
            return (
              <Tile
                key={d.id}
                icon={Icon}
                name={nameOf(d)}
                line={line}
                active={(isMain || !!zone) && !choosing}
                wide={(isMain || !!zone) && !choosing}
                busy={connecting === d.id}
                picked={choosing ? choosing.has(d.id) : undefined}
                onClick={() => (choosing ? toggleChosen(d.id) : isMain ? undefined : zone ? zoneToggle(zone.id) : void moveTo(d))}
                onMenu={(e) => menu(e, d)}
                actions={
                  <>
                    {zone && (
                      <>
                        <SmallButton title={zone.state.state === "playing" ? T("Pause") : T("Play")} onClick={() => zoneToggle(zone.id)}>
                          {zone.state.state === "playing" ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
                        </SmallButton>
                        <SmallButton title={T("Next")} onClick={() => zoneNext(zone.id)}>
                          <SkipForward className="h-4 w-4 fill-current" />
                        </SmallButton>
                      </>
                    )}
                    {!zone && (isMain || active) && (
                      <SmallButton title={isMain ? T("Stop playing here") : T("Play along")} onClick={() => void (isMain ? leaveCast(d.id) : joinCast(d))}>
                        {isMain ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                      </SmallButton>
                    )}
                    <SmallButton title={T("More")} onClick={(e) => menu(e, d)}>
                      <MoreHorizontal className="h-4 w-4" />
                    </SmallButton>
                  </>
                }
              >
                {!choosing && isMain &&
                  (members.length > 1
                    ? members
                        .filter((m) => m.id === d.id && m.volume !== null)
                        .map((m) => <VolumeRow key={m.id} value={m.volume as number} onChange={(v) => setMemberVolume(m.id, v)} />)
                    : castVolume !== null && <VolumeRow value={castVolume} onChange={setCastVolume} />)}
                {!choosing && zone &&
                  zone.members
                    .filter((m) => m.id === d.id)
                    .map((m) => (
                      <div key={m.id}>
                        {m.volume !== null && <VolumeRow value={m.volume} onChange={(v) => zoneVolume(zone.id, m.id, v)} />}
                        {zone.members.length > 1 && (
                          <button className="mt-1 text-[12px] underline opacity-80" onClick={() => void zoneLeave(zone.id, m.id)}>{T("Leave the group")}</button>
                        )}
                      </div>
                    ))}
              </Tile>
            );
          })}
        </Section>

        {pairOnly.length > 0 && (
          <Section title={T("Over Bluetooth")}>
            {pairOnly.map((d) => (
              <Tile
                key={d.id}
                icon={d.kind === "echo" ? Bluetooth : Tv}
                name={nameOf(d)}
                line={d.kind === "echo" ? T("Pair it as a speaker") : T("Can't be sent music")}
                dim
                onClick={() => askBluetooth(d)}
                actions={
                  <SmallButton title={T("More")} onClick={(e) => menu(e, d)}>
                    <MoreHorizontal className="h-4 w-4" />
                  </SmallButton>
                }
              />
            ))}
          </Section>
        )}
      </div>
      {choosing && (
        <div className="border-t border-ink-hi/10 p-3">
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <span className="font-semibold text-ink-hi">{choosing.size === 1 ? T("1 device chosen") : T("{size} devices chosen", { size: choosing.size })}</span>
            <button className="text-ink-dim hover:text-ink-hi" onClick={() => setChoosing(null)}>{T("Cancel")}</button>
          </div>
          <div className="flex gap-2">
            <button
              disabled={!choosing.size}
              onClick={() => void playTogether()}
              className="h-9 flex-1 rounded-full bg-accent px-3 text-[13px] font-semibold text-black disabled:opacity-40"
            >{T("Play together")}</button>
            <button
              disabled={!choosing.size}
              onClick={() => {
                const [first, ...rest] = chosen();
                setChoosing(null);
                if (first) pickMusicFor(first, rest);
              }}
              className="h-9 flex-1 rounded-full bg-ink-hi/[0.1] px-3 text-[13px] font-semibold text-ink-hi hover:bg-ink-hi/[0.16] disabled:opacity-40"
            >{T("Other music")}</button>
          </div>
        </div>
      )}
      {plugging && <PlugDialog device={plugging} devices={playable} nameOf={nameOf} onClose={() => setPlugging(null)} />}
      {timing && <TimingDialog device={timing} name={nameOf(timing)} onClose={() => setTiming(null)} />}
    </div>
  );
}
