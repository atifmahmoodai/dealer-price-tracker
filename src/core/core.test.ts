import { describe, expect, it } from "vitest";
import { csvCell } from "./csv";
import { buildHistory, compareToMarket } from "./history";
import { canonicalUrl, parseMileage, parsePrice, parseTitle, parseVin } from "./normalize";
import type { Listing, Snapshot } from "./types";

describe("normalize", () => {
  it("parses prices in common formats", () => {
    expect(parsePrice("$23,995")).toBe(23995);
    expect(parsePrice("PKR 4,250,000")).toBe(4250000);
    expect(parsePrice("AED 89,500.00")).toBe(89500);
    expect(parsePrice("£12.5k")).toBe(12500);
    expect(parsePrice("Rs 1.250.000")).toBe(1250000);
    expect(parsePrice("Call for price")).toBeUndefined();
    expect(parsePrice(0)).toBeUndefined();
    expect(parsePrice(18999.5)).toBe(19000);
  });
  it("parses mileage, VINs and titles", () => {
    expect(parseMileage("45,210 mi")).toBe(45210);
    expect(parseMileage("72k km")).toBe(72000);
    expect(parseMileage("New")).toBeUndefined();
    expect(parseVin("VIN: 1hgcm82633a004352 ")).toBe("1HGCM82633A004352");
    expect(parseVin("VIN: 1HGCM8263IA004352")).toBeUndefined(); // I is never valid
    expect(parseTitle("2021 Toyota Corolla LE Hybrid")).toEqual({ year: 2021, make: "Toyota", model: "Corolla", trim: "LE Hybrid" });
    expect(parseTitle("2019 Land Rover Defender 110")).toMatchObject({ make: "Land Rover", model: "Defender" });
    expect(parseTitle("2020 VW Golf GTI")).toMatchObject({ make: "Volkswagen", model: "Golf" });
    expect(parseTitle("Great deal!")).toEqual({ year: undefined });
  });
  it("strips tracking parameters from URLs", () => {
    expect(canonicalUrl("/car/1?utm_source=x&id=5#top", "https://d.com/inv")).toBe("https://d.com/car/1?id=5");
  });
  it("neutralises formulas in CSV", () => {
    expect(csvCell("=cmd()")).toBe("'=cmd()");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});

const car = (key: string, price?: number, extra: Partial<Listing> = {}): Listing => ({
  key, dealerId: "d1", url: `https://d/${key}`, title: `2020 Toyota Corolla ${key}`, year: 2020, make: "Toyota", model: "Corolla", price, ...extra,
});
const snap = (date: string, listings: Listing[], errors: string[] = []): Snapshot => ({ dealerId: "d1", date, scrapedAt: date, pages: 1, listings, errors });
const DEALERS = [{ id: "d1", name: "D1", website: "https://d" }];

describe("buildHistory", () => {
  const base = Array.from({ length: 8 }, (_, i) => car(`c${i}`, 10000 + i * 1000));

  it("detects new, price changes, removals and relists", () => {
    const h = buildHistory(
      [
        snap("2026-09-01", base),
        snap("2026-09-02", [...base.slice(1), car("new1", 15000)]), // c0 gone, new1 added
        snap("2026-09-03", [...base.slice(1).map((c) => (c.key === "c2" ? { ...c, price: 11500 } : c)), car("new1", 15000)]),
        snap("2026-09-05", [...base, car("new1", 15000)]), // c0 back
      ],
      DEALERS,
    );
    const types = h.events.map((e) => `${e.date} ${e.type} ${e.key}`).sort();
    expect(types).toEqual([
      "2026-09-02 new new1",
      "2026-09-02 removed c0",
      "2026-09-03 price_change c2",
      "2026-09-05 price_change c2", // back to 12000 in the base list
      "2026-09-05 relisted c0",
    ]);
    const c2 = h.listings.find((l) => l.key === "c2")!;
    expect(c2.firstPrice).toBe(12000);
    expect(c2.priceChanges).toBe(2);
    expect(c2.daysOnSite).toBe(4);
    expect(h.events.find((e) => e.type === "price_change" && e.date === "2026-09-03")?.delta).toBe(-500);
  });

  it("does not count cars from the first scrape as new", () => {
    const h = buildHistory([snap("2026-09-01", base)], DEALERS);
    expect(h.events).toHaveLength(0);
    expect(h.listings.every((l) => l.status === "active")).toBe(true);
  });

  it("skips failed scrapes instead of reporting a sell-out", () => {
    const h = buildHistory([snap("2026-09-01", base), snap("2026-09-02", [], ["HTTP 503"]), snap("2026-09-03", base.slice(0, 2)), snap("2026-09-04", base)], DEALERS);
    expect(h.events.filter((e) => e.type === "removed")).toHaveLength(0);
    expect(h.warnings).toHaveLength(2);
    expect(h.dates).toEqual(["2026-09-01", "2026-09-04"]);
  });

  it("does not infer removals from a partial scrape", () => {
    const h = buildHistory([snap("2026-09-01", base), snap("2026-09-02", base.slice(0, 5), ["page 2: HTTP 500"]), snap("2026-09-03", base.slice(1))], DEALERS);
    expect(h.events.filter((e) => e.type === "removed").map((e) => `${e.date} ${e.key}`)).toEqual(["2026-09-03 c0"]);
  });

  it("compares own stock to active comparable listings", () => {
    const h = buildHistory([snap("2026-09-01", [car("a", 10000, { mileage: 30000 }), car("b", 12000, { mileage: 40000 }), car("c", 30000, { mileage: 200000 }), car("d", 9000, { model: "Camry" })])], DEALERS);
    const cmp = compareToMarket({ stockNo: "X", year: 2021, make: "toyota", model: "COROLLA", mileage: 35000, price: 12100 }, h.listings);
    expect(cmp.comps.map((c) => c.key).sort()).toEqual(["a", "b"]);
    expect(cmp.marketMedian).toBe(11000);
    expect(cmp.position).toBeCloseTo(0.1);
  });
});
