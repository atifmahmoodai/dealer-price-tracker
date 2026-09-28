import type { History } from "./types";

type Cell = string | number | boolean | null | undefined;

/** CSV cell with quoting and protection against spreadsheet formula injection. */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "1" : "0";
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Cell[][]): string {
  return [columns.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
}

/** Flat tables for Excel / Power BI. */
export function historyToCsv(h: History): Record<string, string> {
  const dealerName = new Map(h.dealers.map((d) => [d.id, d.name]));
  return {
    "listings.csv": toCsv(
      ["DealerID", "Dealer", "Key", "Title", "Year", "Make", "Model", "Trim", "Mileage", "VIN", "StockNo", "Condition", "Fuel", "Body", "Transmission",
        "FirstPrice", "CurrentPrice", "PriceChanges", "Status", "FirstSeen", "LastSeen", "RemovedOn", "DaysOnSite", "URL"],
      h.listings.map((l) => [l.dealerId, dealerName.get(l.dealerId), l.key, l.title, l.year, l.make, l.model, l.trim, l.mileage, l.vin, l.stockNo,
        l.condition, l.fuel, l.bodyType, l.transmission, l.firstPrice, l.price, l.priceChanges, l.status, l.firstSeen, l.lastSeen, l.removedOn,
        l.daysOnSite, l.url]),
    ),
    "events.csv": toCsv(
      ["Date", "DealerID", "Dealer", "Key", "Type", "Title", "OldPrice", "NewPrice", "Delta"],
      h.events.map((e) => [e.date, e.dealerId, dealerName.get(e.dealerId), e.key, e.type, e.title, e.oldPrice, e.newPrice, e.delta]),
    ),
    "daily.csv": toCsv(
      ["Date", "DealerID", "Dealer", "Active", "Added", "Removed", "PriceChanges", "MedianPrice"],
      h.daily.map((d) => [d.date, d.dealerId, dealerName.get(d.dealerId), d.active, d.added, d.removed, d.priceChanges, d.medianPrice]),
    ),
  };
}
