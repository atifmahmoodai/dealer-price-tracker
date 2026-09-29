// End-to-end smoke test of the whole production stack: a fresh PostgreSQL database with demo
// history, the built API server serving the built web app, simulated competitor websites for a
// real scrape, all driven in Chromium.
//   npm run build && npm run smoke        (from the project root)
// Uses SMOKE_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/tracker_smoke).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { chromium } from "playwright-core";

const PORT = 4186;
const SITES_PORT = 4191;
const BASE = `http://localhost:${PORT}/`;
const SITES = `http://127.0.0.1:${SITES_PORT}`;
const SHOTS = "test-results/screenshots";
const DB_URL = process.env.SMOKE_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/tracker_smoke";
const executablePath = process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
mkdirSync(SHOTS, { recursive: true });
if (!existsSync("../server/dist/server.js") || !existsSync("dist/index.html")) throw new Error("Build first: npm run build (from the project root)");

{
  const name = new URL(DB_URL).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes("smoke")) throw new Error("SMOKE_DATABASE_URL must name a database containing 'smoke'");
  const adminUrl = new URL(DB_URL);
  adminUrl.pathname = "/postgres";
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}
const env = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_URL: DB_URL,
  PORT: String(PORT),
  PUBLIC_URL: BASE,
  COOKIE_SECURE: "false",
  WEB_DIST: join(process.cwd(), "dist"),
  LOG_LEVEL: "warn",
  ALLOW_DEMO_SEED: "1",
  // The simulated competitor sites run on this machine; production keeps local addresses blocked.
  SCRAPER_ALLOW_PRIVATE: "1",
  DEMO_SITES_PORT: String(SITES_PORT),
};
const seeded = spawnSync("node", ["../server/dist/cli/seed-demo.js"], { env, encoding: "utf8" });
if (seeded.status !== 0) throw new Error(`demo seed failed: ${seeded.stderr}`);
const server = spawn("node", ["../server/dist/server.js"], { env, stdio: ["ignore", "inherit", "inherit"] });
const sites = spawn("node", ["../server/dist/cli/demo-sites.js"], { env, stdio: ["ignore", "ignore", "inherit"] });

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failures++;
};
const signIn = async (p, email, password = "demo-password-1") => {
  await p.goto(`${BASE}login`);
  await p.fill("input[type=email]", email);
  await p.fill("input[type=password]", password);
  await p.click("button:has-text('Sign in')");
  await p.waitForSelector(".appbar");
};

let page;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}readyz`)).ok && (await fetch(`${SITES}/metro-motors/inventory`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({ executablePath });
  const errors = [];
  const watch = (p) => {
    p.on("pageerror", (e) => {
      errors.push(e.stack || e.message);
      console.log(`  ! ${e.stack || e.message}`);
    });
    // 4xx answers are expected here (signed-out checks, rejected input); any 5xx or script error is a failure.
    p.on("console", (m) => m.type() === "error" && !/status of 4\d\d/.test(m.text()) && errors.push(`${p.url()}: ${m.text()}`));
    p.on("dialog", (d) => d.accept());
  };
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  page = await ctx.newPage();
  watch(page);

  console.log("Access");
  await page.goto(BASE);
  await page.waitForURL(/\/login/);
  check(true, "signed-out visitors are sent to sign-in");
  check((await fetch(`${BASE}api/report`)).status === 401, "the data API refuses anonymous requests");
  await page.fill("input[type=email]", "viewer@demo.local");
  await page.fill("input[type=password]", "wrong-password-1");
  await page.click("button:has-text('Sign in')");
  await page.waitForSelector("[role=alert]");
  check(true, "wrong password rejected");

  console.log("Viewer: dashboard");
  await signIn(page, "viewer@demo.local");
  await page.waitForSelector(".kpi");
  const kpis = (await page.locator(".kpi-value").allTextContents()).join(" | ");
  check(!/NaN|undefined|Infinity/.test(kpis), `KPIs render cleanly: ${kpis}`);
  await page.waitForSelector(".recharts-line-curve");
  check((await page.locator(".recharts-surface").count()) === 2, "both charts render");
  check((await page.locator(".recharts-line-curve").count()) === 3, "one line per competitor");
  await page.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });
  await page.locator("tr.clickable").first().click();
  check((await page.locator("tr.sub").count()) === 1, "clicking a stock row shows its comparables");
  const allRows = await page.locator("section.card:has-text('Latest changes') tbody tr").count();
  await page.click("role=tab[name='Price changes']");
  const priceRows = await page.locator("section.card:has-text('Latest changes') tbody tr").count();
  check(priceRows > 0 && priceRows < allRows, `change-type tabs filter (${allRows} → ${priceRows})`);
  await page.selectOption("label:has-text('Competitor') select", "city-autos");
  check((await page.locator(".recharts-line-curve").count()) === 1, "competitor filter narrows the chart");
  await page.selectOption("label:has-text('Period') select", "7");
  const k7 = (await page.locator(".kpi-value").allTextContents()).join(" | ");
  check(!/NaN|undefined/.test(k7) && k7 !== kpis, "period filter changes the KPIs");
  await page.fill("input[type=search]", "toyota");
  const titles = await page.locator("section.card:has-text('Competitor listings') tbody td:first-child").allTextContents();
  check(titles.length > 0 && titles.every((t) => /toyota/i.test(t)), `search filters listings (${titles.length} Toyotas)`);
  await page.locator("details.notice summary").click();
  check(await page.locator("details.notice li").first().isVisible(), "the day a site was down is listed as a handled warning");
  const csv = await page.evaluate(async () => {
    const r = await fetch("/api/exports/events.csv");
    return { status: r.status, head: (await r.text()).slice(0, 40) };
  });
  check(csv.status === 200 && csv.head.includes("Date,DealerID"), "CSV export downloads");
  check(!(await page.locator(".nav >> text=Settings").isVisible()), "viewers don't see settings");
  await page.goto(`${BASE}competitors`);
  await page.waitForSelector("tbody tr");
  check(!(await page.locator("button:has-text('+ Add competitor')").isVisible()), "viewers can't add competitors");
  await page.click("button:has-text('Sign out')");
  await page.waitForURL(/\/login/);

  console.log("Admin: add a competitor and scrape it");
  await signIn(page, "admin@demo.local");
  await page.goto(`${BASE}competitors`);
  await page.click("button:has-text('+ Add competitor')");
  await page.click(".modal button:has-text('Save')");
  await page.waitForSelector(".modal .field-error");
  check((await page.locator(".modal .field-error").count()) >= 2, "empty form shows field errors");
  await page.fill(".modal label:has-text('Dealer name') input", "Local Metro");
  check((await page.locator(".modal label:has-text('ID') input").inputValue()) === "local-metro", "ID suggested from the name");
  await page.fill(".modal label:has-text('Website') input", SITES);
  await page.fill(".modal label:has-text('Inventory page') textarea", `${SITES}/metro-motors/inventory`);
  await page.fill(".modal label:has-text('Seconds between pages') input", "1");
  await page.click(".modal button:has-text('Test first page')");
  await page.waitForSelector(".modal >> text=found on the first page");
  const found = await page.locator(".modal [role=status] strong").innerText();
  check(/Test: (\d+) cars/.test(found) && Number(found.match(/(\d+)/)[1]) > 5, `test button previews the scrape (${found})`);
  check((await page.locator(".modal [role=status] tbody tr").count()) > 0, "sample cars shown with prices");
  await page.click(".modal button:has-text('Save')");
  await page.waitForSelector("td:has-text('Local Metro')");
  check(true, "competitor saved");
  await page.locator("tr:has-text('Local Metro') button:has-text('Scrape now')").click();
  await page.waitForSelector("text=Scrape started");
  await page.goto(`${BASE}runs`);
  await page.waitForSelector("tbody tr .badge-good, tbody tr .badge-warn, tbody tr .badge-bad", { timeout: 60_000 });
  const status = await page.locator("tbody tr").first().locator(".badge").innerText();
  check(/^Done$/.test(status), `scrape finished: ${status}`);
  await page.locator("tbody tr.clickable").first().click();
  check(await page.locator("tr.sub >> text=Local Metro").isVisible(), "run details list each competitor");
  await page.goto(BASE);
  await page.waitForSelector(".recharts-line-curve");
  check((await page.locator(".legend >> text=Local Metro").count()) === 1, "new competitor appears on the dashboard");

  console.log("Admin: stock, settings, users");
  await page.goto(`${BASE}stock`);
  await page.waitForSelector("tbody tr");
  await page.setInputFiles("input[type=file]", { name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from("Stock,Price\nA,1\n") });
  await page.waitForSelector("[role=alert] >> text=missing column");
  check(true, "a malformed stock file is explained");
  await page.setInputFiles("input[type=file]", {
    name: "stock.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("﻿StockNo,Year,Make,Model,Mileage,Price\r\nA100,2022,Toyota,Corolla,30000,21500\r\nA101,2021,Honda,Civic,41000,19900\r\n"),
  });
  await page.waitForSelector("text=Stock replaced: 2 vehicles");
  check((await page.locator("tbody tr").count()) === 2, "stock replaced from an Excel CSV");

  await page.goto(`${BASE}settings`);
  await page.fill("label:has-text('Daily digest') input", "not-an-email");
  await page.click("button:has-text('Save settings')");
  await page.waitForSelector(".field-error");
  check(true, "invalid digest email rejected");
  await page.fill("label:has-text('Daily digest') input", "owner@example.com, sales@example.com");
  await page.click("button:has-text('Save settings')");
  await page.waitForSelector("text=Saved.");
  check(true, "settings saved");
  await page.click("button:has-text('+ Add user')");
  await page.fill(".modal label:has-text('Name') input", "Sales Manager");
  await page.fill(".modal label:has-text('Email') input", "sales@example.com");
  await page.fill(".modal label:has-text('Password') input", "a-strong-pass-42");
  await page.click(".modal button:has-text('Save')");
  await page.waitForSelector("text=sales@example.com");
  check(true, "viewer login created");
  await page.goto(`${BASE}audit`);
  await page.waitForSelector("tbody tr");
  const actions = (await page.locator("tbody td:nth-child(3)").allTextContents()).join(",");
  check(/Added competitor/.test(actions) && /Started scrape/.test(actions) && /Uploaded stock/.test(actions), "activity log records admin actions");

  console.log("Phone + dark");
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  const m = await mobile.newPage();
  watch(m);
  await signIn(m, "admin@demo.local");
  for (const r of ["", "competitors", "runs", "stock", "settings", "audit"]) {
    await m.goto(`${BASE}${r}`);
    await m.waitForTimeout(600);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `no page-level horizontal scroll on phone at "/${r}" (${overflow}px)`);
  }
  await m.goto(BASE);
  await m.waitForSelector(".recharts-surface");
  await m.screenshot({ path: `${SHOTS}/mobile-dark.png` });

  console.log("Server");
  const res = await fetch(`${BASE}competitors`);
  check(res.ok && (await res.text()).includes('id="root"'), "deep links serve the app");
  check(!!res.headers.get("content-security-policy"), "security headers set");
  const api404 = await fetch(`${BASE}api/nope`);
  check(api404.status === 404 && (api404.headers.get("content-type") ?? "").includes("json"), "unknown API paths are JSON 404s");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} catch (e) {
  failures++;
  console.error(e);
  if (page) {
    console.error("URL at failure:", page.url());
    await page.screenshot({ path: `${SHOTS}/failure.png`, fullPage: true }).catch(() => {});
  }
} finally {
  server.kill("SIGTERM");
  sites.kill("SIGTERM");
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
