// Runs the real scraper against three simulated dealer websites for 60 days,
// so the dashboard has realistic history without touching the internet.
//   npm run demo
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { addDays } from "../core/normalize";
import { createMarket } from "../demo/market";
import { renderSite } from "../demo/sites";
import type { CompetitorConfig } from "../scraper/extract";
import { scrapeCompetitor } from "../scraper/scrape";
import { ROOT, SNAP_DIR, saveSnapshot, writeJson, writeReport } from "./store";

const DAYS = 60;
const START = "2026-07-31";
const FAILED_DAY = 37; // one competitor's site is "down" this day, to show failure handling

const market = createMarket(7, START);
let failing: string | null = null;

const server = createServer((req, res) => {
  const [dealerId, ...rest] = (req.url ?? "/").split("/").filter(Boolean);
  const dealer = market.dealers.find((d) => d.id === dealerId);
  const base = `http://${req.headers.host}/${dealerId}`;
  if (dealer && failing === dealer.id) {
    res.writeHead(503).end("maintenance");
    return;
  }
  // robots.txt lives at the origin root in real life; here every dealer shares the demo origin.
  if (req.url === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /admin\n");
    return;
  }
  const html = dealer ? renderSite(dealer, "/" + rest.join("/"), base) : null;
  if (html === null) res.writeHead(404).end("not found");
  else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const origin = `http://127.0.0.1:${port}`;

const competitors: CompetitorConfig[] = market.dealers.map((d) => ({
  id: d.id,
  name: d.name,
  website: `https://${d.id}.example`,
  startUrls: [`${origin}/${d.id}/inventory`],
  delayMs: 0,
  ...(d.format === "html-cards"
    ? {
        mode: "selectors" as const,
        nextPage: "a.pagination-next",
        selectors: { card: ".vehicle-card", title: ".vehicle-title", price: ".vehicle-price", link: "a.vehicle-link@href", mileage: ".odometer", vin: ".vin", stockNo: ".stock" },
      }
    : {}),
}));

rmSync(SNAP_DIR, { recursive: true, force: true });
const noSleep = async () => {};
for (let day = 0; day < DAYS; day++) {
  const date = addDays(START, day);
  if (day > 0) market.step(date);
  failing = day === FAILED_DAY ? "city-autos" : null;
  for (const c of competitors) {
    const snap = await scrapeCompetitor(c, { date, sleep: noSleep, retries: 0 });
    // Point links at the dealer's (fictional) public domain instead of the temporary local server.
    const pub = (u: string) => u.replace(`${origin}/${c.id}`, c.website).replace(origin, c.website);
    snap.listings = snap.listings.map((l) => ({ ...l, url: pub(l.url), key: pub(l.key), imageUrl: l.imageUrl && pub(l.imageUrl) }));
    snap.errors = snap.errors.map(pub);
    saveSnapshot(snap);
  }
  if (day % 10 === 0) process.stdout.write(`day ${day + 1}/${DAYS}\n`);
}
server.close();

const own = market.ownStock(addDays(START, DAYS - 1));
writeFileSync(join(ROOT, "config", "my-inventory.demo.csv"), ["StockNo,Year,Make,Model,Mileage,Price", ...own.map((o) => [o.stockNo, o.year, o.make, o.model, o.mileage, o.price].join(","))].join("\n") + "\n");
writeJson(join(ROOT, "config", "competitors.demo.json"), competitors.map((c) => ({ ...c, startUrls: [`${c.website}/inventory`] })));
const h = writeReport(competitors.map(({ id, name, website }) => ({ id, name, website })), own);
console.log(`\nDemo done: ${h.listings.length} listings, ${h.events.length} events over ${h.dates.length} days.`);
for (const w of h.warnings) console.log(`warning (expected): ${w}`);
