/**
 * The listening history: every play, newest first and by day — scrobbling that never leaves this
 * computer (electron/listens.ts), loaded a page at a time. Replay ends with it; Home's "Everything
 * you heard" opens it as a page of its own (HeardView), with the covers.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Monitor, MonitorSmartphone, Smartphone } from "lucide-react";
import type { Listen } from "../../electron/listens";
import { Artwork } from "./primitives";
import { plural } from "../lib/format";
import { useHomeSync } from "../lib/homeSync";
import { T, textLocale } from "../lib/i18n";
import { ipcErrorText } from "../lib/ipcError";
import { LISTENS_UPDATED, useListenCursors } from "../lib/listenShare";
import { useCatalog } from "../stores/catalog";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";

/** The width an element has now, kept up to date. */
function useWidth<E extends HTMLElement>(): [RefObject<E>, number] {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const seen = new ResizeObserver(() => setWidth(el.clientWidth));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return [ref, width];
}

/** "Today", "Yesterday", else the weekday and date (the year only when it isn't this one). */
function dayTitle(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days === 0) return T("Today");
  if (days === 1) return T("Yesterday");
  return d.toLocaleDateString(textLocale(), { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/**
 * The history as far as it's loaded: the newest page first, the next one on `loadMore`, all of it
 * afresh when a play is added or another device's plays come in. `shared`: this computer's plays go
 * to the other devices through the sync service too.
 */
export function useListeningHistory(): { listens: Listen[]; more: boolean; total: number; loaded: boolean; shared: boolean; loadMore: () => void } {
  const [listens, setListens] = useState<Listen[]>([]);
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const linked = useHomeSync((s) => s.linked);
  const serviceMissing = useListenCursors((s) => s.missing);
  const shareListens = useSettings((s) => s.shareListens && s.syncPlaylists && s.recordListening);

  const load = (before?: number): void => {
    void window.bytune
      ?.listensPage(before, 100)
      .then((page) => {
        setListens((prev) => (before ? [...prev, ...page.listens] : page.listens));
        setMore(page.more);
        setTotal(page.total);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  };
  useEffect(() => {
    load();
    const again = (): void => load();
    window.addEventListener(LISTENS_UPDATED, again);
    return () => window.removeEventListener(LISTENS_UPDATED, again);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    listens,
    more,
    total,
    loaded: loaded || !window.bytune,
    shared: linked && !serviceMissing && shareListens,
    loadMore: () => {
      if (listens.length) load(listens[listens.length - 1].at);
    },
  };
}

/** The whole history saved as a spreadsheet (CSV), where the user picks. */
export async function exportListeningHistory(): Promise<void> {
  const toast = useUI.getState().toast;
  try {
    const res = await window.bytune?.listensExport();
    if (res) toast(T("Saved {count} to {pop}", { count: plural(res.count, T("listen"), T("listens")), pop: res.path.split(/[\\/]/).pop() }), "success");
  } catch (err) {
    toast(ipcErrorText(err, T("Couldn't save the listening history")), "error");
  }
}

/**
 * The history's rows by day, laid out for the room they have (a half-screen window with both side
 * panels leaves little): the artist where it fits; another device's name, or where that doesn't fit
 * its sign; and the song's title always. `covers`: each row starts with its song's cover. A row of a
 * song still in the library plays it — by `onPlay`, given the play and its place in `listens`, or
 * on its own.
 */
export function HistoryList({
  listens,
  more,
  onMore,
  covers = false,
  onPlay,
}: {
  listens: Listen[];
  more: boolean;
  onMore: () => void;
  covers?: boolean;
  onPlay?: (listen: Listen, at: number) => void;
}) {
  const byId = useCatalog((s) => s.byId);
  const [ref, width] = useWidth<HTMLDivElement>();
  const withArtist = width === 0 || width >= 420;
  const deviceNames = width === 0 || width >= 600;
  // Too narrow (a half-screen window with both side panels), the covers would take the titles' room.
  const withCovers = covers && (width === 0 || width >= 360);
  // Another device's plays carry its name at the row's end; every row keeps that place, so the columns line up.
  const anyRemote = listens.some((l) => l.device);
  const days: { title: string; items: { listen: Listen; at: number }[] }[] = [];
  listens.forEach((listen, at) => {
    const title = dayTitle(listen.at);
    const last = days[days.length - 1];
    if (last?.title === title) last.items.push({ listen, at });
    else days.push({ title, items: [{ listen, at }] });
  });

  return (
    <div ref={ref} className="glass-pill rounded-2xl p-2">
      {days.map((d) => (
        <div key={d.title}>
          <div className="px-3 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{d.title}</div>
          {d.items.map(({ listen: l, at }) => {
            const track = byId.get(l.id);
            const said = T("Played on {device}", { device: l.deviceName || T("Other device") });
            const DeviceSign = l.deviceKind === "phone" ? Smartphone : l.deviceKind === "computer" ? Monitor : MonitorSmartphone;
            const play = track ? () => (onPlay ? onPlay(l, at) : usePlayer.getState().playTrack(track)) : undefined;
            return (
              <div
                key={`${l.at}-${at}`}
                onClick={play}
                title={track ? T("Play {title}", { title: l.title }) : undefined}
                className={`flex items-center gap-3 px-3 ${withCovers ? "h-[52px]" : "h-11"} rounded-lg transition-colors hover:bg-ink-hi/[0.05] ${track ? "cursor-pointer" : ""}`}
              >
                <span className="min-w-12 shrink-0 whitespace-nowrap text-[12.5px] tabular-nums text-ink-faint">
                  {new Date(l.at).toLocaleTimeString(textLocale(), { hour: "2-digit", minute: "2-digit" })}
                </span>
                {withCovers && <Artwork src={track?.thumb ?? ""} className="w-9 h-9 shrink-0" rounded="rounded-md" alt="" />}
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink-hi">{l.title}</span>
                {withArtist && (
                  <span className={`${deviceNames ? "w-[40%]" : "w-[34%]"} min-w-0 truncate text-[13px] text-ink-dim`}>
                    {l.artist}
                    {l.album ? ` · ${l.album}` : ""}
                  </span>
                )}
                {/* Another device's play, from the shared history: every row keeps the place, so the columns line up. */}
                {anyRemote &&
                  (deviceNames ? (
                    <span className="w-[96px] shrink-0 flex justify-end">
                      {l.device && (
                        <span className="max-w-full truncate rounded-full bg-ink-hi/[0.07] px-2 py-0.5 text-[11px] font-semibold text-ink-dim" title={said}>
                          {l.deviceName || T("Other device")}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="w-5 shrink-0 grid place-items-center text-ink-dim" title={l.device ? said : undefined}>
                      {l.device && <DeviceSign className="w-4 h-4" aria-label={said} />}
                    </span>
                  ))}
              </div>
            );
          })}
        </div>
      ))}
      {more && (
        <button
          onClick={onMore}
          className="w-full h-10 mt-1 rounded-lg text-[13px] font-semibold text-ink-hi/70 hover:text-ink-hi hover:bg-ink-hi/[0.05] transition-colors"
        >{T("Show more")}</button>
      )}
    </div>
  );
}
