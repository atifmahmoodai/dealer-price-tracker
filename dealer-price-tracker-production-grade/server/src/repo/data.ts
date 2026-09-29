import type { Queryable } from "../db";
import type { CompetitorConfig } from "../scraper/extract";
import { DEFAULT_SETTINGS } from "../../../shared/settings-defaults";
import type { CompetitorInput, Run, Settings } from "../../../shared/schemas";
import type { History, OwnVehicle, Snapshot } from "../../../shared/types";

// ---- settings & audit ----

export async function getSettings(c: Queryable): Promise<Settings> {
  const { rows } = await c.query<{ value: Partial<Settings> }>("SELECT value FROM settings WHERE key = 'app'");
  // Defaults fill in fields added in later versions.
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveSettings(c: Queryable, s: Settings) {
  await c.query(
    `INSERT INTO settings (key, value) VALUES ('app', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(s)],
  );
}

export async function audit(
  c: Queryable,
  e: { userId: string | null; action: string; entity: string; entityId?: string | null; details?: Record<string, unknown>; ip?: string | null },
) {
  await c.query("INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6)", [
    e.userId,
    e.action,
    e.entity,
    e.entityId ?? null,
    JSON.stringify(e.details ?? {}),
    e.ip ?? null,
  ]);
}

// ---- competitors ----

export interface CompetitorRow {
  id: string;
  name: string;
  active: boolean;
  config: CompetitorInput;
  lastSnapshot: { date: string; listings: number; pages: number; errors: string[] } | null;
}

export async function listCompetitors(c: Queryable, onlyActive = false): Promise<CompetitorRow[]> {
  const { rows } = await c.query<{ id: string; name: string; active: boolean; config: CompetitorInput; last: CompetitorRow["lastSnapshot"] }>(
    `SELECT c.id, c.name, c.active, c.config,
            (SELECT json_build_object('date', s.date, 'listings', jsonb_array_length(s.listings), 'pages', s.pages, 'errors', s.errors)
               FROM snapshots s WHERE s.competitor_id = c.id ORDER BY s.date DESC LIMIT 1) AS last
       FROM competitors c ${onlyActive ? "WHERE c.active" : ""}
      ORDER BY c.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, active: r.active, config: r.config, lastSnapshot: r.last }));
}

export const toScrapeConfig = (id: string, cfg: CompetitorInput): CompetitorConfig => ({ id, ...cfg });

// ---- snapshots ----

export async function saveSnapshot(c: Queryable, s: Snapshot, runId: number | null) {
  await c.query(
    `INSERT INTO snapshots (competitor_id, date, scraped_at, pages, listings, errors, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (competitor_id, date) DO UPDATE
       SET scraped_at = EXCLUDED.scraped_at, pages = EXCLUDED.pages, listings = EXCLUDED.listings, errors = EXCLUDED.errors, run_id = EXCLUDED.run_id`,
    [s.dealerId, s.date, s.scrapedAt, s.pages, JSON.stringify(s.listings), JSON.stringify(s.errors), runId],
  );
}

/** Snapshots of the given competitors from `fromDate` on, oldest first. */
export async function loadSnapshots(c: Queryable, competitorIds: string[], fromDate: string): Promise<Snapshot[]> {
  if (!competitorIds.length) return [];
  const { rows } = await c.query<{ competitor_id: string; date: string; scraped_at: Date; pages: number; listings: Snapshot["listings"]; errors: string[] }>(
    "SELECT competitor_id, date, scraped_at, pages, listings, errors FROM snapshots WHERE competitor_id = ANY($1) AND date >= $2 ORDER BY date",
    [competitorIds, fromDate],
  );
  return rows.map((r) => ({ dealerId: r.competitor_id, date: r.date, scrapedAt: r.scraped_at.toISOString(), pages: r.pages, listings: r.listings, errors: r.errors }));
}

// ---- own stock ----

export async function loadOwnStock(c: Queryable): Promise<OwnVehicle[]> {
  const { rows } = await c.query<{ stock_no: string; year: number; make: string; model: string; mileage: number; price: number }>(
    "SELECT stock_no, year, make, model, mileage, price FROM own_stock ORDER BY stock_no",
  );
  return rows.map((r) => ({ stockNo: r.stock_no, year: r.year, make: r.make, model: r.model, mileage: r.mileage, price: Number(r.price) }));
}

/** Replaces the whole stock list (the dealer uploads their current stock export). */
export async function replaceOwnStock(c: Queryable, rows: OwnVehicle[]) {
  await c.query("DELETE FROM own_stock");
  if (!rows.length) return;
  await c.query(
    `INSERT INTO own_stock (stock_no, year, make, model, mileage, price)
     SELECT stock_no, year, make, model, mileage, price FROM json_to_recordset($1)
       AS x(stock_no text, year int, make text, model text, mileage int, price numeric)`,
    [JSON.stringify(rows.map((r) => ({ stock_no: r.stockNo, year: r.year, make: r.make, model: r.model, mileage: Math.round(r.mileage), price: r.price })))],
  );
}

// ---- report ----

export async function getReport(c: Queryable): Promise<{ generatedAt: string; history: History } | null> {
  const { rows } = await c.query<{ generated_at: Date; history: History }>("SELECT generated_at, history FROM report WHERE id = 1");
  return rows[0] ? { generatedAt: rows[0].generated_at.toISOString(), history: rows[0].history } : null;
}

export async function saveReport(c: Queryable, h: History) {
  await c.query(
    `INSERT INTO report (id, generated_at, history) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET generated_at = EXCLUDED.generated_at, history = EXCLUDED.history`,
    [h.generatedAt, JSON.stringify(h)],
  );
}

// ---- runs ----

interface RunRow {
  id: number;
  trigger: Run["trigger"];
  requested_by: string | null;
  requested_by_name: string | null;
  status: Run["status"];
  for_date: string;
  started_at: Date;
  finished_at: Date | null;
  results: Run["results"];
  error: string | null;
}
const RUN_SELECT = `SELECT r.*, u.name AS requested_by_name FROM scrape_runs r LEFT JOIN users u ON u.id = r.requested_by`;
const toRun = (r: RunRow): Run => ({
  id: r.id,
  trigger: r.trigger,
  requestedBy: r.requested_by_name,
  status: r.status,
  forDate: r.for_date,
  startedAt: r.started_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  results: r.results,
  error: r.error,
});

export async function listRuns(c: Queryable, limit = 30): Promise<Run[]> {
  return (await c.query<RunRow>(`${RUN_SELECT} ORDER BY r.id DESC LIMIT $1`, [limit])).rows.map(toRun);
}

export async function getRun(c: Queryable, id: number): Promise<Run | null> {
  const r = (await c.query<RunRow>(`${RUN_SELECT} WHERE r.id = $1`, [id])).rows[0];
  return r ? toRun(r) : null;
}

export async function runningRun(c: Queryable): Promise<Run | null> {
  const r = (await c.query<RunRow>(`${RUN_SELECT} WHERE r.status = 'running'`)).rows[0];
  return r ? toRun(r) : null;
}
