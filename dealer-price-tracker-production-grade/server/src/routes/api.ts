import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { todayIn } from "../config";
import { tx } from "../db";
import { badRequest, conflict, HttpError, notFound, parse, requireUser } from "../http";
import { audit, getReport, getSettings, listCompetitors, listRuns, loadOwnStock, replaceOwnStock, runningRun, saveSettings, getRun, toScrapeConfig } from "../repo/data";
import { rebuildReport, startRun } from "../runner";
import { createSafeFetch } from "../scraper/safe-fetch";
import { scrapeCompetitor } from "../scraper/scrape";
import { hashPassword } from "../security/password";
import { deleteUserSessions } from "../security/sessions";
import { historyToCsv } from "../../../shared/csv";
import {
  competitorConfigSchema,
  competitorCreateSchema,
  competitorUpdateSchema,
  resetPasswordSchema,
  settingsSchema,
  stockUploadSchema,
  userCreateSchema,
  userUpdateSchema,
  type Meta,
  type Role,
} from "../../../shared/schemas";
import { ownStockToCsv, parseOwnStockCsv } from "../../../shared/stock-csv";

const EXPORTS = new Set(["listings.csv", "events.csv", "daily.csv"]);

export async function apiRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const admin = requireUser("admin");
  const uid = (req: FastifyRequest) => req.session!.user.id;
  const today = () => todayIn(app.config.TIMEZONE);

  app.get("/meta", { preHandler: anyone }, async (): Promise<Meta> => ({ timeZone: app.config.TIMEZONE, settings: await getSettings(app.db), running: await runningRun(app.db) }));

  // ---- dashboard data ----
  app.get("/report", { preHandler: anyone }, async (req, reply) => {
    const r = await getReport(app.db);
    if (!r) return { history: null };
    // The report only changes after a scrape; let the browser reuse its copy until then.
    const etag = `"${Date.parse(r.generatedAt).toString(36)}"`;
    reply.header("etag", etag).header("cache-control", "private, no-cache");
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    return { history: r.history };
  });

  app.get<{ Params: { name: string } }>("/exports/:name", { preHandler: anyone }, async (req, reply) => {
    if (!EXPORTS.has(req.params.name)) throw notFound("No such export");
    const r = await getReport(app.db);
    if (!r) throw notFound("No data yet: run a scrape first.");
    const csv = historyToCsv(r.history)[req.params.name];
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="competitor-${req.params.name.replace(".csv", "")}-${today()}.csv"`)
      .send("﻿" + csv); // BOM so Excel reads UTF-8 names correctly
  });

  // ---- competitors ----
  app.get("/competitors", { preHandler: anyone }, async () => ({ items: await listCompetitors(app.db) }));

  app.post("/competitors", { preHandler: admin }, async (req, reply) => {
    const c = parse(competitorCreateSchema, req.body);
    try {
      await app.db.query("INSERT INTO competitors (id, name, config, active) VALUES ($1, $2, $3, $4)", [c.id, c.config.name, JSON.stringify(c.config), c.active]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "A competitor with that ID already exists.", "conflict", { id: "Already used" });
      throw e;
    }
    await audit(app.db, { userId: uid(req), action: "competitor.create", entity: "competitor", entityId: c.id, details: { name: c.config.name }, ip: req.ip });
    await rebuildReport(app.db, today());
    return reply.status(201).send({ id: c.id });
  });

  app.put<{ Params: { id: string } }>("/competitors/:id", { preHandler: admin }, async (req) => {
    const c = parse(competitorUpdateSchema, req.body);
    const r = await app.db.query("UPDATE competitors SET name = $2, config = $3, active = $4, updated_at = now() WHERE id = $1", [
      req.params.id,
      c.config.name,
      JSON.stringify(c.config),
      c.active,
    ]);
    if (!r.rowCount) throw notFound("Competitor not found");
    await audit(app.db, { userId: uid(req), action: "competitor.update", entity: "competitor", entityId: req.params.id, details: { name: c.config.name, active: c.active }, ip: req.ip });
    await rebuildReport(app.db, today());
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/competitors/:id", { preHandler: admin }, async (req) => {
    if (await runningRun(app.db)) throw conflict("Wait for the running scrape to finish first.");
    const r = await app.db.query<{ name: string }>("DELETE FROM competitors WHERE id = $1 RETURNING name", [req.params.id]);
    if (!r.rows[0]) throw notFound("Competitor not found");
    await audit(app.db, { userId: uid(req), action: "competitor.delete", entity: "competitor", entityId: req.params.id, details: { name: r.rows[0].name }, ip: req.ip });
    await rebuildReport(app.db, today());
    return { ok: true };
  });

  // Tries a configuration on the first page only, without saving anything, so selectors can be tuned.
  app.post("/competitors/test", { preHandler: admin, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const cfg = parse(competitorConfigSchema, req.body);
    const fetchImpl = createSafeFetch({ allowPrivate: app.config.SCRAPER_ALLOW_PRIVATE, maxBytes: app.config.SCRAPER_MAX_PAGE_MB * 1024 * 1024 });
    const snap = await scrapeCompetitor(toScrapeConfig("test", { ...cfg, startUrls: cfg.startUrls.slice(0, 1), maxPages: 1 }), { date: today(), fetchImpl, retries: 0, timeoutMs: 15_000 });
    return { found: snap.listings.length, pages: snap.pages, errors: snap.errors, sample: snap.listings.slice(0, 10) };
  });

  // ---- scrape runs ----
  app.get("/runs", { preHandler: anyone }, async () => ({ items: await listRuns(app.db) }));
  app.get<{ Params: { id: string } }>("/runs/:id", { preHandler: anyone }, async (req) => {
    const run = /^\d+$/.test(req.params.id) ? await getRun(app.db, Number(req.params.id)) : null;
    if (!run) throw notFound("Run not found");
    return run;
  });
  app.post("/runs", { preHandler: admin }, async (req, reply) => {
    const body = (req.body ?? {}) as { competitorId?: unknown };
    const competitorId = typeof body.competitorId === "string" && body.competitorId ? body.competitorId : undefined;
    const id = await startRun(app, { trigger: "manual", userId: uid(req), competitorId, ip: req.ip });
    return reply.status(202).send({ id });
  });

  // ---- own stock ----
  app.get("/stock", { preHandler: anyone }, async () => ({ items: await loadOwnStock(app.db) }));
  app.get("/stock.csv", { preHandler: anyone }, async (_req, reply) =>
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="my-stock-${today()}.csv"`)
      .send("﻿" + ownStockToCsv(await loadOwnStock(app.db))),
  );
  app.put("/stock", { preHandler: admin, bodyLimit: 2_500_000 }, async (req) => {
    const { csv } = parse(stockUploadSchema, req.body);
    let rows;
    try {
      rows = parseOwnStockCsv(csv);
    } catch (e) {
      throw badRequest((e as Error).message, { csv: (e as Error).message });
    }
    if (rows.length > 5000) throw badRequest("At most 5,000 vehicles per upload.", { csv: "Too many rows" });
    await tx(app.db, async (c) => {
      await replaceOwnStock(c, rows);
      await audit(c, { userId: uid(req), action: "stock.replace", entity: "stock", details: { vehicles: rows.length }, ip: req.ip });
    });
    await rebuildReport(app.db, today());
    return { count: rows.length };
  });

  // ---- settings, users, audit (admin) ----
  app.get("/settings", { preHandler: admin }, async () => getSettings(app.db));
  app.put("/settings", { preHandler: admin }, async (req) => {
    const s = parse(settingsSchema, req.body);
    try {
      new Intl.NumberFormat(s.locale, { style: "currency", currency: s.currency });
    } catch {
      throw badRequest("That currency / locale combination isn't valid.", { currency: "Not a valid currency" });
    }
    const before = await getSettings(app.db);
    await saveSettings(app.db, s);
    await audit(app.db, { userId: uid(req), action: "settings.update", entity: "settings", entityId: "app", details: s, ip: req.ip });
    if (before.historyDays !== s.historyDays) await rebuildReport(app.db, today());
    return s;
  });

  interface UserRow {
    id: string;
    email: string;
    name: string;
    role: Role;
    active: boolean;
    locked: boolean;
  }
  const USERS = "SELECT id, email, name, role, active, (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM users";
  app.get("/users", { preHandler: admin }, async () => ({ items: (await app.db.query<UserRow>(`${USERS} ORDER BY active DESC, name`)).rows }));
  app.post("/users", { preHandler: admin }, async (req, reply) => {
    const u = parse(userCreateSchema, req.body);
    const id = `u-${randomUUID()}`;
    try {
      await app.db.query("INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)", [id, u.email, u.name, u.role, await hashPassword(u.password)]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "A user with that email already exists.", "conflict", { email: "Already has a login" });
      throw e;
    }
    await audit(app.db, { userId: uid(req), action: "user.create", entity: "user", entityId: id, details: { email: u.email, role: u.role }, ip: req.ip });
    return reply.status(201).send({ id });
  });
  app.put<{ Params: { id: string } }>("/users/:id", { preHandler: admin }, async (req) => {
    const u = parse(userUpdateSchema, req.body);
    if (req.params.id === uid(req) && (u.role !== "admin" || !u.active)) throw badRequest("You can't remove your own admin access.");
    await tx(app.db, async (c) => {
      const r = await c.query("UPDATE users SET name = $2, role = $3, active = $4, updated_at = now() WHERE id = $1", [req.params.id, u.name, u.role, u.active]);
      if (!r.rowCount) throw notFound("User not found");
      if ((await c.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active")).rows[0].n === 0) throw badRequest("There must be at least one active admin.");
      if (!u.active) await deleteUserSessions(c, req.params.id);
      await audit(c, { userId: uid(req), action: "user.update", entity: "user", entityId: req.params.id, details: u, ip: req.ip });
    });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/users/:id/password", { preHandler: admin }, async (req) => {
    const { password } = parse(resetPasswordSchema, req.body);
    const r = await app.db.query("UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [req.params.id, await hashPassword(password)]);
    if (!r.rowCount) throw notFound("User not found");
    await deleteUserSessions(app.db, req.params.id);
    await audit(app.db, { userId: uid(req), action: "user.password_reset", entity: "user", entityId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  app.get<{ Querystring: { before?: string } }>("/audit", { preHandler: admin }, async (req) => {
    const before = Number(req.query.before) || null;
    const { rows } = await app.db.query(
      `SELECT a.id, a.at, a.action, a.entity, a.entity_id AS "entityId", a.details, a.ip, u.name AS "userName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE ($1::bigint IS NULL OR a.id < $1)
        ORDER BY a.id DESC LIMIT 100`,
      [before],
    );
    return { items: rows, nextBefore: rows.length === 100 ? rows[rows.length - 1].id : null };
  });
}
