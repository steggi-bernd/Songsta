/** Who is signed in where. The login token lives in the phone's secure store; the password is never kept. */
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import Player from "../../modules/media3-player";
import { atAddress } from "../addresses";
import { acceptsLogin, authHeader, normalizeServer, serverIdAt, signIn, signOut, type Session } from "../jellyfin";
import { trustEntered } from "../netGate";

const KEY = "session";
const ASK_MS = 8000;

interface SessionState {
  ready: boolean;
  session: Session | null;
  restore(): Promise<void>;
  signIn(server: string, username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** The server answers at this one of its addresses now. */
  moveTo(server: string, serverId?: string): Promise<void>;
  /** A new address, once it proved to lead to this server; throws what's wrong. Empty takes the away address back. */
  setAddress(which: "home" | "away", input: string): Promise<void>;
}

/** The player's streams go out under this login. */
const authorizePlayer = (s: Session): Promise<void> =>
  Player.setAuth(
    s.server,
    { Authorization: authHeader(s.deviceId, s.token) },
    [s.home, s.away].filter((a): a is string => !!a)
  );

const keep = (s: Session): Promise<void> => SecureStore.setItemAsync(KEY, JSON.stringify(s));

export const useSession = create<SessionState>((set, get) => {
  const adopt = async (session: Session): Promise<void> => {
    set({ session });
    await keep(session);
    await authorizePlayer(session);
  };

  return {
    ready: false,
    session: null,

    async restore() {
      let session: Session | null = null;
      try {
        const raw = await SecureStore.getItemAsync(KEY);
        // A login from before there were two addresses has only the one.
        const saved = raw ? (JSON.parse(raw) as Session) : null;
        session = saved ? { ...saved, home: saved.home ?? saved.server } : null;
      } catch {
        /* unreadable: sign in again */
      }
      if (session) await authorizePlayer(session);
      set({ session, ready: true });
    },

    // An address typed in for your own server goes through even with "only my own servers" on (netGate.ts).
    async signIn(server, username, password) {
      trustEntered(server);
      await adopt(await signIn(server, username, password));
    },

    async signOut() {
      const { session } = get();
      // The logout goes out after the login is gone from here.
      trustEntered(session?.server);
      set({ session: null });
      await SecureStore.deleteItemAsync(KEY);
      if (session) await signOut(session);
    },

    async moveTo(server, serverId) {
      const { session } = get();
      if (!session || (session.server === server && (!serverId || session.serverId === serverId))) return;
      await adopt({ ...session, server, serverId: serverId ?? session.serverId });
    },

    async setAddress(which, input) {
      const { session } = get();
      if (!session) return;
      if (which === "away" && !input.trim()) {
        await adopt({ ...session, away: undefined, server: session.server === session.away ? session.home : session.server });
        return;
      }
      const address = normalizeServer(input, which === "away");
      trustEntered(address);
      const id = await serverIdAt(address, ASK_MS);
      if (!id) throw new Error("No Jellyfin server answers at that address");
      const same = session.serverId ? id === session.serverId : await acceptsLogin(address, session);
      if (!same) throw new Error("That address leads to another server");
      await adopt({ ...session, [which]: address, serverId: id, server: session.server === session[which] ? address : session.server });
    },
  };
});

/** A cover's or a song's address, wherever the server answers now. */
export function here(url: string): string {
  const session = useSession.getState().session;
  return session ? atAddress(url, session, session.server) : url;
}
