/** Typed access to the preload bridge, with a friendly error in plain-browser dev. */
import type { ByTuneApi } from "../../electron/preload";

declare global {
  interface Window {
    bytune?: ByTuneApi;
  }
}

export function requireBridge(): ByTuneApi {
  if (typeof window === "undefined" || !window.bytune) {
    throw new Error("Not running inside the Songsta desktop shell.");
  }
  return window.bytune;
}
