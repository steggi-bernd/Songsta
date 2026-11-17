/**
 * A jump inside Settings (views/SettingsView.tsx): to another category, and to a group there, shown
 * briefly marked. Used by Network & privacy's rows that lead elsewhere (the media analysis' card, the
 * sync service, Discord). Works however often it's used, also to the category open before.
 */
export interface SettingsJump {
  category: string;
  /** a group's header as shown (its translated name) */
  group?: string;
}

export const SETTINGS_JUMP = "songsta:settings-jump";

export function jumpInSettings(category: string, group?: string): void {
  window.dispatchEvent(new CustomEvent<SettingsJump>(SETTINGS_JUMP, { detail: { category, group } }));
}
