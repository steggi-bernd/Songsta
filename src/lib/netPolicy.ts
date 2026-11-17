/**
 * Settings → Network & privacy on the page's side: what's switched on goes to the main process at the
 * start and with every change (electron/net-gate.ts holds every request to it), and the page's own
 * work asks first where a whole job hangs on one service (album genres on MusicBrainz).
 */
import { useSettings } from "../stores/settings";

type PrivacyChoice = Pick<ReturnType<typeof useSettings.getState>, "netOwnOnly" | "netOff" | "recordListening">;

function say(s: PrivacyChoice): void {
  void window.bytune?.setPrivacy({ ownOnly: s.netOwnOnly, off: s.netOff, recordListening: s.recordListening }).catch(() => undefined);
}

/** Mount once (App). */
export function watchPrivacy(): () => void {
  say(useSettings.getState());
  const offChange = useSettings.subscribe((s, prev) => {
    if (s.netOwnOnly !== prev.netOwnOnly || s.netOff !== prev.netOff || s.recordListening !== prev.recordListening) say(s);
  });
  const offHydrated = useSettings.persist.onFinishHydration((s) => say(s));
  return () => {
    offChange();
    offHydrated();
  };
}

/** Whether a service may be asked now. */
export function serviceOn(id: string, s: PrivacyChoice = useSettings.getState()): boolean {
  return !s.netOwnOnly && !s.netOff.includes(id);
}
