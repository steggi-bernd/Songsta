/**
 * The app's own questions and short messages, in its own look. What Android brings
 * for these looks like another app. Its pickers, share sheet and permission
 * questions stay Android's: those really are the system asking.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { T } from "../shared";

export interface DialogButton {
  text: string;
  style?: "cancel" | "destructive";
  disabled?: boolean;
  onPress?: () => void;
}

export interface DialogRequest {
  title: string;
  message?: string;
  buttons: DialogButton[];
  /** a press beside it or Back says no */
  cancelable: boolean;
}

/** one button on a short word; it goes after that */
export interface ToastAction {
  label: string;
  run(): void;
}

interface PopupState {
  /** what's asked now, then what waits its turn */
  dialogs: DialogRequest[];
  message: { text: string; long: boolean; at: number; action?: ToastAction; ms?: number; endsAt?: number } | null;
  /** surfaces over the tab bar and the mini player that are showing (the player, Devices, lyrics, the queue): notes sit lower then */
  over: number;
  closeDialog(): void;
}

export const usePopups = create<PopupState>((set) => ({
  dialogs: [],
  message: null,
  over: 0,
  closeDialog: () => set((s) => ({ dialogs: s.dialogs.slice(1) })),
}));

/** A question, the way Android's Alert.alert takes one. The last button is the main one. */
export function showDialog(title: string, message?: string, buttons?: DialogButton[], options?: { cancelable?: boolean }): void {
  const asked = buttons?.length ? buttons : [{ text: T("OK") }];
  const dialog: DialogRequest = { title, message, buttons: asked, cancelable: options?.cancelable ?? (asked.length === 1 || asked.some((b) => b.style === "cancel")) };
  usePopups.setState((s) => ({ dialogs: [...s.dialogs, dialog] }));
}

/** A short word above the player, gone by itself. */
/** `endsAt`: a real deadline the note counts down to, with a bar (a device switching off). */
export function toast(text: string, long = false, action?: ToastAction, ms?: number, endsAt?: number): void {
  usePopups.setState({ message: { text, long, at: Date.now(), action, ms, endsAt } });
}

/** While a surface over the tab bar and the mini player shows, notes sit at the bottom of the screen. */
export function useOverBottomBar(active = true): void {
  useEffect(() => {
    if (!active) return;
    usePopups.setState((s) => ({ over: s.over + 1 }));
    return () => usePopups.setState((s) => ({ over: Math.max(0, s.over - 1) }));
  }, [active]);
}

/** That word is out of date before its time. */
export function dropToast(text: string): void {
  if (usePopups.getState().message?.text === text) usePopups.setState({ message: null });
}
