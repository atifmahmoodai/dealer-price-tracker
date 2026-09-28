import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHistory } from "../core/history";
import { historyToCsv } from "../core/csv";
import type { DealerInfo, History, OwnVehicle, Snapshot } from "../core/types";
import type { CompetitorConfig } from "../scraper/extract";

export const ROOT = process.cwd();
export const SNAP_DIR = join(ROOT, "data", "snapshots");
export const HISTORY_FILE = join(ROOT, "public", "data", "history.json");
export const EXPORT_DIR = join(ROOT, "data", "exports");

export function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1));
}

export function saveSnapshot(s: Snapshot) {
  writeJson(join(SNAP_DIR, s.date, `${s.dealerId}.json`), s);
}

export function loadSnapshots(): Snapshot[] {
  if (!existsSync(SNAP_DIR)) return [];
  const out: Snapshot[] = [];
  for (const day of readdirSync(SNAP_DIR).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (const f of readdirSync(join(SNAP_DIR, day))) {
      if (f.endsWith(".json")) out.push(JSON.parse(readFileSync(join(SNAP_DIR, day, f), "utf8")) as Snapshot);
    }
  }
  return out;
}

export function loadCompetitors(file = join(ROOT, "config", "competitors.json")): CompetitorConfig[] {
  if (!existsSync(file)) {
    throw new Error(`No ${file}. Copy config/competitors.example.json to config/competitors.json and edit it.`);
  }
  const list = JSON.parse(readFileSync(file, "utf8")) as CompetitorConfig[];
  const ids = new Set<string>();
  for (const c of list) {
    if (!c.id || !/^[a-z0-9-]+$/.test(c.id)) throw new Error(`Competitor id "${c.id}" must be lowercase letters, digits and dashes`);
    if (ids.has(c.id)) throw new Error(`Duplicate competitor id "${c.id}"`);
    ids.add(c.id);
    if (!Array.isArray(c.startUrls) || !c.startUrls.length) throw new Error(`${c.id}: startUrls is empty`);
    for (const u of c.startUrls) new URL(u); // throws on a bad URL
  }
  return list;
}

/** Reads a simple CSV with header StockNo,Year,Make,Model,Mileage,Price (quoted fields allowed). */
export function parseOwnStockCsv(text: string): OwnVehicle[] {
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
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
  if (missing.length) throw new Error(`my-inventory.csv is missing column(s): ${missing.join(", ")}`);
  return rows.slice(1).map((line, i) => {
    const c = split(line);
    const num = (n: string) => Number(c[idx(n)].replace(/[^\d.]/g, ""));
    const v = { stockNo: c[idx("stockno")], year: num("year"), make: c[idx("make")], model: c[idx("model")], mileage: num("mileage"), price: num("price") };
    if (!v.stockNo || !v.make || !v.model || !(v.year > 1900) || !(v.price > 0)) throw new Error(`my-inventory.csv row ${i + 2} is incomplete`);
    return v;
  });
}

export function loadOwnStock(file = join(ROOT, "config", "my-inventory.csv")): OwnVehicle[] {
  return existsSync(file) ? parseOwnStockCsv(readFileSync(file, "utf8")) : [];
}

export function writeReport(dealers: DealerInfo[], ownStock: OwnVehicle[]): History {
  // Only report on the competitors currently configured (e.g. ignore old demo snapshots).
  const ids = new Set(dealers.map((d) => d.id));
  const history = buildHistory(loadSnapshots().filter((s) => ids.has(s.dealerId)), dealers, ownStock);
  writeJson(HISTORY_FILE, history);
  mkdirSync(EXPORT_DIR, { recursive: true });
  for (const [name, csv] of Object.entries(historyToCsv(history))) writeFileSync(join(EXPORT_DIR, name), csv);
  return history;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
