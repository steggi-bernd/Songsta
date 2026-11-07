import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { AddToPlaylistSheet } from "./src/components/PlaylistSheets";
import { PopupHost } from "./src/components/PopupHost";
import { SongMenu } from "./src/components/SongMenu";
import { CoverKeeper } from "./src/components/ui";
import { AppNavigation } from "./src/navigation";
import { watchNewVersion } from "./src/newVersion";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { SetupScreen } from "./src/screens/SetupScreen";
import { watchConnection } from "./src/stores/connection";
import { useDownloads } from "./src/stores/downloads";
import { useLibrary } from "./src/stores/library";
import { useLocalMusic } from "./src/stores/localMusic";
import { usePlayer, watchPlayer } from "./src/stores/player";
import { watchZones } from "./src/stores/zones";
import { usePlaylists } from "./src/stores/playlists";
import { watchKeptLists } from "./src/stores/keptLists";
import { useSession } from "./src/stores/session";
import { useSettings } from "./src/stores/settings";
import { startSync, stopSync } from "./src/sync";
import { colors } from "./src/theme";

watchPlayer();
watchZones();
watchConnection();
watchNewVersion();
watchKeptLists();

/** Keeps the clock and icons readable while a page scrolls under them. */
function StatusScrim() {
  const insets = useSafeAreaInsets();
  return (
    <LinearGradient
      pointerEvents="none"
      colors={["rgba(0,0,0,0.72)", "rgba(0,0,0,0)"]}
      style={[styles.scrim, { height: insets.top + 14 }]}
    />
  );
}

export default function App() {
  const ready = useSession((s) => s.ready);
  // Who, not where: the address can move while the same person listens on.
  const signedIn = useSession((s) => s.session?.token ?? null);
  const localReady = useLocalMusic((s) => s.restored);
  const noServer = useLocalMusic((s) => s.withoutServer && !s.addingServer);
  // In the app with a server, or with just the music on this phone. A new login is somebody else's library.
  const inside = signedIn ?? (noServer ? "this phone" : null);
  const adding = useLocalMusic((s) => s.addingServer);
  const setupDone = useSettings((s) => s.setupDone);
  // Music from before these pages existed: nothing to set up. Checked once, at the start, so the pages don't vanish halfway through.
  const checked = useRef(false);
  if (ready && localReady && !checked.current) {
    checked.current = true;
    if (inside && !setupDone) useSettings.getState().change({ setupDone: true });
  }
  const loaded = useLibrary((s) => s.loaded);
  const queueRestored = useRef(false);

  useEffect(() => {
    void useSession.getState().restore();
    void useLocalMusic.getState().restore();
  }, []);

  // Everything the phone remembers comes first; the server tells what's new when it can.
  useEffect(() => {
    if (inside) {
      void useLibrary.getState().restore();
      void usePlaylists.getState().restore();
      void useDownloads.getState().restore();
    }
    if (signedIn) useLocalMusic.getState().setAddingServer(false);
    queueRestored.current = false;
  }, [inside, signedIn]);

  // Where playback stopped comes back once the library can say what the songs are.
  useEffect(() => {
    if (!inside || !loaded || queueRestored.current) return;
    queueRestored.current = true;
    // The sync comes after: it decides from what the phone remembers whether another device is newer.
    void usePlayer.getState().restore().then(startSync);
  }, [inside, loaded]);

  useEffect(() => {
    if (!signedIn) stopSync();
  }, [signedIn]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.root}>
        {ready && localReady && (!inside && adding ? <ConnectScreen /> : inside && setupDone ? <AppNavigation /> : <SetupScreen />)}
        <AddToPlaylistSheet />
        <SongMenu />
        {!!inside && <CoverKeeper />}
        <StatusScrim />
        <PopupHost />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  scrim: { position: "absolute", left: 0, right: 0, top: 0 },
});
