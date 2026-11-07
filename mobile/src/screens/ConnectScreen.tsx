/** A server on top of the music on this phone, asked for in Settings. The first start has its own pages (SetupScreen). */
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalMusic } from "../stores/localMusic";
import { useSession } from "../stores/session";
import { colors } from "../theme";
import { T } from "../shared";

function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  keyboard,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  secure?: boolean;
  keyboard?: "url" | "default";
}) {
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
        keyboardType={keyboard ?? "default"}
        style={styles.input}
      />
    </View>
  );
}

export function ConnectScreen() {
  const insets = useSafeAreaInsets();
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
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.root}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.page, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}
      >
        <Text style={styles.title}>{T("Connect your music")}</Text>
        <Text style={styles.subtitle}>{T("Your Jellyfin server. The music stays where it is.")}</Text>
        <Field label={T("Server address")} value={server} onChange={setServer} placeholder="http://your-server:8096" keyboard="url" />
        <Field label={T("User name")} value={user} onChange={setUser} placeholder={T("Your server login")} />
        <Field label={T("Password")} value={password} onChange={setPassword} placeholder={T("Only used to sign in")} secure />
        {!!error && <Text style={styles.error}>{error}</Text>}
        <View style={styles.spacer} />
        <Pressable onPress={() => void connect()} disabled={busy} style={[styles.button, busy && { opacity: 0.6 }]}>
          {busy ? <ActivityIndicator color={colors.base} /> : <Text style={styles.buttonText}>{T("Continue")}</Text>}
        </Pressable>
        <Pressable onPress={() => useLocalMusic.getState().setAddingServer(false)} style={styles.other}>
          <Text style={styles.otherText}>{T("Back")}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  page: { flexGrow: 1, paddingHorizontal: 20 },
  title: { color: colors.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.8 },
  subtitle: { color: colors.soft, fontSize: 15, lineHeight: 21, marginTop: 10, marginBottom: 12 },
  field: { marginTop: 14 },
  label: { color: colors.ink, fontSize: 13, fontWeight: "600", marginBottom: 7 },
  input: {
    height: 48,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 8,
    backgroundColor: colors.panel,
    color: colors.ink,
    fontSize: 15,
  },
  error: { color: "#FF9D9D", fontSize: 13.5, lineHeight: 19, marginTop: 14 },
  spacer: { flex: 1, minHeight: 24 },
  button: { height: 50, borderRadius: 25, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.base, fontSize: 15.5, fontWeight: "700" },
  other: { height: 46, alignItems: "center", justifyContent: "center", marginTop: 8 },
  otherText: { color: colors.soft, fontSize: 14.5 },
});
