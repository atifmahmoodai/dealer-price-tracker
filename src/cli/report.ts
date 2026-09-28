// Rebuilds public/data/history.json and data/exports/*.csv from the saved snapshots.
import { loadCompetitors, loadOwnStock, writeReport } from "./store";

const h = writeReport(loadCompetitors().map(({ id, name, website }) => ({ id, name, website })), loadOwnStock());
console.log(`${h.listings.length} listings, ${h.events.length} events over ${h.dates.length} day(s).`);
for (const w of h.warnings) console.warn(`warning: ${w}`);
