// npm run scrape            → scrape every competitor in config/competitors.json for today, then rebuild the report
// npm run scrape -- --only city-autos
import { scrapeCompetitor } from "../scraper/scrape";
import { loadCompetitors, loadOwnStock, saveSnapshot, todayUtc, writeReport } from "./store";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const competitors = loadCompetitors();
const date = todayUtc();
let failed = 0;

for (const c of competitors.filter((x) => !only || x.id === only)) {
  console.log(`${c.name} (${c.id})`);
  const snap = await scrapeCompetitor(c, { date, log: console.log });
  saveSnapshot(snap);
  console.log(`  → ${snap.listings.length} vehicles on ${snap.pages} page(s)${snap.errors.length ? `, ${snap.errors.length} error(s)` : ""}`);
  if (snap.listings.length === 0) failed++;
}

const h = writeReport(competitors.map(({ id, name, website }) => ({ id, name, website })), loadOwnStock());
console.log(`\nReport: ${h.listings.length} listings tracked, ${h.events.length} events. Open the dashboard with "npm run dev".`);
for (const w of h.warnings) console.warn(`warning: ${w}`);
process.exit(failed ? 1 : 0);
