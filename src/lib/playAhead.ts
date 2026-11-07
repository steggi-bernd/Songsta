/** How far ahead each device plays in a group, set by hand: the main process keeps the groups (electron/cast.ts). */
import { useSettings } from "../stores/settings";

export function watchPlayAhead(): () => void {
  const send = (map: Record<string, number>): void => void window.bytune?.castPlayAhead(map).catch(() => undefined);
  send(useSettings.getState().playAhead);
  return useSettings.subscribe((now, before) => {
    if (now.playAhead !== before.playAhead) send(now.playAhead);
  });
}
