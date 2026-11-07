/** The computer's share of switching devices off (lib/devicePower.ts): who has music on it, and who just lost it. */
import { create } from "zustand";
import { useDeviceNames } from "../stores/deviceNames";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import { leaveCast, useCast, type CastDevice } from "./cast";
import { bringToInput, canSwitchOff, inputName, isNetworkInput, linksToFollow, OWN_INPUT, receiverInUse, SwitchOffs, wentOffToo, type DeviceLink, type LeavingDevice } from "./devicePower";
import { T } from "./i18n";
import { useZones, zoneLeave, zoneStop } from "./zones";

export const useSwitchOffs = create<{ pending: LeavingDevice[] }>(() => ({ pending: [] }));

const isPairedTv = (id: string): boolean => useSettings.getState().pairedTvs.includes(id);

/** The word that went out about each one that's counting: out of date once it stops. */
const said = new Map<string, string>();

function devicesWithMusic(): Set<string> {
  const { active, members } = useCast.getState();
  const on = new Set<string>(members.map((m) => m.id));
  if (active) on.add(active.id);
  for (const z of useZones.getState().zones) {
    on.add(z.device.id);
    for (const m of z.members) on.add(m.id);
  }
  return on;
}

const offs = new SwitchOffs({
  readPower: async (id) => (await (isPairedTv(id) ? window.bytune?.tvPower(id) : window.bytune?.devicePower(id))) ?? null,
  switchOff: async (id) => (await (isPairedTv(id) ? window.bytune?.tvOff(id) : window.bytune?.deviceSwitchOff(id))) ?? false,
  afterSwitchedOff: (id) => watchReceiverStaysOn(id),
  inUse: (id) => receiverInUse(id, devicesWithMusic(), useSettings.getState().deviceLinks),
  changed: (pending) => {
    useSwitchOffs.setState({ pending });
    for (const [id, text] of said) {
      if (pending.some((d) => d.id === id)) continue;
      said.delete(id);
      const ui = useUI.getState();
      for (const t of ui.toasts) if (t.message === text) ui.dismissToast(t.id);
    }
  },
  counting: (d) => {
    const text = T("{name} switches off in 30 seconds", { name: d.name });
    said.set(d.id, text);
    useUI.getState().toast(text, "info", 30_000, { label: T("Keep on"), run: () => offs.forget(d.id) });
  },
});

export const keepDeviceOn = (id: string): void => offs.forget(id);

/** By hand: its music stops first, if it has any. */
export async function switchDeviceOff(device: CastDevice): Promise<void> {
  const name = useDeviceNames.getState().names[device.id] ?? device.name;
  const asked = offs.switchOffNow(device.id);
  const zone = useZones.getState().zones.find((z) => z.device.id === device.id || z.members.some((m) => m.id === device.id));
  if (zone) await (zone.members.length > 1 ? zoneLeave(zone.id, device.id) : zoneStop(zone.id));
  const { active, members } = useCast.getState();
  if (active?.id === device.id || members.some((m) => m.id === device.id)) await leaveCast(device.id);
  useUI.getState().toast((await asked) ? T("{name} is switching off", { name }) : T("{name} didn't take that", { name }), (await asked) ? "info" : "error");
}

const nameOf = (id: string): string => useDeviceNames.getState().names[id] ?? useCast.getState().devices.find((d) => d.id === id)?.name ?? id;

const comingAlong = new Set<string>();

/** Music on a device that hangs on a receiver: the receiver comes along, on and on that input. */
async function bringReceiverAlong(link: DeviceLink): Promise<void> {
  const bridge = window.bytune;
  if (!bridge || comingAlong.has(link.receiver)) return;
  comingAlong.add(link.receiver);
  const words = { name: nameOf(link.receiver), input: inputName(link.input) };
  const wanted = (): boolean => {
    const now = devicesWithMusic();
    return now.has(link.device) && !now.has(link.receiver);
  };
  try {
    const there = await bringToInput(
      { read: async () => (await bridge.devicePower(link.receiver)) ?? null, send: (word) => bridge.deviceCommand(link.receiver, word) },
      link.input,
      wanted,
      { onSwitching: () => useUI.getState().toast(T("{name} is switching to {input}", words)) }
    );
    if (!there && wanted()) useUI.getState().toast(T("{name} didn't switch to {input}", words), "error");
  } finally {
    comingAlong.delete(link.receiver);
  }
}

/** This device hangs on that input from now on. With music on it already, the receiver follows right away. */
export function plugInto(device: string, receiver: string, input: string): void {
  const { deviceLinks, setDeviceLinks } = useSettings.getState();
  const link = { device, receiver, input };
  setDeviceLinks([...deviceLinks.filter((l) => l.device !== device), link]);
  useUI.getState().toast(T("{device} hangs on {name} now: {input}. It switches over with the music.", { device: nameOf(device), name: nameOf(receiver), input: inputName(input) }));
  if (linksToFollow(devicesWithMusic(), new Set(), [link]).length) {
    offs.forget(receiver);
    void bringReceiverAlong(link);
  }
}

/** The input the receiver stands on right now: for when nobody knows what it's called. */
export async function plugIntoWhereItIs(device: string, receiver: string): Promise<void> {
  const power = await window.bytune?.devicePower(receiver);
  if (power?.input) plugInto(device, receiver, power.input);
  else useUI.getState().toast(T("{name} doesn't say which input it's on", { name: nameOf(receiver) }), "error");
}

export function unplug(device: string): void {
  const { deviceLinks, setDeviceLinks } = useSettings.getState();
  setDeviceLinks(deviceLinks.filter((l) => l.device !== device));
}

/**
 * A receiver handed a song goes to its own player by itself on the models tried so far: a moment
 * for that, and then it's told, for any where that isn't so.
 */
const OWN_INPUT_AFTER_MS = 3000;

async function backToOwnInput(id: string): Promise<void> {
  const bridge = window.bytune;
  const device = useCast.getState().devices.find((d) => d.id === id);
  if (!bridge || !device || !canSwitchOff(device.model) || comingAlong.has(id)) return;
  await new Promise((done) => window.setTimeout(done, OWN_INPUT_AFTER_MS));
  await bringToInput({ read: async () => (await bridge.devicePower(id)) ?? null, send: (word) => bridge.deviceCommand(id, word) }, OWN_INPUT, () => devicesWithMusic().has(id), { accept: isNetworkInput, noWaking: true });
}

/** The TV is off and the receiver has music: over HDMI it can go off along with it. */
function watchReceiverStaysOn(tv: string): void {
  const bridge = window.bytune;
  const link = useSettings.getState().deviceLinks.find((l) => l.device === tv);
  if (!bridge || !link || !devicesWithMusic().has(link.receiver)) return;
  void wentOffToo(async () => (await bridge.devicePower(link.receiver)) ?? null, () => devicesWithMusic().has(link.receiver)).then((went) => {
    if (!went) return;
    void bridge.deviceCommand(link.receiver, "PWON");
    useUI.getState().toast(T("{name} went off along with the TV. Set \"Pow.Off Control\" to \"Video\" in its HDMI setup, and it stays on with its music.", { name: nameOf(link.receiver) }), "error", 15_000);
  });
}

/** This app's code on the TV's screen, typed in: from then on it can be switched off from here. */
export async function pairTv(device: CastDevice): Promise<void> {
  const bridge = window.bytune;
  if (!bridge) return;
  const name = nameOf(device.id);
  try {
    await bridge.tvPairStart(device.id);
  } catch {
    useUI.getState().toast(T("{name} doesn't answer to that. It has to be switched on, and be a Google TV or Android TV.", { name }), "error");
    return;
  }
  const ask = (again = false): void =>
    useUI.getState().openDialog({
      title: T("The code on {name}", { name }),
      body: again ? T("That code doesn't fit, try again") : T("{name} shows a code now. Type it in here, and Songsta can switch it off from then on.", { name }),
      initialValue: "",
      placeholder: "A1B2C3",
      confirmLabel: T("Pair"),
      onCancel: () => void bridge.tvPairCancel(),
      onConfirm: (code) => {
        void bridge.tvPairFinish(code).then((result) => {
          const ui = useUI.getState();
          if (result === "mistyped") ask(true);
          else if (result === "ok") {
            const { pairedTvs, setPairedTvs } = useSettings.getState();
            setPairedTvs([...pairedTvs.filter((id) => id !== device.id), device.id]);
            ui.toast(T("{name} can be switched off from here now", { name }));
          } else ui.toast(T("{name} didn't take that code. Start again for a new one.", { name }), "error");
        });
      },
    });
  ask();
}

export function watchDevicesLeaving(): () => void {
  let before = devicesWithMusic();
  const look = (): void => {
    const now = devicesWithMusic();
    const wanted = useSettings.getState().switchOffDevices;
    offs.sawDevices(now, before, (id) => {
      const device = useCast.getState().devices.find((d) => d.id === id);
      return device ? { name: useDeviceNames.getState().names[id] ?? device.name, canSwitchOff: wanted && (canSwitchOff(device.model) || isPairedTv(id)) } : null;
    }, useSettings.getState().deviceLinks);
    for (const id of now) if (!before.has(id)) void backToOwnInput(id);
    for (const link of linksToFollow(now, before, useSettings.getState().deviceLinks)) {
      offs.forget(link.receiver);
      void bringReceiverAlong(link);
    }
    before = now;
  };
  const offCast = useCast.subscribe(look);
  const offZones = useZones.subscribe(look);
  return () => {
    offCast();
    offZones();
  };
}
