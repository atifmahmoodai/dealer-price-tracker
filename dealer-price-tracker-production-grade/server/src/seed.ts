import type { PoolClient } from "pg";
import { todayIn } from "./config";
import { saveSettings, saveSnapshot, replaceOwnStock } from "./repo/data";
import { rebuildReport } from "./runner";
import { fakeWebFetch, demoConfig } from "./demo/fake-web";
import { createMarket, type DemoDealer } from "./demo/market";
import { scrapeCompetitor } from "./scraper/scrape";
import { hashPassword } from "./security/password";
import { addDays } from "../../shared/normalize";
import { DEFAULT_SETTINGS } from "../../shared/settings-defaults";

export const DEMO_ADMIN = "admin@demo.local";
export const DEMO_VIEWER = "viewer@demo.local";
export const DEMO_DAYS = 60;
/** Day (0-based) on which one demo site is "down", to show how failed scrapes are handled. */
export const DEMO_FAILED_DAY = 37;

/**
 * Three simulated competitors with 60 days of history ending today, produced by running the real
 * scraper against simulated websites, plus a demo stock list and demo logins.
 */
export async function seedDemo(c: PoolClient, opts: { timeZone: string; force: boolean; password: string; now?: Date }) {
  const existing = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM competitors")).rows[0].n;
  if (existing && !opts.force) throw new Error(`The database already has ${existing} competitors. Re-run with --force to replace them with demo data.`);
  if (opts.force) for (const t of ["snapshots", "scrape_runs", "competitors", "own_stock", "report"]) await c.query(`DELETE FROM ${t}`);

  const hash = await hashPassword(opts.password);
  for (const [id, email, name, role] of [
    ["u-demo-admin", DEMO_ADMIN, "Demo Admin", "admin"],
    ["u-demo-viewer", DEMO_VIEWER, "Demo Viewer", "viewer"],
  ]) {
    await c.query(
      `INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, active = true, failed_logins = 0, locked_until = NULL`,
      [id, email, name, role, hash],
    );
  }
  // The demo competitors live on fictional domains; the daily schedule stays off so it doesn't try to reach them.
  await saveSettings(c, { ...DEFAULT_SETTINGS, companyName: "Demo Motors", scheduleEnabled: false });

  const today = todayIn(opts.timeZone, opts.now);
  const start = addDays(today, -(DEMO_DAYS - 1));
  const market = createMarket(7, start);
  const origins = new Map<string, DemoDealer>(market.dealers.map((d) => [`https://${d.id}.example`, d]));
  for (const [origin, d] of origins) {
    const cfg = demoConfig(d, origin);
    await c.query("INSERT INTO competitors (id, name, config) VALUES ($1, $2, $3)", [d.id, d.name, JSON.stringify(cfg)]);
  }

  const web = fakeWebFetch(origins);
  const down = "city-autos";
  const fetchFor = (id: string, day: number): typeof fetch =>
    day === DEMO_FAILED_DAY && id === down ? (async () => new Response("maintenance", { status: 503 })) as typeof fetch : web;
  for (let day = 0; day < DEMO_DAYS; day++) {
    const date = addDays(start, day);
    if (day > 0) market.step(date);
    for (const [origin, d] of origins) {
      const snap = await scrapeCompetitor({ id: d.id, ...demoConfig(d, origin) }, { date, fetchImpl: fetchFor(d.id, day), sleep: async () => {}, retries: 0 });
      snap.scrapedAt = `${date}T06:00:00.000Z`;
      await saveSnapshot(c, snap, null);
    }
  }
  const own = market.ownStock(today);
  await replaceOwnStock(c, own);
  const history = await rebuildReport(c, today);
  return { competitors: origins.size, days: DEMO_DAYS, listings: history.listings.length, events: history.events.length, logins: [DEMO_ADMIN, DEMO_VIEWER] };
}
