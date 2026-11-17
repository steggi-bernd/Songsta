import { T, textLocale } from "./i18n";
/** Small formatting helpers shared across the UI. */

/** "12 KB", "3.4 MB", "1.2 GB", written the interface's way. */
export function fmtBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, bytes);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toLocaleString(textLocale(), { maximumFractionDigits: v < 10 && u > 0 ? 1 : 0 })} ${units[u]}`;
}

/** How long something will take, roughly: "less than a minute", "about 25 minutes", "about 2.5 hours". */
export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 60) return T("less than a minute");
  const minutes = Math.round(sec / 60);
  if (minutes < 90) return T("about {count} minutes", { count: minutes });
  const hours = Math.round((sec / 3600) * 2) / 2;
  return T("about {count} hours", { count: hours.toLocaleString(textLocale()) });
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** A stretch of time in whole minutes, as short as a column or a band needs it: "38 min", "2 h 5 min". */
export function fmtMinutes(sec: number): string {
  const minutes = Math.round(Math.max(0, sec) / 60);
  const h = Math.floor(minutes / 60);
  return h ? T("{h} h {m} min", { h, m: minutes % 60 }) : T("{count} min", { count: minutes });
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** Spotify's header length line: "1 hr 4 min" / "38 min 12 sec". */
export function fmtLength(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return T("{h} hr {m} min", { h, m });
  return T("{m} min {sec} sec", { m, sec: s % 60 });
}
