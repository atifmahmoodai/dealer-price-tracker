import type { FastifyInstance } from "fastify";
import { clockIn, todayIn } from "./config";
import type { Queryable } from "./db";
import { HttpError } from "./http";
import { audit, getSettings, listCompetitors, loadOwnStock, loadSnapshots, saveReport, saveSnapshot, toScrapeConfig } from "./repo/data";
import { createSafeFetch } from "./scraper/safe-fetch";
import { scrapeCompetitor } from "./scraper/scrape";
import { buildHistory, compareToMarket } from "../../shared/history";
import { addDays } from "../../shared/normalize";
import type { Run, RunResult, Settings } from "../../shared/schemas";
import type { History } from "../../shared/types";

/** A run whose process died (deploy, crash) stops sending heartbeats; after this long it's marked failed. */
const STALE_MINUTES = 20;

/** Rebuilds the dashboard data from the saved snapshots of active competitors. */
export async function rebuildReport(c: Queryable, today: string): Promise<History> {
  const settings = await getSettings(c);
  const competitors = await listCompetitors(c, true);
  const from = addDays(today, -(settings.historyDays - 1));
  const snapshots = await loadSnapshots(
    c,
    competitors.map((x) => x.id),
    from,
  );
  const history = buildHistory(
    snapshots,
    competitors.map((x) => ({ id: x.id, name: x.name, website: x.config.website })),
    await loadOwnStock(c),
  );
  await saveReport(c, history);
  return history;
}

async function failStaleRuns(c: Queryable) {
  await c.query(
    `UPDATE scrape_runs SET status = 'failed', finished_at = now(), error = 'Interrupted (the server stopped during the run)'
      WHERE status = 'running' AND heartbeat_at < now() - make_interval(mins => $1)`,
    [STALE_MINUTES],
  );
}

// Promises of runs started by this process, so tests (and shutdown) can wait for them.
const inFlight = new Map<number, Promise<void>>();
export const waitForRun = (id: number) => inFlight.get(id) ?? Promise.resolve();
export const waitForAllRuns = () => Promise.all(inFlight.values());

/** Marks this process's unfinished runs as failed (on shutdown). */
export async function abandonRuns(c: Queryable) {
  const ids = [...inFlight.keys()];
  if (!ids.length) return;
  await c.query("UPDATE scrape_runs SET status = 'failed', finished_at = now(), error = 'Interrupted by a server restart' WHERE id = ANY($1) AND status = 'running'", [ids]);
}

/**
 * Starts a scrape in the background and returns its id. Only one run can exist at a time across all
 * instances (a unique index on running runs), so a second request gets a 409 instead of a double scrape.
 */
export async function startRun(
  app: FastifyInstance,
  opts: { trigger: Run["trigger"]; userId: string | null; competitorId?: string; ip?: string; scheduleGuard?: boolean },
): Promise<number> {
  await failStaleRuns(app.db);
  const today = todayIn(app.config.TIMEZONE);
  let id: number | undefined;
  try {
    const { rows } = await app.db.query<{ id: number }>(
      opts.scheduleGuard
        ? // The schedule runs once a day; a failed attempt is retried a few times, not forever.
          `INSERT INTO scrape_runs (trigger, requested_by, status, for_date)
           SELECT $1, $2, 'running', $3
            WHERE NOT EXISTS (SELECT 1 FROM scrape_runs WHERE trigger = 'schedule' AND for_date = $3 AND status IN ('running', 'done'))
              AND (SELECT count(*) FROM scrape_runs WHERE trigger = 'schedule' AND for_date = $3) < 3
           RETURNING id`
        : "INSERT INTO scrape_runs (trigger, requested_by, status, for_date) VALUES ($1, $2, 'running', $3) RETURNING id",
      [opts.trigger, opts.userId, today],
    );
    id = rows[0]?.id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new HttpError(409, "A scrape is already running. Wait for it to finish.", "conflict");
    throw e;
  }
  if (id === undefined) return 0; // schedule already satisfied today
  await audit(app.db, { userId: opts.userId, action: "run.start", entity: "run", entityId: String(id), details: { trigger: opts.trigger, competitorId: opts.competitorId }, ip: opts.ip });
  const runId = id;
  const p = executeRun(app, runId, today, opts.competitorId).finally(() => inFlight.delete(runId));
  inFlight.set(runId, p);
  return runId;
}

async function executeRun(app: FastifyInstance, runId: number, today: string, only?: string) {
  const log = app.log.child({ runId });
  const fetchImpl = createSafeFetch({ allowPrivate: app.config.SCRAPER_ALLOW_PRIVATE, maxBytes: app.config.SCRAPER_MAX_PAGE_MB * 1024 * 1024 });
  const results: RunResult[] = [];
  try {
    const competitors = (await listCompetitors(app.db, true)).filter((c) => !only || c.id === only);
    if (only && !competitors.length) throw new Error("That competitor doesn't exist or isn't active.");
    for (const comp of competitors) {
      const t0 = Date.now();
      const snap = await scrapeCompetitor(toScrapeConfig(comp.id, comp.config), {
        date: today,
        fetchImpl,
        log: (m) => log.debug(m),
        sleep: app.config.NODE_ENV === "test" ? async () => {} : undefined,
      });
      // A re-run that finds nothing (site down, blocked) must not wipe a good result from earlier today.
      const earlier = snap.listings.length
        ? 0
        : ((await app.db.query<{ n: number }>("SELECT jsonb_array_length(listings) AS n FROM snapshots WHERE competitor_id = $1 AND date = $2", [comp.id, today])).rows[0]?.n ?? 0);
      if (!earlier) await saveSnapshot(app.db, snap, runId);
      const errors = earlier ? [...snap.errors, `kept today's earlier result (${earlier} cars)`] : snap.errors;
      results.push({ competitorId: comp.id, name: comp.name, listings: snap.listings.length, pages: snap.pages, errors: errors.slice(0, 5), ms: Date.now() - t0 });
      await app.db.query("UPDATE scrape_runs SET results = $2, heartbeat_at = now() WHERE id = $1", [runId, JSON.stringify(results)]);
      log.info({ competitor: comp.id, listings: snap.listings.length, errors: snap.errors.length }, "competitor scraped");
    }
    const history = await rebuildReport(app.db, today);
    await app.db.query("UPDATE scrape_runs SET status = 'done', finished_at = now(), results = $2 WHERE id = $1", [runId, JSON.stringify(results)]);
    await sendDigest(app, history, today, results).catch((err) => log.error({ err }, "digest failed"));
  } catch (err) {
    log.error({ err }, "scrape run failed");
    await app.db
      .query("UPDATE scrape_runs SET status = 'failed', finished_at = now(), results = $2, error = $3 WHERE id = $1", [
        runId,
        JSON.stringify(results),
        (err instanceof Error ? err.message : String(err)).slice(0, 500),
      ])
      .catch((e) => log.error({ err: e }, "could not record the failed run"));
  }
}

/** The morning email: what competitors changed today, your cars priced above market, and scrape problems. */
export function digestText(h: History, date: string, results: RunResult[], s: Settings, link: string): string | null {
  const money = (n?: number) => (n === undefined ? "?" : new Intl.NumberFormat(s.locale, { style: "currency", currency: s.currency, maximumFractionDigits: 0 }).format(n));
  const name = new Map(h.dealers.map((d) => [d.id, d.name]));
  const today = h.events.filter((e) => e.date === date);
  const cuts = today.filter((e) => e.type === "price_change" && (e.delta ?? 0) < 0).sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));
  const added = today.filter((e) => e.type === "new" || e.type === "relisted");
  const removed = today.filter((e) => e.type === "removed");
  const problems = results.filter((r) => r.errors.length || r.listings === 0);
  const over = h.ownStock.map((v) => compareToMarket(v, h.listings)).filter((c) => (c.position ?? 0) > 0.05);
  if (!today.length && !problems.length && !over.length) return null;

  const lines = [`${s.companyName}: competitor update for ${date}`, ""];
  lines.push(`${added.length} new listing(s), ${removed.length} sold/removed, ${cuts.length} price cut(s).`, "");
  if (cuts.length) {
    lines.push("Biggest price cuts:");
    for (const e of cuts.slice(0, 10)) lines.push(`  ${name.get(e.dealerId)}: ${e.title} ${money(e.oldPrice)} → ${money(e.newPrice)}`);
    lines.push("");
  }
  if (over.length) {
    lines.push(`${over.length} of your cars are more than 5% above the market median:`);
    for (const c of over.slice(0, 10)) lines.push(`  ${c.vehicle.stockNo} ${c.vehicle.year} ${c.vehicle.make} ${c.vehicle.model}: ${money(c.vehicle.price)} vs ${money(c.marketMedian ?? undefined)} (${c.comps.length} comps)`);
    lines.push("");
  }
  if (problems.length) {
    lines.push("Scrape problems (check the competitor's settings):");
    for (const p of problems) lines.push(`  ${p.name}: ${p.listings} cars${p.errors[0] ? `, ${p.errors[0]}` : ""}`);
    lines.push("");
  }
  lines.push(`Dashboard: ${link}`);
  return lines.join("\n");
}

async function sendDigest(app: FastifyInstance, h: History, date: string, results: RunResult[]) {
  const s = await getSettings(app.db);
  if (!s.alertEmails.length) return;
  const text = digestText(h, date, results, s, app.config.PUBLIC_URL);
  if (!text) return;
  for (const to of s.alertEmails) await app.mailer.send(to, `Competitor update ${date}`, text);
}

/** Checks every minute whether today's scheduled scrape is due. Safe with several instances. */
export function startScheduler(app: FastifyInstance): () => void {
  const tick = async () => {
    try {
      const s = await getSettings(app.db);
      if (!s.scheduleEnabled) return;
      // Runs at the set time, or as soon as the server is up if that time has already passed today.
      if (clockIn(app.config.TIMEZONE) < s.scrapeTime) return;
      if (!(await listCompetitors(app.db, true)).length) return; // nothing to scrape yet
      const id = await startRun(app, { trigger: "schedule", userId: null, scheduleGuard: true });
      if (id) app.log.info({ runId: id }, "scheduled scrape started");
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) app.log.error({ err }, "scheduler tick failed");
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

