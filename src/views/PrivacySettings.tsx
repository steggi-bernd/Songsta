/**
 * Settings → Network & privacy (the user's wish for full control and full transparency, 2026-11-15):
 * which services on the internet Songsta may ask, what each is for and what goes to it, and a log of
 * what was asked (electron/net-gate.ts holds back what's switched off); what's kept on this computer,
 * and where (electron/data-location.ts); what's shared with your own sync service and server.
 */
import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  Download,
  Film,
  FolderInput,
  FolderOpen,
  Globe,
  HardDrive,
  Heart,
  Info,
  KeyRound,
  Library,
  MessageCircle,
  MicVocal,
  RefreshCcw,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  SkipForward,
  Speaker,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { NetActivity } from "../../electron/net-gate";
import type { DataPlace } from "../../electron/data-location";
import { ActionRow, Divider, SettingsGroup, SettingsRow, Switch } from "../components/SettingsChrome";
import { fmtBytes } from "../lib/format";
import { T, textLocale } from "../lib/i18n";
import { NET_GROUPS, NET_SERVICES, type NetGroup, type NetService } from "../lib/netServices";
import { removeSharedListens, useHomeSync } from "../lib/homeSync";
import { useRecents } from "../stores/recents";
import { useSettings } from "../stores/settings";
import { useSkips } from "../stores/skips";
import { useCatalog } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { useLibraryOrder } from "../stores/libraryOrder";
import { soundCounts, useSound } from "../stores/sound";
import { useUI } from "../stores/ui";
import { jumpInSettings } from "../lib/settingsJump";

const GROUP_HEADER: Record<NetGroup, string> = {
  info: "Music facts",
  lyrics: "Lyrics",
  covers: "Animated covers",
  updates: "Updates and tools",
};
const GROUP_ICON: Record<NetGroup, LucideIcon> = { info: Info, lyrics: MicVocal, covers: Film, updates: Download };
const GROUP_FOOTER: Record<NetGroup, string> = {
  info: "Answers are kept on this computer, so each thing is asked once.",
  lyrics: "A song's lyrics are asked of the providers switched on at the same time; the best answer wins. Your own lyrics (in the files, beside them, on your server) always work.",
  covers: "Only while Animated cover art is on (Settings → Display).",
  updates: "Asked once a day while Startup & updates allow it.",
};

/** "3 min ago", in the interface's language. */
function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  const rtf = new Intl.RelativeTimeFormat(textLocale(), { numeric: "auto" });
  if (s < 60) return rtf.format(-Math.max(1, s), "second");
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  return rtf.format(-Math.round(s / 3600), "hour");
}

/** The connection log, asked again every two seconds while the page shows. */
function useActivity(): NetActivity | null {
  const [activity, setActivity] = useState<NetActivity | null>(null);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void window.bytune
        ?.netActivity()
        .then((a) => live && setActivity(a))
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  return activity;
}

function ServiceRow({ service, activity, icon }: { service: NetService; activity: NetActivity | null; icon: LucideIcon }) {
  const ownOnly = useSettings((s) => s.netOwnOnly);
  const off = useSettings((s) => s.netOff.includes(service.id));
  const setOn = useSettings((s) => s.setServiceOn);
  const seen = activity?.services[service.id];
  const on = !ownOnly && !off;
  const asked = seen?.last ? T("last asked {when}", { when: ago(seen.last) }) : T("not asked since Songsta started");
  return (
    <SettingsRow
      icon={icon}
      title={service.name}
      subtitle={`${T(service.purpose)} · ${T("Sends: {what}", { what: T(service.sends) })} · ${asked}`}
      trailing={<Switch checked={on} disabled={ownOnly} onChange={(v) => setOn(service.id, v)} label={service.name} />}
      onClick={ownOnly ? undefined : () => setOn(service.id, !on)}
    />
  );
}

/** One group of services; the lyrics have a main switch, the providers under it fold away. */
function ServiceGroup({ group, activity }: { group: NetGroup; activity: NetActivity | null }) {
  const services = NET_SERVICES.filter((s) => s.group === group);
  const ownOnly = useSettings((s) => s.netOwnOnly);
  const netOff = useSettings((s) => s.netOff);
  const setMany = useSettings((s) => s.setServicesOn);
  const [open, setOpen] = useState(false);
  const icon = GROUP_ICON[group];
  if (group !== "lyrics") {
    return (
      <SettingsGroup header={T(GROUP_HEADER[group])} footer={T(GROUP_FOOTER[group])}>
        {services.map((s, i) => (
          <div key={s.id}>
            {i > 0 && <Divider />}
            <ServiceRow service={s} activity={activity} icon={icon} />
          </div>
        ))}
      </SettingsGroup>
    );
  }
  const onCount = services.filter((s) => !netOff.includes(s.id)).length;
  const anyOn = !ownOnly && onCount > 0;
  return (
    <SettingsGroup header={T(GROUP_HEADER[group])} footer={T(GROUP_FOOTER[group])}>
      <SettingsRow
        icon={icon}
        title={T("Lyrics from the internet")}
        subtitle={ownOnly ? T("Off with Only my own servers") : T("{on} of {count} providers on", { on: onCount, count: services.length })}
        trailing={<Switch checked={anyOn} disabled={ownOnly} onChange={(v) => setMany(services.map((s) => s.id), v)} label={T("Lyrics from the internet")} />}
        onClick={ownOnly ? undefined : () => setMany(services.map((s) => s.id), !anyOn)}
      />
      <Divider />
      <SettingsRow
        icon={ChevronDown}
        title={open ? T("Fewer details") : T("Choose providers one by one")}
        onClick={() => setOpen(!open)}
        trailing={<ChevronDown className={`w-5 h-5 text-ink-dim/70 transition-transform ${open ? "rotate-180" : ""}`} />}
      />
      {open &&
        services.map((s) => (
          <div key={s.id}>
            <Divider />
            <ServiceRow service={s} activity={activity} icon={MicVocal} />
          </div>
        ))}
    </SettingsGroup>
  );
}

/** Your own servers and devices: always reachable, said here so the picture is whole. */
function OwnGroup({ activity }: { activity: NetActivity | null }) {
  const [servers, setServers] = useState<{ jellyfin: string | null; navidrome: string | null }>({ jellyfin: null, navidrome: null });
  const syncAddress = useHomeSync((s) => s.address);
  const discord = useSettings((s) => s.discordPresence);
  useEffect(() => {
    const bridge = window.bytune;
    if (!bridge) return;
    void Promise.all([bridge.jellyfinStatus().catch(() => null), bridge.subsonicStatus().catch(() => null)]).then(([jf, ss]) => {
      const j = jf as { connected?: boolean; server?: string | null } | null;
      const n = ss as { connected?: boolean; server?: string | null } | null;
      setServers({ jellyfin: j?.connected ? (j.server ?? "") : null, navidrome: n?.connected ? (n.server ?? "") : null });
    });
  }, []);
  const host = (address: string | null): string => {
    try {
      return address ? new URL(address).host : "";
    } catch {
      return address ?? "";
    }
  };
  const navigate = useUI.getState().navigate;
  return (
    <SettingsGroup
      header={T("Your own servers and devices")}
      footer={activity ? T("Always reachable, also with Only my own servers: they're yours. {count} requests to them since Songsta started.", { count: activity.own.count.toLocaleString(textLocale()) }) : undefined}
    >
      <SettingsRow icon={Server} title={T("Jellyfin")} subtitle={servers.jellyfin !== null ? host(servers.jellyfin) : T("Not connected")} onClick={() => navigate({ name: "jellyfin" })} />
      <Divider />
      <SettingsRow icon={Server} title={T("Navidrome")} subtitle={servers.navidrome !== null ? host(servers.navidrome) : T("Not connected")} onClick={() => navigate({ name: "subsonic" })} />
      <Divider />
      <SettingsRow icon={RefreshCcw} title={T("Sync service")} subtitle={syncAddress ? host(syncAddress) : T("Not linked")} onClick={() => jumpInSettings("connections", T("Server sync"))} />
      <Divider />
      <SettingsRow icon={Speaker} title={T("Devices at home")} subtitle={T("Speakers, TVs and receivers, found and played to in your home network only")} />
      <Divider />
      <SettingsRow icon={MessageCircle} title={T("Discord status")} subtitle={T("Only the Discord app on this computer is told what plays")} value={discord ? T("On") : T("Off")} onClick={() => jumpInSettings("connections", T("Discord"))} />
    </SettingsGroup>
  );
}

const nameOf = (id: string): string => (id === "other" ? T("Elsewhere") : (NET_SERVICES.find((s) => s.id === id)?.name ?? id));

function LogGroup({ activity }: { activity: NetActivity | null }) {
  const [open, setOpen] = useState(false);
  const entries = activity?.log ?? [];
  const asked = activity ? Object.values(activity.services).reduce((sum, s) => sum + s.count, 0) : 0;
  const held = activity ? Object.values(activity.services).reduce((sum, s) => sum + s.blocked, 0) : 0;
  const n = (v: number): string => v.toLocaleString(textLocale());
  return (
    <SettingsGroup header={T("Connection log")} footer={T("Only on this computer and only until Songsta closes: when, which service, which address. No song or search goes into it.")}>
      <SettingsRow
        icon={ScrollText}
        title={T("{asked} requests to the internet since Songsta started", { asked: n(asked) })}
        subtitle={held ? T("{held} held back by your switches", { held: n(held) }) : T("Nothing held back")}
        onClick={() => setOpen(!open)}
        trailing={<ChevronDown className={`w-5 h-5 text-ink-dim/70 transition-transform ${open ? "rotate-180" : ""}`} />}
      />
      {open && (
        <div className="px-4 pb-3">
          {entries.length === 0 && <div className="text-[12.5px] text-ink-dim py-2">{T("Nothing asked of the internet yet.")}</div>}
          {entries.slice(0, 80).map((e, i) => (
            <div key={`${e.at}-${i}`} className="flex items-center gap-3 py-1.5 text-[12.5px] border-t border-ink-hi/[0.06] first:border-t-0">
              <span className="w-16 shrink-0 tabular-nums text-ink-faint">{new Date(e.at).toLocaleTimeString(textLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className="w-40 shrink-0 truncate text-ink-hi">{nameOf(e.service)}</span>
              <span className="min-w-0 flex-1 truncate text-ink-dim">{e.host}</span>
              {e.blocked && <span className="shrink-0 rounded-full bg-ink-hi/[0.1] px-2 py-0.5 text-[11px] font-semibold text-ink-dim">{T("held back")}</span>}
            </div>
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}

interface Usage {
  listening: number;
  searches: number;
  skips: number;
  analysis: number;
  caches: number;
  total: number;
}

function SmallButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className="h-8 rounded-full bg-ink-hi/[0.08] px-3 text-[12.5px] font-semibold text-ink-hi transition-colors hover:bg-ink-hi/[0.14] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function KeptGroup() {
  const s = useSettings();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [place, setPlace] = useState<DataPlace | null>(null);
  const [nonce, setNonce] = useState(0);
  const tracks = useCatalog((st) => st.tracks);
  const facts = useSound((st) => st.facts);
  const measured = useMemo(() => {
    const c = soundCounts(tracks, facts);
    return c.local.done - c.local.skipped + c.server.done - c.server.skipped;
  }, [tracks, facts]);
  useEffect(() => {
    void window.bytune?.dataUsage().then(setUsage).catch(() => undefined);
    void window.bytune?.dataPlace().then(setPlace).catch(() => undefined);
  }, [nonce]);
  const again = (): void => setNonce((v) => v + 1);
  const { openDialog, toast } = useUI.getState();
  const size = (v: number | undefined): string => (v === undefined ? "…" : fmtBytes(v));
  const custom = !!place && place.folder.toLowerCase() !== place.usual.toLowerCase();

  const move = async (): Promise<void> => {
    const target = await window.bytune?.dataPickFolder().catch(() => null);
    if (!target) return;
    openDialog({
      title: T("Move your data?"),
      body: T("Songsta closes, copies everything to “{folder}” as it starts again, and keeps it there from then on. The old copy stays where it is until you remove it.", { folder: target }),
      confirmLabel: T("Move and restart"),
      onConfirm: async () => {
        const res = await window.bytune?.dataMove(target).catch(() => null);
        if (!res?.ok) toast(T(res?.reason ?? "Couldn't move your data"), "error");
      },
    });
  };
  const moveBack = (): void => {
    if (!place) return;
    openDialog({
      title: T("Back to the usual folder?"),
      body: T("Songsta closes, copies everything back to “{folder}” as it starts again, and keeps it there.", { folder: place.usual }),
      confirmLabel: T("Move and restart"),
      onConfirm: async () => {
        const res = await window.bytune?.dataMove(place.usual).catch(() => null);
        if (!res?.ok) toast(T(res?.reason ?? "Couldn't move your data"), "error");
      },
    });
  };
  const removeOld = (): void => {
    if (!place?.leftover) return;
    openDialog({
      title: T("Remove the old copy?"),
      body: T("Everything Songsta kept in “{folder}” before the move is deleted. Your data in “{now}” stays. This can't be undone.", { folder: place.leftover, now: place.folder }),
      confirmLabel: T("Remove"),
      danger: true,
      onConfirm: async () => {
        await window.bytune?.dataForgetLeftover().catch(() => false);
        again();
      },
    });
  };
  const clearPlays = (): void =>
    openDialog({
      title: T("Delete your plays?"),
      body: T("The listening history, Recently played, Replay and play counts on this computer start from nothing. What your sync service already has stays there. This can't be undone."),
      confirmLabel: T("Delete"),
      danger: true,
      onConfirm: async () => {
        await window.bytune?.dataClearListening().catch(() => false);
        useLibrary.getState().clearHistory();
        useLibraryOrder.getState().forgetPlayed();
        void useCatalog.getState().refreshPlayCounts();
        again();
      },
    });
  const clearCaches = (): void =>
    openDialog({
      title: T("Empty the answers from the internet?"),
      body: T("Songsta restarts and asks again when something is needed: facts, covers' details and lyrics. Your music, plays and settings aren't touched."),
      confirmLabel: T("Empty and restart"),
      onConfirm: () => void window.bytune?.dataClearCaches().catch(() => false),
    });

  return (
    <SettingsGroup header={T("Kept on this computer")} footer={usage ? T("All of Songsta's data in this folder: {size}. Nothing of it leaves the computer unless you share it below.", { size: fmtBytes(usage.total) }) : undefined}>
      <ActionRow
        icon={HardDrive}
        title={T("Where your data is kept")}
        subtitle={place ? `${place.folder}${custom ? ` · ${T("a folder you chose")}` : ` · ${T("Songsta's usual folder")}`}` : "…"}
        breakAnywhere
        actions={
          <>
            <SmallButton onClick={() => void window.bytune?.dataOpen()}>{T("Open")}</SmallButton>
            <SmallButton onClick={() => void move()}>{T("Move…")}</SmallButton>
            {custom && <SmallButton onClick={moveBack}>{T("Back to the usual folder")}</SmallButton>}
          </>
        }
      />
      {place?.leftover && (
        <>
          <Divider />
          <ActionRow icon={FolderOpen} title={T("The old copy is still there")} subtitle={place.leftover} breakAnywhere actions={<SmallButton onClick={removeOld}>{T("Remove")}</SmallButton>} />
        </>
      )}
      {place?.moving && (
        <>
          <Divider />
          <ActionRow icon={FolderInput} title={T("Moves at the next start")} subtitle={place.moving} breakAnywhere actions={<SmallButton onClick={() => void window.bytune?.dataCancelMove().then(again)}>{T("Cancel")}</SmallButton>} />
        </>
      )}
      {place?.failed && (
        <>
          <Divider />
          <SettingsRow icon={Info} title={T("The last move didn't work")} subtitle={T(place.failed)} />
        </>
      )}
      <Divider />
      <ActionRow
        icon={BarChart3}
        title={T("Keep my plays")}
        subtitle={T("The listening history, Recently played, Replay and play counts · {size}", { size: size(usage?.listening) })}
        actions={<SmallButton onClick={clearPlays}>{T("Delete")}</SmallButton>}
        trailing={<Switch checked={s.recordListening} onChange={s.setRecordListening} label={T("Keep my plays")} />}
      />
      <Divider />
      <ActionRow
        icon={Search}
        title={T("Keep my searches")}
        subtitle={T("The search page's recent searches · {size}", { size: size(usage?.searches) })}
        actions={<SmallButton onClick={() => (useRecents.getState().clearSearches(), toast(T("Searches deleted"), "success"), setTimeout(again, 800))}>{T("Delete")}</SmallButton>}
        trailing={<Switch checked={s.recordSearches} onChange={s.setRecordSearches} label={T("Keep my searches")} />}
      />
      <Divider />
      <ActionRow
        icon={SkipForward}
        title={T("Remember songs I skip")}
        subtitle={T("So mixes play them less · {size}", { size: size(usage?.skips) })}
        actions={<SmallButton onClick={() => (useSkips.getState().forget(), toast(T("Skips forgotten"), "success"), setTimeout(again, 800))}>{T("Forget")}</SmallButton>}
        trailing={<Switch checked={s.recordSkips} onChange={s.setRecordSkips} label={T("Remember songs I skip")} />}
      />
      <Divider />
      <ActionRow
        icon={Globe}
        title={T("Answers from the internet")}
        subtitle={T("Facts, covers' details and lyrics already asked for, so nothing is asked twice · {size}", { size: size(usage?.caches) })}
        actions={<SmallButton onClick={clearCaches}>{T("Empty")}</SmallButton>}
      />
      <Divider />
      <SettingsRow
        icon={Library}
        title={T("Media analysis")}
        subtitle={T("{count} songs measured here · {size} · start and progress under Library", { count: measured.toLocaleString(textLocale()), size: size(usage?.analysis) })}
        onClick={() => jumpInSettings("library", T("Media analysis"))}
      />
      <Divider />
      <SettingsRow icon={KeyRound} title={T("Your logins")} subtitle={T("Sealed by your operating system's keychain; never in a backup")} />
    </SettingsGroup>
  );
}

function SharedGroup() {
  const s = useSettings();
  const linked = useHomeSync((st) => st.linked);
  const toast = useUI((st) => st.toast);
  const removePlays = (): void =>
    useUI.getState().openDialog({
      title: T("Take this computer's plays off your sync service?"),
      body: T("They leave the history your devices share. Your other devices keep the ones they already have, and this computer keeps its own history. New plays go there again while the listening history is shared."),
      confirmLabel: T("Take them off"),
      danger: true,
      onConfirm: async () => {
        const result = await removeSharedListens();
        if (result === "removed") toast(T("This computer's plays are off your sync service"), "success");
        else if (result === "old-service") toast(T("Your sync service can't do that yet: it needs its update"), "error");
        else if (result === "not-linked") toast(T("No sync service is linked"), "error");
        else toast(T("Your sync service didn't answer. Try again later."), "error");
      },
    });
  return (
    <SettingsGroup header={T("Shared with your own servers")} footer={T("Your sync service and your music server are yours: what goes there stays at home, or wherever you run them.")}>
      <SettingsRow
        icon={RefreshCcw}
        title={T("Your sync service")}
        subtitle={T("Playlists, likes, where playback stopped, and which of your devices plays what")}
        trailing={<Switch checked={s.syncPlaylists} onChange={s.setSyncPlaylists} label={T("Your sync service")} />}
        onClick={() => s.setSyncPlaylists(!s.syncPlaylists)}
      />
      <Divider />
      <SettingsRow
        icon={Library}
        title={T("Library order, groups and album edits")}
        subtitle={T("Through your sync service, to your other devices")}
        disabled={!s.syncPlaylists}
        trailing={<Switch checked={s.shareLibrary && s.syncPlaylists} disabled={!s.syncPlaylists} onChange={s.setShareLibrary} label={T("Library order, groups and album edits")} />}
      />
      <Divider />
      <SettingsRow
        icon={BarChart3}
        title={T("Listening history")}
        subtitle={s.recordListening ? T("Every play goes to your sync service, so Replay counts all your devices") : T("Off while your plays aren't kept on this computer")}
        disabled={!s.syncPlaylists || !s.recordListening}
        trailing={
          <Switch
            checked={s.shareListens && s.syncPlaylists && s.recordListening}
            disabled={!s.syncPlaylists || !s.recordListening}
            onChange={s.setShareListens}
            label={T("Listening history")}
          />
        }
      />
      {linked && s.syncPlaylists && (
        <>
          <Divider />
          <ActionRow
            icon={Trash2}
            title={T("This computer's plays on the sync service")}
            subtitle={T("Take them off: your other devices keep what they have, this computer keeps its own history")}
            actions={<SmallButton onClick={removePlays}>{T("Take them off")}</SmallButton>}
          />
        </>
      )}
      <Divider />
      <SettingsRow
        icon={Heart}
        title={T("Liked Songs and server favorites")}
        subtitle={T("Kept the same both ways on Jellyfin or Navidrome")}
        trailing={<Switch checked={s.serverSync} onChange={s.setServerSync} label={T("Liked Songs and server favorites")} />}
        onClick={() => s.setServerSync(!s.serverSync)}
      />
      <Divider />
      <SettingsRow
        icon={Server}
        title={T("Count plays on the server")}
        subtitle={T("Jellyfin or Navidrome learns what you played")}
        trailing={<Switch checked={s.serverPlays} onChange={s.setServerPlays} label={T("Count plays on the server")} />}
        onClick={() => s.setServerPlays(!s.serverPlays)}
      />
      <Divider />
      <SettingsRow icon={MessageCircle} title={T("Discord status")} subtitle={T("What plays, on your Discord profile")} value={s.discordPresence ? T("On") : T("Off")} onClick={() => jumpInSettings("connections", T("Discord"))} />
    </SettingsGroup>
  );
}

/** The category's page. */
export function PrivacyBlock() {
  const activity = useActivity();
  const ownOnly = useSettings((s) => s.netOwnOnly);
  const setOwnOnly = useSettings((s) => s.setNetOwnOnly);
  return (
    <>
      <SettingsGroup header={T("Connections")} footer={T("Each switch holds back every request to that service: nothing of it leaves this computer while it's off.")}>
        <SettingsRow
          icon={ShieldCheck}
          title={T("Only my own servers")}
          subtitle={T("Every service on the internet off at once: no facts, covers or lyrics from outside. Your servers and the devices at home always work.")}
          trailing={<Switch checked={ownOnly} onChange={setOwnOnly} label={T("Only my own servers")} />}
          onClick={() => setOwnOnly(!ownOnly)}
        />
      </SettingsGroup>
      {NET_GROUPS.map((g) => (
        <ServiceGroup key={g} group={g} activity={activity} />
      ))}
      <OwnGroup activity={activity} />
      <LogGroup activity={activity} />
      <KeptGroup />
      <SharedGroup />
    </>
  );
}
