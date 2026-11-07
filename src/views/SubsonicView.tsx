/**
 * Navidrome / Subsonic — a self-hosted music server as a library source.
 * Not connected: a sign-in card. Connected: the server's songs, searchable
 * and playable like local files, with refresh and disconnect. Only a hashed
 * token is kept, in the main process (electron/subsonic.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { LogOut, RefreshCw, Search, Server } from "lucide-react";
import { TrackList } from "../components/TrackList";
import { EmptyState, SearchClear } from "../components/primitives";
import { matchesQuery, subsonicToTrack } from "../lib/libraryTracks";
import { announceRemoteLibraryChange } from "../stores/catalog";
import { useUI } from "../stores/ui";
import type { SubsonicLibrary, SubsonicStatus } from "../../electron/subsonic";
import { T } from "../lib/i18n";

const inputClass =
  "w-full h-10 px-3 rounded-lg bg-ink-hi/[0.05] border border-ink-hi/10 text-[13.5px] text-ink-hi placeholder:text-ink-faint outline-none focus:border-ink-hi/25";

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || T("Couldn't connect");
}

export function ConnectCard({ onConnected, plain }: { onConnected: (s: SubsonicStatus) => void; plain?: boolean }) {
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!window.bytune || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = (await window.bytune.subsonicConnect({ server, username, password })) as SubsonicStatus;
      setPassword("");
      onConnected(status);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className={`${plain ? "" : "max-w-[440px] "}space-y-4 animate-slide-up`}>
      {!plain && (
        <div>
          <h1 className="font-display text-[34px] font-bold tracking-[-0.03em] text-ink-hi">{T("Navidrome")}</h1>
          <p className="text-[13px] text-ink-faint mt-1">{T("Play the music on your Navidrome server — or any other Subsonic server — next to your local files.")}</p>
        </div>
      )}
      <label className="block space-y-1.5">
        <span className="text-[12.5px] font-semibold text-ink-dim">{T("Server address")}</span>
        <input
          className={inputClass}
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="http://192.168.1.20:4533"
          autoFocus
          spellCheck={false}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-[12.5px] font-semibold text-ink-dim">{T("User name")}</span>
        <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} />
      </label>
      <label className="block space-y-1.5">
        <span className="text-[12.5px] font-semibold text-ink-dim">{T("Password")}</span>
        <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      {error && <p className="text-[13px] text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy || !server.trim() || !username.trim()}
        className="inline-flex items-center gap-2 h-10 px-5 rounded-lg bg-accent text-[13.5px] font-semibold text-on-primary hover:brightness-110 transition-all disabled:opacity-50"
      >
        <Server className="w-4 h-4" />
        {busy ? T("Connecting…") : T("Connect")}
      </button>
      <p className="text-[12px] text-ink-faint">{T("Songsta keeps only a hashed sign-in token (the Subsonic standard), sealed by your operating system's keychain — never the password itself.")}</p>
    </form>
  );
}

export function SubsonicView() {
  const [status, setStatus] = useState<SubsonicStatus | null>(null);
  const [lib, setLib] = useState<SubsonicLibrary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState("");
  const toast = useUI((s) => s.toast);
  const openDialog = useUI((s) => s.openDialog);

  const refresh = async (): Promise<void> => {
    if (!window.bytune) return;
    setRefreshing(true);
    try {
      setLib((await window.bytune.subsonicRefresh()) as SubsonicLibrary);
      setStatus((await window.bytune.subsonicStatus()) as SubsonicStatus);
      announceRemoteLibraryChange();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void (async () => {
      const s = (await window.bytune?.subsonicStatus()) as SubsonicStatus | undefined;
      if (!s) return;
      setStatus(s);
      if (!s.connected) return;
      const cached = (await window.bytune?.subsonicLibrary()) as SubsonicLibrary | undefined;
      setLib(cached ?? null);
      if (!cached?.fetchedAt) void refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tracks = useMemo(() => {
    const all = (lib?.tracks ?? []).map(subsonicToTrack);
    const query = q.trim();
    return query ? all.filter((t) => matchesQuery(t, query)) : all;
  }, [lib, q]);

  if (!status) return null;
  if (!status.connected) {
    return (
      <ConnectCard
        onConnected={(s) => {
          setStatus(s);
          toast(T("Connected to {value}", { value: s.serverName ?? T("Navidrome") }), "success");
          void refresh();
        }}
      />
    );
  }

  const disconnect = (): void =>
    openDialog({
      title: T("Disconnect the server?"),
      body: T("Its songs disappear from Songsta until you connect again. Nothing on the server changes."),
      confirmLabel: T("Disconnect"),
      onConfirm: async () => {
        const s = (await window.bytune?.subsonicDisconnect()) as SubsonicStatus | undefined;
        setLib(null);
        if (s) setStatus(s);
        announceRemoteLibraryChange();
      },
    });

  const fetched = lib?.fetchedAt ? new Date(lib.fetchedAt).toLocaleString() : null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap animate-slide-up">
        <div className="min-w-0">
          <h1 className="font-display text-[34px] font-bold tracking-[-0.03em] text-ink-hi truncate">{status.serverName ?? T("Navidrome")}</h1>
          <p className="text-[13px] text-ink-faint mt-1 truncate" title={status.server ?? undefined}>
            {T("{value} songs · {userName} · {server}{value2}", { value: lib?.tracks.length ?? 0, userName: status.userName, server: status.server, value2: fetched ? T(" — updated {fetched}", { fetched }) : "" })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint pointer-events-none" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={T("Search this server")}
              className="w-52 h-9 pl-8 pr-9 rounded-lg bg-ink-hi/[0.05] border border-ink-hi/10 text-[13px] text-ink-hi placeholder:text-ink-faint outline-none focus:border-ink-hi/25"
            />
            <SearchClear value={q} onClear={() => setQ("")} />
          </div>
          <button
            onClick={() => void refresh()}
            disabled={refreshing}
            title={T("Reload the server's library")}
            className="w-9 h-9 grid place-items-center rounded-lg bg-ink-hi/[0.06] hover:bg-ink-hi/[0.12] text-ink-dim hover:text-ink-hi transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={disconnect}
            title={T("Disconnect")}
            className="w-9 h-9 grid place-items-center rounded-lg bg-ink-hi/[0.06] hover:bg-red-400/10 hover:text-red-400 text-ink-dim transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {refreshing && !lib?.tracks.length ? (
        <div className="flex items-center gap-3 text-[13px] text-ink-dim">
          <span className="w-4 h-4 rounded-full border-2 border-ink-hi/15 border-t-accent animate-spin" />{T("Loading the server's library…")}</div>
      ) : tracks.length > 0 ? (
        <TrackList tracks={tracks} showAlbum emptyLabel={T("No songs.")} />
      ) : (
        <EmptyState icon={Server} title={q.trim() ? T("No songs match") : T("No music on this server")} body={q.trim() ? undefined : T("Add music to the server, then reload.")} />
      )}
    </div>
  );
}
