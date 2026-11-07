/**
 * The first start: what the app is, where the music comes from (a folder on the phone and a
 * server count the same), and what's worth asking Android for right away. A page that has
 * nothing to ask doesn't show. After that this is only about music again: signed out and
 * without a folder, the app comes back to the middle page.
 */
import { Bell, Check, ChevronLeft, Download, FolderOpen, Server, type LucideIcon } from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, BackHandler, Image, KeyboardAvoidingView, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Player from "../../modules/media3-player";
import { useLocalMusic } from "../stores/localMusic";
import { useSession } from "../stores/session";
import { useSettings } from "../stores/settings";
import { colors } from "../theme";
import { T } from "../shared";

type Step = "welcome" | "music" | "notifications" | "updates";

const NOTIFICATIONS = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
/** Android asks for this one by itself only from version 13 on. */
const notificationsAsked = Platform.OS === "android" && Number(Platform.Version) >= 33;

function Field({ label, value, onChange, placeholder, secure, url }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; secure?: boolean; url?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.dim}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={url ? "url" : "default"}
        style={styles.input}
      />
    </View>
  );
}

/** One way to the music. Both are the same size until one is opened. */
function Source({ Icon, title, line, done, onPress, children }: { Icon: LucideIcon; title: string; line: string; done: boolean; onPress: () => void; children?: ReactNode }) {
  return (
    <View style={[styles.source, done && styles.sourceDone]}>
      <Pressable onPress={onPress} accessibilityLabel={`${title}. ${line}`} style={styles.sourceHead}>
        <View style={[styles.sourceIcon, done && styles.sourceIconDone]}>{done ? <Check size={22} color={colors.onAccent} strokeWidth={3} /> : <Icon size={22} color={colors.ink} />}</View>
        <View style={styles.sourceText}>
          <Text style={styles.sourceTitle}>{title}</Text>
          <Text style={styles.sourceLine}>{line}</Text>
        </View>
      </Pressable>
      {children}
    </View>
  );
}

function ServerForm() {
  const signIn = useSession((s) => s.signIn);
  const [server, setServer] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await signIn(server, user, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : T("That did not work"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.form}>
      <Field label={T("Server address")} value={server} onChange={setServer} placeholder="http://your-server:8096" url />
      <Field label={T("User name")} value={user} onChange={setUser} placeholder={T("Your server login")} />
      <Field label={T("Password")} value={password} onChange={setPassword} placeholder={T("Only used to sign in")} secure />
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={() => void connect()} disabled={busy} style={[styles.formButton, busy && styles.off]}>
        {busy ? <ActivityIndicator color={colors.ink} /> : <Text style={styles.formButtonText}>{T("Connect")}</Text>}
      </Pressable>
    </View>
  );
}

function MusicPage({ onNext, label }: { onNext: () => void; label: string }) {
  const signedIn = useSession((s) => !!s.session);
  const folders = useLocalMusic((s) => s.folders.length);
  const scanning = useLocalMusic((s) => s.scanning);
  const songs = useLocalMusic((s) => s.files.length);
  const [openServer, setOpenServer] = useState(false);
  const pick = (): void => {
    void useLocalMusic.getState().addFolder();
  };
  const folderLine = folders
    ? scanning
      ? T("Reading your music…")
      : T("{count} songs found. Press to add another folder.", { count: songs })
    : T("Choose a folder with your music. No server, no account.");
  return (
    <>
      <Text style={styles.title}>{T("Where's your music?")}</Text>
      <Text style={styles.body}>{T("Either is fine, or both. You can add the other one later in Settings.")}</Text>
      <Source Icon={FolderOpen} title={T("On this phone")} line={folderLine} done={folders > 0} onPress={pick} />
      <Source
        Icon={Server}
        title={T("On your own server")}
        line={signedIn ? T("Connected") : T("Jellyfin, at home and on the road.")}
        done={signedIn}
        onPress={() => !signedIn && setOpenServer(!openServer)}
      >
        {openServer && !signedIn && <ServerForm />}
      </Source>
      <View style={styles.spacer} />
      <Pressable onPress={onNext} disabled={!folders && !signedIn} style={[styles.button, !folders && !signedIn && styles.off]}>
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>
    </>
  );
}

function AskPage({ Icon, title, body, allow, onAllow, onSkip }: { Icon: LucideIcon; title: string; body: string; allow: string; onAllow: () => void; onSkip: () => void }) {
  return (
    <>
      <View style={styles.askIcon}>
        <Icon size={30} color={colors.ink} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      <View style={styles.spacer} />
      <Pressable onPress={onAllow} style={styles.button}>
        <Text style={styles.buttonText}>{allow}</Text>
      </Pressable>
      <Pressable onPress={onSkip} style={styles.other}>
        <Text style={styles.otherText}>{T("Not now")}</Text>
      </Pressable>
    </>
  );
}

export function SetupScreen() {
  const insets = useSafeAreaInsets();
  const setupDone = useSettings((s) => s.setupDone);
  const [step, setStep] = useState<Step>(setupDone ? "music" : "welcome");
  const [pages, setPages] = useState<Step[]>(setupDone ? ["music"] : ["welcome", "music"]);
  const waitingForSetting = useRef(false);

  const finish = (): void => {
    const { folders, setWithoutServer } = useLocalMusic.getState();
    if (folders.length && !useSession.getState().session) setWithoutServer(true);
    useSettings.getState().change({ setupDone: true });
  };

  /** What's still worth asking for, in order; nothing left means the app opens. */
  const go = async (after: Step): Promise<void> => {
    if (setupDone) {
      finish();
      return;
    }
    const order: Step[] = ["notifications", "updates"];
    for (const next of order.slice(order.indexOf(after as never) + 1)) {
      const needed = next === "notifications" ? notificationsAsked && !(await PermissionsAndroid.check(NOTIFICATIONS).catch(() => true)) : !(await Player.appUpdateAllowed().catch(() => true));
      if (needed) {
        setPages((p) => (p.includes(next) ? p : [...p, next]));
        setStep(next);
        return;
      }
    }
    finish();
  };

  // Android's setting is another page: back from there it's clear what was chosen.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !waitingForSetting.current) return;
      waitingForSetting.current = false;
      void Player.appUpdateAllowed().then((allowed) => {
        if (allowed) finish();
      });
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const at = pages.indexOf(step);
      if (at <= 0) return false;
      setStep(pages[at - 1]);
      return true;
    });
    return () => sub.remove();
  }, [pages, step]);

  const at = pages.indexOf(step);
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.root}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.top}>
          {at > 0 ? (
            <Pressable onPress={() => setStep(pages[at - 1])} accessibilityLabel={T("Back")} hitSlop={10} style={styles.back}>
              <ChevronLeft size={26} color={colors.ink} />
            </Pressable>
          ) : (
            <View style={styles.back} />
          )}
        </View>
        {step === "welcome" && (
          <>
            <View style={styles.welcome}>
              <Image source={require("../../assets/icon.png")} style={styles.logo} accessibilityIgnoresInvertColors />
              <Text style={styles.brand}>Songsta</Text>
              <Text style={styles.tagline}>{T("Your music, wherever you keep it. No account and no ads.")}</Text>
            </View>
            <Pressable onPress={() => setStep("music")} style={styles.button}>
              <Text style={styles.buttonText}>{T("Get started")}</Text>
            </Pressable>
          </>
        )}
        {step === "music" && <MusicPage onNext={() => void go("music")} label={setupDone ? T("Done") : T("Continue")} />}
        {step === "notifications" && (
          <AskPage
            Icon={Bell}
            title={T("Notifications")}
            body={T("So you can see and steer what plays on your devices, and how downloads are going. Nothing else comes this way.")}
            allow={T("Allow")}
            onAllow={() => void PermissionsAndroid.request(NOTIFICATIONS).finally(() => void go("notifications"))}
            onSkip={() => void go("notifications")}
          />
        )}
        {step === "updates" && (
          <AskPage
            Icon={Download}
            title={T("Updates from inside the app")}
            body={T("New versions come straight from Songsta's releases. For that, Android wants your OK once: on the next page, switch on \"Allow from this source\" and come back.")}
            allow={T("Open Android's setting")}
            onAllow={() => {
              waitingForSetting.current = true;
              void Player.appUpdateAskToAllow();
            }}
            onSkip={finish}
          />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  page: { flexGrow: 1, paddingHorizontal: 22 },
  top: { height: 40, justifyContent: "center" },
  back: { width: 40, height: 40, justifyContent: "center", marginLeft: -6 },
  welcome: { flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: 24 },
  logo: { width: 112, height: 112, borderRadius: 26 },
  brand: { color: colors.ink, fontSize: 38, fontWeight: "800", letterSpacing: -1.2, marginTop: 22 },
  tagline: { color: colors.soft, fontSize: 16, lineHeight: 23, marginTop: 10, textAlign: "center", paddingHorizontal: 18 },
  title: { color: colors.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.8, marginTop: 6 },
  body: { color: colors.soft, fontSize: 15, lineHeight: 22, marginTop: 10, marginBottom: 12 },
  source: { backgroundColor: colors.panel, borderRadius: 18, marginTop: 12, overflow: "hidden", borderWidth: 1, borderColor: "transparent" },
  sourceDone: { borderColor: colors.accent },
  sourceHead: { flexDirection: "row", alignItems: "center", gap: 14, padding: 18, minHeight: 104 },
  sourceIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.chip, alignItems: "center", justifyContent: "center" },
  sourceIconDone: { backgroundColor: colors.accent },
  sourceText: { flex: 1 },
  sourceTitle: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  sourceLine: { color: colors.dim, fontSize: 13.5, lineHeight: 19, marginTop: 3 },
  form: { paddingHorizontal: 18, paddingBottom: 18 },
  field: { marginTop: 12 },
  label: { color: colors.ink, fontSize: 13, fontWeight: "600", marginBottom: 7 },
  input: { height: 48, paddingHorizontal: 14, borderRadius: 10, backgroundColor: colors.chip, color: colors.ink, fontSize: 15 },
  error: { color: "#FF9D9D", fontSize: 13.5, lineHeight: 19, marginTop: 12 },
  formButton: { height: 46, borderRadius: 23, backgroundColor: colors.chip, alignItems: "center", justifyContent: "center", marginTop: 16 },
  formButtonText: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  spacer: { flex: 1, minHeight: 24 },
  askIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.panel, alignItems: "center", justifyContent: "center", marginTop: 26, marginBottom: 12 },
  button: { height: 52, borderRadius: 26, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.base, fontSize: 16, fontWeight: "700" },
  off: { opacity: 0.4 },
  other: { height: 46, alignItems: "center", justifyContent: "center", marginTop: 8 },
  otherText: { color: colors.soft, fontSize: 14.5 },
});
