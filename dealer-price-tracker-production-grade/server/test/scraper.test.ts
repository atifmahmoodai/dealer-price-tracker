import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { addDays } from "../../shared/normalize";
import { createMarket } from "../src/demo/market";
import { renderSite } from "../src/demo/sites";
import { extractJsonLd, extractWithSelectors } from "../src/scraper/extract";
import type { CompetitorConfig } from "../src/scraper/extract";
import { parseRobots } from "../src/scraper/robots";
import { scrapeCompetitor } from "../src/scraper/scrape";

describe("robots.txt", () => {
  const txt = `User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\nCrawl-delay: 5\n\nUser-agent: DealerPriceTracker\nDisallow: /inventory/secret\n`;
  it("prefers the group that names our bot", () => {
    const p = parseRobots(txt, "DealerPriceTracker/1.0");
    expect(p.isAllowed("/private")).toBe(true);
    expect(p.isAllowed("/inventory/secret/1")).toBe(false);
  });
  it("uses longest match, wildcards and $ for the * group", () => {
    const p = parseRobots(txt, "OtherBot");
    expect(p.isAllowed("/private/x")).toBe(false);
    expect(p.isAllowed("/private/ok/1")).toBe(true);
    expect(p.isAllowed("/files/a.pdf")).toBe(false);
    expect(p.isAllowed("/files/a.pdf?x=1")).toBe(true);
    expect(p.crawlDelaySeconds).toBe(5);
  });
  it("treats an empty Disallow as allow-all", () => {
    expect(parseRobots("User-agent: *\nDisallow:\n", "x").isAllowed("/anything")).toBe(true);
  });
});

describe("extraction", () => {
  it("reads nested JSON-LD and survives a broken block", () => {
    const html = `<script type="application/ld+json">{oops</script>
      <script type="application/ld+json">[{"@type":"WebPage"},{"@graph":[{"@type":["Product","Car"],"name":"2022 Honda Civic Sport","brand":"Honda",
      "offers":[{"@type":"Offer","priceSpecification":{"price":"24,500"}}],"mileageFromOdometer":"18,000 mi","vehicleIdentificationNumber":"2HGFE2F59NH512345",
      "url":"/c/1?utm_medium=x"}]}]</script>`;
    const [l] = extractJsonLd(html, "https://d.com/inv", "d");
    expect(l).toMatchObject({ make: "Honda", model: "Civic", year: 2022, price: 24500, mileage: 18000, vin: "2HGFE2F59NH512345", url: "https://d.com/c/1", key: "vin:2HGFE2F59NH512345" });
  });
  it("reads HTML cards with selectors, including attributes", () => {
    const html = `<div class="card"><a href="/v/9"><b class="t">2018 Ford F-150 XLT</b></a><i class="p">$27,900</i><i class="s">Stock #: F9</i></div>
      <div class="card"><b class="t"></b></div>`;
    const out = extractWithSelectors(html, "https://d.com/", "d", { card: ".card", title: ".t", price: ".p", stockNo: ".s" });
    expect(out).toHaveLength(1); // card without a title is ignored
    expect(out[0]).toMatchObject({ year: 2018, make: "Ford", model: "F-150", price: 27900, stockNo: "F9", url: "https://d.com/v/9", key: "d:https://d.com/v/9" });
  });
});

describe("scrapeCompetitor against the demo sites", () => {
  it("captures every car, price and VIN exactly, across pages and formats", async () => {
    const market = createMarket(11, "2026-09-01");
    let fail: string | null = null;
    const server = createServer((req, res) => {
      const [id, ...rest] = (req.url ?? "/").split("/").filter(Boolean);
      const d = market.dealers.find((x) => x.id === id);
      if (req.url === "/robots.txt") return void res.end("User-agent: *\nDisallow: /metro-motors/admin\n");
      if (d && fail === d.id && req.url?.includes("page=2")) return void res.writeHead(500).end();
      const html = d ? renderSite(d, "/" + rest.join("/"), `http://${req.headers.host}/${id}`) : null;
      if (html === null) res.writeHead(404).end();
      else res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cfg = (id: string): CompetitorConfig =>
      id === "city-autos"
        ? { id, name: id, website: "", startUrls: [`${origin}/${id}/inventory`], mode: "selectors", nextPage: "a.pagination-next", delayMs: 0,
            selectors: { card: ".vehicle-card", title: ".vehicle-title", price: ".vehicle-price", link: "a.vehicle-link@href", mileage: ".odometer", vin: ".vin", stockNo: ".stock" } }
        : { id, name: id, website: "", startUrls: [`${origin}/${id}/inventory`], delayMs: 0 };
    const sleep = async () => {};
    try {
      for (let day = 0; day < 5; day++) {
        if (day) market.step(addDays("2026-09-01", day));
        for (const d of market.dealers) {
          const snap = await scrapeCompetitor(cfg(d.id), { date: "2026-09-01", sleep, retries: 0 });
          expect(snap.errors).toEqual([]);
          const got = new Map(snap.listings.map((l) => [l.vin, l]));
          expect(got.size).toBe(d.cars.length);
          for (const c of d.cars) {
            expect(got.get(c.vin)?.price).toBe(c.price);
            expect(got.get(c.vin)?.mileage).toBe(c.mileage);
          }
        }
      }
      fail = "metro-motors";
      const partial = await scrapeCompetitor(cfg("metro-motors"), { date: "2026-09-06", sleep, retries: 0 });
      expect(partial.errors[0]).toMatch(/HTTP 500/);
      expect(partial.listings.length).toBe(12); // first page kept
    } finally {
      server.close();
    }
  });
});
