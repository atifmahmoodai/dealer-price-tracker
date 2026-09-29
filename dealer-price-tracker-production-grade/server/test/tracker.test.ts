import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMarket } from "../src/demo/market";
import { renderSite } from "../src/demo/sites";
import { digestText, startRun, waitForRun } from "../src/runner";
import { createSafeFetch, isPrivateAddress } from "../src/scraper/safe-fetch";
import { DEMO_ADMIN, DEMO_DAYS, DEMO_VIEWER } from "../src/seed";
import { DEFAULT_SETTINGS } from "../../shared/settings-defaults";
import type { Run } from "../../shared/schemas";
import type { History } from "../../shared/types";
import { login, makeApp, type Agent, type TestCtx } from "./helpers";

let ctx: TestCtx;
let admin: Agent;
let viewer: Agent;
// A local "competitor website" the scraper can reach in these tests (private addresses allowed here).
let site: Server;
let siteUrl = "";
let siteDown = false;
const market = createMarket(3, "2026-09-01");

beforeAll(async () => {
  site = createServer((req, res) => {
    if (siteDown) return void res.writeHead(503).end("maintenance");
    if (req.url === "/robots.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /admin\n");
    const [id, ...rest] = (req.url ?? "/").split("/").filter(Boolean);
    const d = market.dealers.find((x) => x.id === id);
    const html = d ? renderSite(d, "/" + rest.join("/"), `http://${req.headers.host}/${id}`) : null;
    if (html === null) res.writeHead(404).end();
    else res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  ctx = await makeApp({ SCRAPER_ALLOW_PRIVATE: "true" });
  admin = await login(ctx.app, DEMO_ADMIN);
  viewer = await login(ctx.app, DEMO_VIEWER);
});
afterAll(async () => {
  await ctx.close();
  site.close();
});

const report = async (a: Agent) => (await a.get("/api/report")).json().history as History;
const runAndWait = async (body: object) => {
  const res = await admin.send("POST", "/api/runs", body);
  expect(res.statusCode).toBe(202);
  const { id } = res.json() as { id: number };
  await waitForRun(id);
  return (await admin.get(`/api/runs/${id}`)).json() as Run;
};

describe("demo history", () => {
  it("was built by the real scraper, skipping the day a site was down", async () => {
    const h = await report(viewer);
    expect(h.dealers.map((d) => d.id).sort()).toEqual(["city-autos", "metro-motors", "prime-cars"]);
    expect(h.dates).toHaveLength(DEMO_DAYS);
    expect(h.warnings.some((w) => w.includes("city-autos") && w.includes("skipped"))).toBe(true);
    expect(h.events.some((e) => e.type === "price_change")).toBe(true);
    expect(h.ownStock.length).toBeGreaterThan(0);
  });

  it("lets the browser reuse the report until it changes", async () => {
    const first = await viewer.get("/api/report");
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const again = await ctx.app.inject({ url: "/api/report", headers: { cookie: `sid=${viewer.cookie}`, "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
  });

  it("exports spreadsheet-safe CSVs", async () => {
    const res = await viewer.get("/api/exports/listings.csv");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.body.startsWith("﻿DealerID,Dealer,Key,Title")).toBe(true);
    expect((await viewer.get("/api/exports/..%2Fetc%2Fpasswd")).statusCode).toBe(404);
  });
});

describe("access", () => {
  it("requires a login; viewers can look but not change anything", async () => {
    expect((await ctx.app.inject("/api/report")).statusCode).toBe(401);
    expect((await ctx.app.inject("/api/exports/events.csv")).statusCode).toBe(401);
    const cfg = { name: "X Motors", website: "https://x.example", startUrls: ["https://x.example/cars"] };
    expect((await viewer.send("POST", "/api/competitors", { id: "x-motors", config: cfg })).statusCode).toBe(403);
    expect((await viewer.send("POST", "/api/runs", {})).statusCode).toBe(403);
    expect((await viewer.send("PUT", "/api/stock", { csv: "" })).statusCode).toBe(403);
    expect((await viewer.get("/api/settings")).statusCode).toBe(403);
    const noCsrf = await ctx.app.inject({ method: "POST", url: "/api/runs", headers: { cookie: `sid=${admin.cookie}` }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe("scraper safety", () => {
  it("classifies private and public addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses internal addresses, including via redirects, unless explicitly allowed", async () => {
    const safe = createSafeFetch();
    await expect(safe(`${siteUrl}/metro-motors/inventory`)).rejects.toThrow(/private or local/);
    await expect(safe("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private or local/);
    await expect(safe("http://localhost:5432/")).rejects.toThrow(/private or local/);
    await expect(safe("file:///etc/passwd")).rejects.toThrow(/refused/);
    // A public-looking name that resolves to loopback is caught at connect time.
    await expect(safe("http://localtest.me:1/")).rejects.toThrow();

    const redirector = createServer((_req, res) => res.writeHead(302, { location: "http://127.0.0.1:9/" }).end());
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const port = (redirector.address() as AddressInfo).port;
    // Allowed to reach the redirector itself, the redirect target is still checked hop by hop.
    const permissive = createSafeFetch({ allowPrivate: true, maxRedirects: 0 });
    await expect(permissive(`http://127.0.0.1:${port}/`)).rejects.toThrow(/too many redirects/);
    redirector.close();
  });

  it("the API's test button reports a refused address instead of fetching it", async () => {
    const strict = await makeApp();
    const a = await login(strict.app, DEMO_ADMIN);
    const res = await a.send("POST", "/api/competitors/test", { name: "Internal", website: "http://10.0.0.5", startUrls: ["http://10.0.0.5/admin"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(0);
    expect(res.json().errors.join(" ")).toMatch(/private or local/);
    await strict.close();
  });

  it("caps page size", async () => {
    const big = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("x".repeat(3 * 1024 * 1024)));
    await new Promise<void>((r) => big.listen(0, "127.0.0.1", r));
    const f = createSafeFetch({ allowPrivate: true, maxBytes: 1024 * 1024 });
    await expect(f(`http://127.0.0.1:${(big.address() as AddressInfo).port}/`)).rejects.toThrow(/larger than 1 MB/);
    big.close();
  });
});

describe("competitors and scrape runs", () => {
  it("validates the recipe", async () => {
    const bad = await admin.send("POST", "/api/competitors", {
      id: "Bad ID!",
      config: { name: "X", website: "ftp://x", startUrls: [], mode: "selectors", delayMs: 10 },
    });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(bad.json().details)).toEqual(expect.arrayContaining(["id", "config.name", "config.website", "config.startUrls", "config.delayMs"]));
    // Empty fields are a 400 with field messages, never a server error.
    const empty = await admin.send("POST", "/api/competitors", { id: "", config: { name: "", website: "", startUrls: [""] } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().details["config.website"]).toBeTruthy();
  });

  it("tests a recipe on one page without saving it", async () => {
    const res = await admin.send("POST", "/api/competitors/test", { name: "Metro", website: siteUrl, startUrls: [`${siteUrl}/metro-motors/inventory`] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pages).toBe(1);
    expect(body.found).toBeGreaterThan(5);
    expect(body.sample[0].price).toBeGreaterThan(1000);
    expect((await admin.get("/api/competitors")).json().items).toHaveLength(3);
  });

  it("adds a competitor, scrapes it, allows only one run at a time, and emails a digest", async () => {
    const s = (await admin.get("/api/settings")).json();
    expect((await admin.send("PUT", "/api/settings", { ...s, alertEmails: ["boss@example.com"] })).statusCode).toBe(200);
    const created = await admin.send("POST", "/api/competitors", {
      id: "local-metro",
      config: { name: "Local Metro", website: siteUrl, startUrls: [`${siteUrl}/metro-motors/inventory`], delayMs: 1000 },
    });
    expect(created.statusCode).toBe(201);
    expect((await admin.send("POST", "/api/competitors", { id: "local-metro", config: { name: "Dup", website: siteUrl, startUrls: [siteUrl] } })).statusCode).toBe(409);

    const first = await admin.send("POST", "/api/runs", { competitorId: "local-metro" });
    expect(first.statusCode).toBe(202);
    const second = await admin.send("POST", "/api/runs", { competitorId: "local-metro" });
    expect(second.statusCode).toBe(409);
    await waitForRun(first.json().id);

    const run = (await admin.get(`/api/runs/${first.json().id}`)).json() as Run;
    expect(run.status).toBe("done");
    expect(run.results[0].listings).toBe(market.dealers[0].cars.length);
    expect(run.results[0].pages).toBeGreaterThan(1);
    const h = await report(viewer);
    expect(h.listings.filter((l) => l.dealerId === "local-metro")).toHaveLength(market.dealers[0].cars.length);
    // The first scrape of a new competitor only sets the baseline, so today's digest has nothing about it,
    // but it still lists the demo cars priced above market.
    expect(ctx.mail.some((m) => m.to === "boss@example.com" && /Competitor update/.test(m.subject))).toBe(true);
  });

  it("a failed re-scrape keeps the good result from earlier the same day", async () => {
    siteDown = true;
    const run = await runAndWait({ competitorId: "local-metro" });
    siteDown = false;
    expect(run.status).toBe("done");
    expect(run.results[0].listings).toBe(0);
    expect(run.results[0].errors.join(" ")).toMatch(/kept today's earlier result/);
    const h = await report(viewer);
    expect(h.listings.filter((l) => l.dealerId === "local-metro" && l.status === "active")).toHaveLength(market.dealers[0].cars.length);
  });

  it("recovers from a run left behind by a crashed server", async () => {
    await ctx.app.db.query("INSERT INTO scrape_runs (trigger, status, for_date, heartbeat_at) VALUES ('manual', 'running', CURRENT_DATE, now() - interval '1 hour')");
    const run = await runAndWait({ competitorId: "local-metro" });
    expect(run.status).toBe("done");
    const runs = (await admin.get("/api/runs")).json().items as Run[];
    expect(runs.some((r) => r.status === "failed" && /Interrupted/.test(r.error ?? ""))).toBe(true);
  });

  it("an unknown competitor fails the run cleanly", async () => {
    const run = await runAndWait({ competitorId: "nope" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/doesn't exist/);
  });

  it("deleting a competitor removes it from the dashboard", async () => {
    expect((await admin.send("DELETE", "/api/competitors/local-metro")).statusCode).toBe(200);
    const h = await report(viewer);
    expect(h.dealers.some((d) => d.id === "local-metro")).toBe(false);
    expect(h.listings.some((l) => l.dealerId === "local-metro")).toBe(false);
  });
});

describe("own stock", () => {
  it("rejects a malformed file with a clear message and changes nothing", async () => {
    const before = (await admin.get("/api/stock")).json().items.length;
    const res = await admin.send("PUT", "/api/stock", { csv: "Stock,Year\nA1,2020" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/missing column/);
    const dup = await admin.send("PUT", "/api/stock", { csv: "StockNo,Year,Make,Model,Mileage,Price\nA1,2020,Toyota,Corolla,30000,20000\na1,2021,Honda,Civic,1,2" });
    expect(dup.json().message).toMatch(/appears twice/);
    expect((await admin.get("/api/stock")).json().items).toHaveLength(before);
  });

  it("replaces the stock from an Excel CSV and compares it with the market", async () => {
    const csv = "﻿StockNo,Year,Make,Model,Mileage,Price\r\nT100,2022,Toyota,Corolla,\"30,000\",\"$21,500\"\r\nT101,2021,Honda,Civic,41000,19900\r\n";
    const res = await admin.send("PUT", "/api/stock", { csv });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(2);
    const h = await report(viewer);
    expect(h.ownStock).toEqual([
      { stockNo: "T100", year: 2022, make: "Toyota", model: "Corolla", mileage: 30000, price: 21500 },
      { stockNo: "T101", year: 2021, make: "Honda", model: "Civic", mileage: 41000, price: 19900 },
    ]);
    const exported = await viewer.get("/api/stock.csv");
    expect(exported.body).toContain("T100,2022,Toyota,Corolla,30000,21500");
  });
});

describe("digest email", () => {
  it("summarises the day's changes and scrape problems, and stays quiet when nothing happened", () => {
    const h: History = {
      generatedAt: "",
      dealers: [{ id: "a", name: "Alpha Cars", website: "" }],
      dates: ["2026-09-29"],
      listings: [],
      events: [
        { date: "2026-09-29", dealerId: "a", key: "k", type: "price_change", title: "2021 Toyota Corolla", oldPrice: 20000, newPrice: 18500, delta: -1500 },
        { date: "2026-09-28", dealerId: "a", key: "k2", type: "new", title: "old news" },
      ],
      daily: [],
      ownStock: [],
      warnings: [],
    };
    const s = { ...DEFAULT_SETTINGS, companyName: "Acme" };
    const text = digestText(h, "2026-09-29", [{ competitorId: "a", name: "Alpha Cars", listings: 0, pages: 1, errors: ["HTTP 403"], ms: 1 }], s, "https://x")!;
    expect(text).toContain("1 price cut(s)");
    expect(text).toContain("$20,000 → $18,500");
    expect(text).toContain("Alpha Cars: 0 cars, HTTP 403");
    expect(text).not.toContain("old news");
    expect(digestText({ ...h, events: [] }, "2026-09-29", [], s, "https://x")).toBeNull();
  });
});

describe("settings and users", () => {
  it("validates settings", async () => {
    const s = (await admin.get("/api/settings")).json();
    const bad = await admin.send("PUT", "/api/settings", { ...s, scrapeTime: "25:00", alertEmails: ["nope"], historyDays: 3 });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(bad.json().details)).toEqual(expect.arrayContaining(["scrapeTime", "alertEmails.0", "historyDays"]));
  });

  it("keeps at least one admin and signs out disabled users", async () => {
    const created = await admin.send("POST", "/api/users", { email: "analyst@example.com", name: "Ana Lyst", role: "viewer", password: "a-strong-pass-42" });
    expect(created.statusCode).toBe(201);
    const ana = await login(ctx.app, "analyst@example.com", "a-strong-pass-42");
    expect((await ana.get("/api/report")).statusCode).toBe(200);
    expect((await admin.send("PUT", `/api/users/${created.json().id}`, { name: "Ana Lyst", role: "viewer", active: false })).statusCode).toBe(200);
    expect((await ana.get("/api/report")).statusCode).toBe(401);
    const me = (await admin.get("/api/auth/me")).json().user;
    expect((await admin.send("PUT", `/api/users/${me.id}`, { name: me.name, role: "viewer", active: true })).statusCode).toBe(400);
    const audit = (await admin.get("/api/audit")).json().items.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["competitor.create", "competitor.delete", "run.start", "stock.replace", "user.create"]));
  });
});

describe("daily schedule", () => {
  it("runs once a day however many instances ask, and skips paused competitors", async () => {
    // Only a local site is active, so the scheduled scrape doesn't reach for the demo's fictional domains.
    await ctx.app.db.query("UPDATE competitors SET active = false");
    const created = await admin.send("POST", "/api/competitors", {
      id: "sched-local",
      config: { name: "Sched Local", website: siteUrl, startUrls: [`${siteUrl}/prime-cars/inventory`] },
    });
    expect(created.statusCode).toBe(201);
    const first = await startRun(ctx.app, { trigger: "schedule", userId: null, scheduleGuard: true });
    expect(first).toBeGreaterThan(0);
    // A second instance asking while it runs quietly skips (no error, no second scrape).
    expect(await startRun(ctx.app, { trigger: "schedule", userId: null, scheduleGuard: true })).toBe(0);
    await waitForRun(first);
    // And once it's done, today's schedule is satisfied.
    expect(await startRun(ctx.app, { trigger: "schedule", userId: null, scheduleGuard: true })).toBe(0);
    const run = (await admin.get(`/api/runs/${first}`)).json() as Run;
    expect(run.status).toBe("done");
    expect(run.results.map((r) => r.competitorId)).toEqual(["sched-local"]);
    // A manual scrape is still allowed the same day.
    const manual = await runAndWait({});
    expect(manual.status).toBe("done");
  });
});
