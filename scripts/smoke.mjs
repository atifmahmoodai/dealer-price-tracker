// Browser smoke test of the built dashboard. Run `npm run build` first.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = 4181;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = "test-results/screenshots";
const executablePath = process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
mkdirSync(SHOTS, { recursive: true });
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failures++;
};

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({ executablePath });
  const errors = [];
  const watch = (p) => {
    p.on("pageerror", (e) => { errors.push(e.stack || e.message); console.log(`  ! ${e.stack || e.message}`); });
    p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  };

  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE);
  await page.waitForSelector(".kpi");
  const kpis = (await page.locator(".kpi-value").allTextContents()).join(" | ");
  check(!/NaN|undefined|Infinity/.test(kpis), `KPIs render cleanly: ${kpis}`);
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
  await page.click("role=tab[name='Sold / removed']");
  check((await page.locator("section.card:has-text('Competitor listings') tbody tr").count()) > 0, "sold/removed tab shows cars");
  await page.locator("details.notice summary").click();
  check(await page.locator("details.notice li").first().isVisible(), "scrape warnings are listed");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  const m = await mobile.newPage();
  watch(m);
  await m.goto(BASE);
  await m.waitForSelector(".recharts-surface");
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `no horizontal page scroll on a phone (${overflow}px)`);
  await m.screenshot({ path: `${SHOTS}/mobile-dark.png` });
  const dark = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "dark" });
  const d = await dark.newPage();
  watch(d);
  await d.goto(BASE);
  await d.waitForSelector(".recharts-surface");
  await d.screenshot({ path: `${SHOTS}/dashboard-dark.png` });

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server.kill("SIGTERM");
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
