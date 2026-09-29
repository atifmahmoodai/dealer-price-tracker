import type { OwnVehicle } from "./types";
import { toCsv } from "./csv";

/** Reads a simple CSV with header StockNo,Year,Make,Model,Mileage,Price (quoted fields allowed). */
export function parseOwnStockCsv(text: string): OwnVehicle[] {
  // Excel adds a byte-order mark to UTF-8 CSVs; it would hide the first column name.
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!rows.length) return [];
  const split = (line: string) => {
    const cells: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const header = split(rows[0]).map((h) => h.toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const need = ["stockno", "year", "make", "model", "mileage", "price"];
  const missing = need.filter((n) => idx(n) < 0);
  if (missing.length) throw new Error(`The file is missing column(s): ${missing.join(", ")}. Expected: StockNo,Year,Make,Model,Mileage,Price`);
  const seen = new Set<string>();
  return rows.slice(1).map((line, i) => {
    const c = split(line);
    const cell = (n: string) => c[idx(n)] ?? "";
    const num = (n: string) => Number(cell(n).replace(/[^\d.]/g, ""));
    const v = { stockNo: cell("stockno"), year: num("year"), make: cell("make"), model: cell("model"), mileage: num("mileage"), price: num("price") };
    if (!v.stockNo || !v.make || !v.model || !(v.year > 1900) || !(v.price > 0)) throw new Error(`Row ${i + 2} is incomplete (needs stock number, make, model, a year after 1900 and a price above 0)`);
    if (seen.has(v.stockNo.toLowerCase())) throw new Error(`Row ${i + 2}: stock number ${v.stockNo} appears twice`);
    seen.add(v.stockNo.toLowerCase());
    return v;
  });
}

export function ownStockToCsv(rows: OwnVehicle[]): string {
  return toCsv(["StockNo", "Year", "Make", "Model", "Mileage", "Price"], rows.map((r) => [r.stockNo, r.year, r.make, r.model, r.mileage, r.price]));
}
