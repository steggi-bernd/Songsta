/** Where the app's own questions and short messages show (stores/popups.ts). Stands last in the app's root, over everything. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "../shared";
import { usePopups, type DialogButton } from "../stores/popups";
import { feel, useSettings } from "../stores/settings";
import { colors, MINI_PLAYER_HEIGHT, TAB_BAR_HEIGHT } from "../theme";

/** Words this long don't fit two buttons side by side. */
const LONGEST_SIDE_BY_SIDE = 15;
const TOAST_MS = 2200;
const TOAST_LONG_MS = 4200;

function ButtonRow({ buttons }: { buttons: DialogButton[] }) {
  const stacked = buttons.length > 2 || buttons.some((b) => b.text.length > LONGEST_SIDE_BY_SIDE);
  const main = buttons[buttons.length - 1];
  return (
    <View style={[styles.buttons, stacked && styles.buttonsStacked]}>
      {buttons.map((b) => {
        const isMain = b === main && b.style !== "cancel";
        const danger = isMain && b.style === "destructive";
        return (
          <Pressable
            key={b.text}
            disabled={b.disabled}
            accessibilityRole="button"
            onPress={() => {
              feel("tick");
              b.onPress?.();
            }}
            android_ripple={{ color: "rgba(255,255,255,0.14)", borderless: false }}
            style={[styles.button, !stacked && styles.buttonSide, isMain && styles.buttonMain, danger && styles.buttonDanger, b.disabled && styles.buttonOff]}
          >
            <Text numberOfLines={1} style={[styles.buttonText, isMain && styles.buttonTextMain, danger && styles.buttonTextDanger]}>
              {b.text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The card of a question: also for ones that ask for a name (PlaylistSheets.tsx). */
export function DialogCard({ title, message, buttons, children }: { title: string; message?: string; buttons: DialogButton[]; children?: ReactNode }) {
  const pop = useRef(new Animated.Value(useSettings.getState().reduceMotion ? 1 : 0.93, { useNativeDriver: true })).current;
  useEffect(() => {
    Animated.spring(pop, { toValue: 1, stiffness: 460, damping: 30, mass: 0.8, useNativeDriver: true }).start();
  }, [pop]);
  return (
    <Animated.View accessibilityViewIsModal style={[styles.card, { transform: [{ scale: pop }] }]}>
      <Text style={styles.title}>{title}</Text>
      {!!message && <Text style={styles.message}>{message}</Text>}
      {children}
      <ButtonRow buttons={buttons} />
    </Animated.View>
  );
}

export const dialogBack = { flex: 1, backgroundColor: "rgba(0,0,0,0.62)", justifyContent: "center", paddingHorizontal: 26 } as const;

function Dialogs() {
  const dialog = usePopups((s) => s.dialogs[0] ?? null);
  const closeDialog = usePopups((s) => s.closeDialog);
  const dismiss = (): void => {
    if (dialog?.cancelable) closeDialog();
  };
  return (
    <Modal visible={!!dialog} transparent animationType="fade" statusBarTranslucent onRequestClose={dismiss}>
      <View style={dialogBack}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityLabel={dialog?.cancelable ? T("Close") : undefined} />
        {!!dialog && (
          <DialogCard
            key={dialog.title}
            title={dialog.title}
            message={dialog.message}
            buttons={dialog.buttons.map((b) => ({
              ...b,
              onPress: () => {
                closeDialog();
                b.onPress?.();
              },
            }))}
          />
        )}
      </View>
    </Modal>
  );
}

function Toast() {
  const insets = useSafeAreaInsets();
  const message = usePopups((s) => s.message);
  const over = usePopups((s) => s.over > 0);
  const bar = useRef(new Animated.Value(1, { useNativeDriver: true })).current;
  const [counting, setCounting] = useState(false);
  const action = message?.action;
  const [shown, setShown] = useState<string | null>(null);
  const showing = useRef(new Animated.Value(0, { useNativeDriver: true })).current;
  const lift = showing.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });
  useEffect(() => {
    if (!message) {
      setShown(null);
      return;
    }
    setShown(message.text);
    Animated.timing(showing, { toValue: 1, duration: 170, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    // A real deadline: the bar runs out with it.
    const left = message.endsAt ? Math.max(0, message.endsAt - Date.now()) : 0;
    setCounting(left > 0);
    if (left > 0) {
      bar.setValue(1);
      Animated.timing(bar, { toValue: 0, duration: left, easing: Easing.linear, useNativeDriver: true }).start();
    }
    const timer = setTimeout(
      () => {
        Animated.timing(showing, { toValue: 0, duration: 200, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(({ finished }) => finished && setShown(null));
      },
      message.ms ?? (message.long ? TOAST_LONG_MS : TOAST_MS)
    );
    return () => clearTimeout(timer);
  }, [message, showing, bar]);
  if (!shown) return null;
  return (
    <View pointerEvents="box-none" style={[styles.toastPlace, { bottom: over ? insets.bottom + 22 : insets.bottom + TAB_BAR_HEIGHT + MINI_PLAYER_HEIGHT + 14 }]}>
      <Animated.View accessibilityLiveRegion="polite" pointerEvents={action ? "auto" : "none"} style={[styles.toast, action && styles.toastWithAction, { opacity: showing, transform: [{ translateY: lift }] }]}>
        <Text numberOfLines={3} style={[styles.toastText, action && styles.toastTextWithAction]}>
          {shown}
        </Text>
        {counting && <Animated.View pointerEvents="none" style={[styles.toastBar, { transform: [{ scaleX: bar }] }]} />}
        {!!action && (
          <Pressable
            onPress={() => {
              action.run();
              usePopups.setState({ message: null });
            }}
            hitSlop={10}
            accessibilityRole="button"
          >
            <Text style={styles.toastAction}>{action.label}</Text>
          </Pressable>
        )}
      </Animated.View>
    </View>
  );
}

export function PopupHost() {
  return (
    <>
      <Toast />
      <Dialogs />
    </>
  );
}

const styles = StyleSheet.create({
  card: { width: "100%", maxWidth: 380, alignSelf: "center", backgroundColor: "#262629", borderRadius: 22, paddingHorizontal: 22, paddingTop: 22, paddingBottom: 18, elevation: 24 },
  title: { color: colors.ink, fontSize: 19, fontWeight: "700", letterSpacing: -0.2 },
  message: { color: colors.soft, fontSize: 14.5, lineHeight: 21, marginTop: 9 },
  buttons: { flexDirection: "row", gap: 10, marginTop: 20 },
  buttonsStacked: { flexDirection: "column-reverse" },
  button: { height: 46, paddingHorizontal: 16, borderRadius: 23, backgroundColor: colors.button, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  buttonSide: { flex: 1 },
  buttonMain: { backgroundColor: colors.accent },
  buttonDanger: { backgroundColor: "#C24F4C" },
  buttonOff: { opacity: 0.4 },
  buttonText: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  buttonTextMain: { color: colors.onAccent },
  buttonTextDanger: { color: "#FFFFFF" },
  toastPlace: { position: "absolute", left: 18, right: 18, alignItems: "center" },
  toast: { backgroundColor: "#303034", borderRadius: 14, paddingHorizontal: 16, paddingVertical: 11, elevation: 12, overflow: "hidden" },
  toastBar: { position: "absolute", left: 0, right: 0, bottom: 0, height: 3, backgroundColor: colors.accent, transformOrigin: "left" },
  toastWithAction: { flexDirection: "row", alignItems: "center", gap: 14 },
  toastText: { color: colors.ink, fontSize: 14, fontWeight: "600", textAlign: "center" },
  toastTextWithAction: { flexShrink: 1, textAlign: "left" },
  toastAction: { color: colors.accent, fontSize: 14, fontWeight: "700" },
});
