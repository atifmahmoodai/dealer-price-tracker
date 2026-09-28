const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const fmtMoney = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : money.format(n));
export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US"));
export const fmtPct = (r: number | null | undefined, digits = 1) => (r === null || r === undefined || !Number.isFinite(r) ? "—" : `${r > 0 ? "+" : ""}${(r * 100).toFixed(digits)}%`);
export function fmtDate(d: string) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
