/** The small sheets around playlists: which one a song goes to, and what a new one is called. */
import { Check, Plus } from "lucide-react-native";
import { useEffect, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { plural } from "../shared";
import { entryOf, playlistTracks, usePlaylists } from "../stores/playlists";
import { colors } from "../theme";
import { dialogBack, DialogCard } from "./PopupHost";
import { SheetFrame, SheetHead } from "./Sheet";
import { CoverGrid } from "./ui";
import { T } from "../shared";

/** Asks for a name: a new playlist's, a playlist's new one, or anything of that size. */
export function NameDialog({
  visible,
  title,
  placeholder,
  initial = "",
  action,
  allowEmpty,
  address,
  message,
  onDone,
  onCancel,
}: {
  visible: boolean;
  title: string;
  /** a line under the title */
  message?: string;
  placeholder: string;
  initial?: string;
  action: string;
  allowEmpty?: boolean;
  /** a web address, not a name */
  address?: boolean;
  onDone: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (visible) setValue(initial);
  }, [visible, initial]);
  const ready = allowEmpty || !!value.trim();
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior="padding" style={dialogBack}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel={T("Cancel")} />
        {visible && (
          <DialogCard
            title={title}
            message={message}
            buttons={[
              { text: T("Cancel"), style: "cancel", onPress: onCancel },
              { text: action, disabled: !ready, onPress: () => onDone(value.trim()) },
            ]}
          >
            <TextInput
              autoFocus
              selectTextOnFocus
              value={value}
              onChangeText={setValue}
              placeholder={placeholder}
              placeholderTextColor={colors.dim}
              selectionColor={`${colors.accent}66`}
              cursorColor={colors.accent}
              autoCorrect={false}
              autoCapitalize={address ? "none" : "sentences"}
              keyboardType={address ? "url" : "default"}
              onSubmitEditing={() => ready && onDone(value.trim())}
              style={styles.input}
            />
          </DialogCard>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Opened with a song set as `picking`: anywhere a song can be held down. */
export function AddToPlaylistSheet() {
  const picking = usePlaylists((s) => s.picking);
  const playlists = usePlaylists((s) => s.playlists);
  const { setPicking, addTrack, removeTrack, create } = usePlaylists.getState();
  const [naming, setNaming] = useState(false);
  const close = (): void => setPicking(null);

  return (
    <>
      <SheetFrame visible={!!picking && !naming} onClose={close}>
            <SheetHead title={T("Add to playlist")} subtitle={picking?.title} />
            <Pressable style={styles.row} android_ripple={{ color: "rgba(255,255,255,0.08)" }} onPress={() => setNaming(true)}>
              <View style={styles.newMark}>
                <Plus size={24} color={colors.ink} />
              </View>
              <Text style={styles.rowTitle}>{T("New playlist")}</Text>
            </Pressable>
            <FlatList
              data={playlists}
              keyExtractor={(p) => p.id}
              style={styles.list}
              renderItem={({ item }) => {
                const entry = picking ? entryOf(item, picking) : undefined;
                return (
                  <Pressable
                    style={styles.row}
                    android_ripple={{ color: "rgba(255,255,255,0.08)" }}
                    onPress={() => {
                      if (!picking) return;
                      if (entry) removeTrack(item.id, entry.id);
                      else addTrack(item.id, picking);
                      close();
                    }}
                  >
                    <CoverGrid tracks={playlistTracks(item)} size={48} cover={item.cover} />
                    <View style={styles.rowText}>
                      <Text numberOfLines={1} style={styles.rowTitle}>
                        {item.name}
                      </Text>
                      <Text style={styles.rowSub}>{plural(item.tracks.length, T("song"), T("songs"))}</Text>
                    </View>
                    {!!entry && <Check size={22} color={colors.accent} />}
                  </Pressable>
                );
              }}
            />
      </SheetFrame>
      <NameDialog
        visible={!!picking && naming}
        title={T("New playlist")}
        placeholder={T("Name")}
        action={T("Create")}
        onCancel={() => setNaming(false)}
        onDone={(name) => {
          if (picking) addTrack(create(name), picking);
          setNaming(false);
          close();
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 0, flexShrink: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, height: 62, paddingHorizontal: 18 },
  newMark: { width: 48, height: 48, borderRadius: 4, backgroundColor: colors.button, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "500" },
  rowSub: { color: colors.dim, fontSize: 13, marginTop: 2 },
  input: { height: 48, marginTop: 14, paddingHorizontal: 14, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.09)", color: colors.ink, fontSize: 15.5 },
});
