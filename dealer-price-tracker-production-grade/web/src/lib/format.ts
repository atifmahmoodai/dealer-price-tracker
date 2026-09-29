import type { Settings } from "../../../shared/schemas";

// Money is shown in the currency set under Settings (prices are scraped as plain numbers).
let money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
let locale = "en-US";
export function applySettings(s: Pick<Settings, "currency" | "locale">) {
  try {
    money = new Intl.NumberFormat(s.locale, { style: "currency", currency: s.currency, maximumFractionDigits: 0 });
    locale = s.locale;
  } catch {
    // keep the previous format if the settings are somehow invalid
  }
}

export const fmtMoney = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : money.format(n));
export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString(locale));
export const fmtPct = (r: number | null | undefined, digits = 1) => (r === null || r === undefined || !Number.isFinite(r) ? "—" : `${r > 0 ? "+" : ""}${(r * 100).toFixed(digits)}%`);
/** A calendar date (YYYY-MM-DD) as "Sep 29". */
export function fmtDate(d: string) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
export function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
