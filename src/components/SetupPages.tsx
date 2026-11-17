/**
 * The first start, in the app's own look: what it is, where the music comes from (a
 * folder and a server count the same), and what's worth asking Windows for right away.
 * Somebody who already has music in here from before never sees it.
 */
import { useEffect, useState } from "react";
import { AudioLines, Check, ChevronLeft, FolderOpen, Loader2, Server, ShieldCheck, Speaker, type LucideIcon } from "lucide-react";
import brandLogo from "../assets/brand/songsta-logo.svg";
import { fmtDuration } from "../lib/format";
import { T, textLocale } from "../lib/i18n";
import { useAnalysis } from "./MediaAnalysis";
import { isMac } from "../lib/platform";
import { useLibrary } from "../stores/library";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import { ConnectCard as JellyfinConnect } from "../views/JellyfinView";
import { ConnectCard as NavidromeConnect } from "../views/SubsonicView";
import { CaptionButtons } from "./TopBar";

type Page = "welcome" | "music" | "privacy" | "analysis" | "devices";

/** What may go out to the internet, chosen on the first start (Settings → Network & privacy has the rest). */
type NetChoice = "all" | "own" | "pick";

/** One of the three choices: the same size, the chosen one ringed. */
function Choice({ title, line, chosen, onClick }: { title: string; line: string; chosen: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={chosen}
      className={`flex w-full items-start gap-4 rounded-2xl p-5 text-left transition-colors ${chosen ? "bg-ink-hi/[0.1] ring-2 ring-accent" : "bg-ink-hi/[0.06] hover:bg-ink-hi/[0.1]"}`}
    >
      <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${chosen ? "bg-accent text-on-primary" : "bg-ink-hi/[0.1]"}`}>{chosen && <Check className="h-4 w-4" strokeWidth={3} />}</span>
      <span className="min-w-0">
        <span className="block text-[16px] font-bold text-ink-hi">{title}</span>
        <span className="mt-1 block text-[13px] leading-snug text-ink-dim">{line}</span>
      </span>
    </button>
  );
}

function PrivacyPage({ choice, onChoice, onNext }: { choice: NetChoice; onChoice: (c: NetChoice) => void; onNext: () => void }) {
  return (
    <>
      <span className="grid h-14 w-14 place-items-center rounded-full bg-ink-hi/[0.08] text-ink-hi">
        <ShieldCheck className="h-7 w-7" />
      </span>
      <h1 className="mt-5 font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi">{T("What may Songsta ask the internet?")}</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-dim">{T("Your music, your servers and your devices at home never need it. Covers your files lack, artist facts and lyrics come from open services on the internet: only song, album and artist names go there.")}</p>
      <div className="mt-6 flex flex-col gap-3">
        <Choice chosen={choice === "all"} onClick={() => onChoice("all")} title={T("Everything that helps")} line={T("Covers, facts, lyrics and animated covers from the services listed in Settings. Each one can be switched off there.")} />
        <Choice chosen={choice === "own"} onClick={() => onChoice("own")} title={T("Only my own servers")} line={T("Nothing goes to the internet: what your files and servers have is what you see.")} />
        <Choice chosen={choice === "pick"} onClick={() => onChoice("pick")} title={T("Let me choose")} line={T("Settings → Network & privacy opens when you're done here, with every service and what goes to it.")} />
      </div>
      <div className="mt-8 flex items-center gap-2">
        <Button onClick={onNext}>{T("Continue")}</Button>
      </div>
    </>
  );
}

function AnalysisPage({ onStart, onLater }: { onStart: () => void; onLater: () => void }) {
  const a = useAnalysis();
  return (
    <>
      <span className="grid h-14 w-14 place-items-center rounded-full bg-ink-hi/[0.08] text-ink-hi">
        <AudioLines className="h-7 w-7" />
      </span>
      <h1 className="mt-5 font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi">{T("Measure your music once?")}</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-dim">{T("Tempo, key and energy of every song make Klingt wie, mixes that flow and smooth transitions work. The first time takes a while for a big library; it runs in the background, and you can pause it in Settings → Library.")}</p>
      {a.total > 0 && (
        <p className="mt-4 text-[15px] font-semibold text-ink-hi">{T("{count} songs, about {time} the first time.", { count: a.total.toLocaleString(textLocale()), time: fmtDuration(a.left) })}</p>
      )}
      <div className="mt-8 flex items-center gap-2">
        <Button onClick={onStart}>{T("Start now")}</Button>
        <Quiet onClick={onLater}>{T("Later")}</Quiet>
      </div>
    </>
  );
}

function useSetupNeeded(): boolean {
  const done = useSettings((s) => s.setupDone);
  const [needed, setNeeded] = useState(false);
  useEffect(() => {
    const bridge = window.bytune;
    if (done || !bridge) return;
    let gone = false;
    const look = async (): Promise<void> => {
      if (!useSettings.persist.hasHydrated() || !useLibrary.persist.hasHydrated()) return;
      const [lib, jellyfin, navidrome] = await Promise.all([bridge.localLibrary(), bridge.jellyfinStatus(), bridge.subsonicStatus()]);
      if (gone) return;
      const { liked, history, playlists } = useLibrary.getState();
      const hasMusic = (lib?.folders?.length ?? 0) > 0 || (jellyfin as { connected?: boolean })?.connected || (navidrome as { connected?: boolean })?.connected || liked.length > 0 || history.length > 0 || playlists.length > 0;
      if (hasMusic) useSettings.getState().setSetupDone(true);
      else setNeeded(true);
    };
    void look();
    const offs = [useSettings.persist.onFinishHydration(() => void look()), useLibrary.persist.onFinishHydration(() => void look())];
    return () => {
      gone = true;
      offs.forEach((off) => off());
    };
  }, [done]);
  return needed && !done;
}

function Button({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-12 items-center justify-center rounded-full bg-primary px-8 text-[15px] font-bold text-on-primary transition hover:scale-[1.03] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Quiet({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="inline-flex h-12 items-center justify-center rounded-full px-6 text-[14px] font-semibold text-ink-dim transition-colors hover:text-ink-hi">
      {children}
    </button>
  );
}

/** One way to the music. Both are the same size. */
function Source({ icon: Icon, title, line, done, busy, open, onClick }: { icon: LucideIcon; title: string; line: string; done: boolean; busy?: boolean; open?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex min-h-[148px] flex-1 flex-col items-start rounded-2xl p-5 text-left transition-colors ${open || done ? "bg-ink-hi/[0.1]" : "bg-ink-hi/[0.06] hover:bg-ink-hi/[0.1]"} ${done ? "ring-2 ring-accent" : ""}`}
    >
      <span className={`grid h-11 w-11 place-items-center rounded-full ${done ? "bg-accent text-on-primary" : "bg-ink-hi/[0.08] text-ink-hi"}`}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : done ? <Check className="h-5 w-5" strokeWidth={3} /> : <Icon className="h-5 w-5" />}
      </span>
      <span className="mt-4 text-[16px] font-bold text-ink-hi">{title}</span>
      <span className="mt-1 text-[13px] leading-snug text-ink-dim">{line}</span>
    </button>
  );
}

interface Chosen {
  /** songs found in the folders chosen here; null with none chosen yet */
  songs: number | null;
  connected: boolean;
}

function MusicPage({ chosen, onChosen, onNext, onLater }: { chosen: Chosen; onChosen: (change: Partial<Chosen>) => void; onNext: () => void; onLater: () => void }) {
  const filter = useSettings((s) => s.filterNonMusicAudio);
  const { songs, connected } = chosen;
  const [scanning, setScanning] = useState(false);
  const [server, setServer] = useState<"jellyfin" | "navidrome" | null>(null);
  const [openServer, setOpenServer] = useState(false);

  const pick = async (): Promise<void> => {
    const bridge = window.bytune;
    if (!bridge || scanning) return;
    const dir = await bridge.pickFolder();
    if (!dir) return;
    setScanning(true);
    try {
      await bridge.addLibraryFolders([dir]);
      useSettings.getState().setLocalMusicFolder(dir);
      const lib = (await bridge.scanLibrary(filter)) as { tracks?: unknown[] };
      onChosen({ songs: lib?.tracks?.length ?? 0 });
      window.dispatchEvent(new CustomEvent("bytune:local-library-updated", { detail: lib }));
    } catch {
      useUI.getState().toast(T("Couldn't import that folder"), "error");
    } finally {
      setScanning(false);
    }
  };

  const ready = songs !== null || connected;
  return (
    <>
      <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi">{T("Where's your music?")}</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-dim">{T("Either is fine, or both. You can add the other one later in Settings.")}</p>
      <div className="mt-6 flex gap-3">
        <Source
          icon={FolderOpen}
          title={T("On this computer")}
          line={scanning ? T("Reading your music…") : songs !== null ? T("{count} songs found. Press to add another folder.", { count: songs }) : T("Choose a folder with your music. No server, no account.")}
          done={songs !== null}
          busy={scanning}
          onClick={() => void pick()}
        />
        <Source
          icon={Server}
          title={T("On your own server")}
          line={connected ? T("Connected") : T("Jellyfin or Navidrome, at home and on the road.")}
          done={connected}
          open={openServer}
          onClick={() => !connected && setOpenServer(!openServer)}
        />
      </div>
      {openServer && !connected && (
        <div className="mt-3 rounded-2xl bg-ink-hi/[0.06] p-5">
          <div className="mb-4 flex gap-2">
            {(["jellyfin", "navidrome"] as const).map((which) => (
              <button
                key={which}
                onClick={() => setServer(which)}
                className={`h-9 rounded-full px-4 text-[13px] font-semibold transition-colors ${server === which ? "bg-primary text-on-primary" : "bg-ink-hi/[0.08] text-ink-hi hover:bg-ink-hi/[0.14]"}`}
              >
                {which === "jellyfin" ? T("Jellyfin") : T("Navidrome")}
              </button>
            ))}
          </div>
          {server === "jellyfin" && <JellyfinConnect plain onConnected={() => onChosen({ connected: true })} />}
          {server === "navidrome" && <NavidromeConnect plain onConnected={() => onChosen({ connected: true })} />}
        </div>
      )}
      <div className="mt-8 flex items-center gap-2">
        <Button onClick={onNext} disabled={!ready}>{T("Continue")}</Button>
        {!ready && <Quiet onClick={onLater}>{T("Later")}</Quiet>}
      </div>
    </>
  );
}

export function SetupPages() {
  const needed = useSetupNeeded();
  const [page, setPage] = useState<Page>("welcome");
  const [asksFirewall, setAsksFirewall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Chosen>({ songs: null, connected: false });
  const [net, setNet] = useState<NetChoice>("all");

  useEffect(() => {
    const bridge = window.bytune;
    if (!needed || !bridge) return;
    void Promise.all([bridge.firewallMatters(), bridge.firewallHasRule()]).then(([matters, has]) => setAsksFirewall(matters && !has));
  }, [needed]);

  if (!needed) return null;
  const finish = (): void => {
    useSettings.getState().setSetupDone(true);
    // "Let me choose": the page with every service opens.
    if (net === "pick") useUI.getState().navigate({ name: "settings", param: "privacy" });
  };
  const hasMusic = chosen.songs !== null || chosen.connected;
  const afterMusic = (): void => setPage("privacy");
  const afterPrivacy = (): void => {
    const s = useSettings.getState();
    s.setNetOwnOnly(net === "own");
    if (net === "all") s.setServicesOn(s.netOff, true);
    if (hasMusic) setPage("analysis");
    else if (asksFirewall) setPage("devices");
    else finish();
  };
  const afterAnalysis = (start: boolean): void => {
    if (start) useSettings.getState().startSoundAnalysis();
    if (asksFirewall) setPage("devices");
    else finish();
  };
  const allow = async (): Promise<void> => {
    setBusy(true);
    await window.bytune?.firewallAllow().catch(() => false);
    setBusy(false);
    finish();
  };

  return (
    <div className="fixed inset-0 z-[80] flex flex-col overflow-y-auto bg-base" role="dialog" aria-label={T("Set up Songsta")}>
      {/* The window moves by its top and keeps its buttons, as everywhere else. */}
      <div className="app-drag flex h-14 shrink-0 justify-end">{!isMac && <CaptionButtons />}</div>
      <div key={page} className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center px-8 pb-16 animate-rise-in">
        {page !== "welcome" && (
          <button
            onClick={() => setPage(page === "devices" ? (hasMusic ? "analysis" : "privacy") : page === "analysis" ? "privacy" : page === "privacy" ? "music" : "welcome")}
            aria-label={T("Back")}
            className="mb-4 grid h-9 w-9 -translate-x-2 place-items-center rounded-full text-ink-dim transition-colors hover:text-ink-hi"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {page === "welcome" && (
          <div className="flex flex-col items-center text-center">
            <img src={brandLogo} alt="" className="h-16 w-auto" />
            <h1 className="mt-5 font-display text-[44px] font-extrabold leading-tight tracking-[-0.03em] text-ink-hi">Songsta</h1>
            <p className="mt-2 text-[16px] leading-relaxed text-ink-dim">{T("Your music, wherever you keep it. No account and no ads.")}</p>
            <div className="mt-10">
              <Button onClick={() => setPage("music")}>{T("Get started")}</Button>
            </div>
          </div>
        )}
        {page === "music" && <MusicPage chosen={chosen} onChosen={(change) => setChosen({ ...chosen, ...change })} onNext={afterMusic} onLater={afterMusic} />}
        {page === "privacy" && <PrivacyPage choice={net} onChoice={setNet} onNext={afterPrivacy} />}
        {page === "analysis" && <AnalysisPage onStart={() => afterAnalysis(true)} onLater={() => afterAnalysis(false)} />}
        {page === "devices" && (
          <>
            <span className="grid h-14 w-14 place-items-center rounded-full bg-ink-hi/[0.08] text-ink-hi">
              <Speaker className="h-7 w-7" />
            </span>
            <h1 className="mt-5 font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi">{T("Your speakers and receivers")}</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-dim">{T("To play your local files on devices at home, they have to reach this computer. Windows' firewall stops that until you allow it, for your own network only. Windows asks you once.")}</p>
            <div className="mt-8 flex items-center gap-2">
              <Button onClick={() => void allow()} disabled={busy}>{T("Allow")}</Button>
              <Quiet onClick={finish}>{T("Not now")}</Quiet>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
