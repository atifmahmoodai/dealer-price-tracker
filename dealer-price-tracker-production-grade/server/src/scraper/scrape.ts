import type { Listing, Snapshot } from "../../../shared/types";
import { extractListings, findNextPage, type CompetitorConfig } from "./extract";
import { ALLOW_ALL, parseRobots, type RobotsPolicy } from "./robots";

export const USER_AGENT = "DealerPriceTracker/1.0 (+https://github.com/atifmahmoodai/dealer-price-tracker)";

export interface ScrapeOptions {
  date: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retries?: number;
  log?: (msg: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchText(url: string, o: Required<Pick<ScrapeOptions, "timeoutMs" | "retries" | "sleep">> & { fetchImpl: typeof fetch }): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    try {
      const res = await o.fetchImpl(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(o.timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return await res.text();
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) break;
      if (attempt < o.retries) await o.sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function loadRobots(origin: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<RobotsPolicy> {
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404 || res.status === 410) return ALLOW_ALL;
    if (!res.ok) return { isAllowed: () => false }; // 401/403/5xx: play safe
    return parseRobots(await res.text(), USER_AGENT);
  } catch {
    return ALLOW_ALL;
  }
}

/** Scrapes every start URL of one competitor, following "next page" links, politely. */
export async function scrapeCompetitor(c: CompetitorConfig, opts: ScrapeOptions): Promise<Snapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 2;
  const log = opts.log ?? (() => {});
  const maxPages = c.maxPages ?? 20;
  const errors: string[] = [];
  const listings: Listing[] = [];
  const visited = new Set<string>();
  const robotsByOrigin = new Map<string, RobotsPolicy>();
  let pages = 0;

  for (const start of c.startUrls) {
    let url: string | undefined = start;
    while (url && pages < maxPages) {
      if (visited.has(url)) break; // pagination loop guard
      visited.add(url);
      const u = new URL(url);
      let robots = robotsByOrigin.get(u.origin);
      if (!robots) {
        robots = await loadRobots(u.origin, fetchImpl, timeoutMs);
        robotsByOrigin.set(u.origin, robots);
      }
      if (!robots.isAllowed(u.pathname + u.search)) {
        errors.push(`robots.txt disallows ${url}`);
        log(`  skip (robots.txt): ${url}`);
        break;
      }
      if (pages > 0) await sleep(Math.max(c.delayMs ?? 3000, (robots.crawlDelaySeconds ?? 0) * 1000));
      try {
        const html = await fetchText(url, { fetchImpl, timeoutMs, retries, sleep });
        pages++;
        const found = extractListings(html, url, c);
        log(`  ${url} → ${found.length} vehicles`);
        listings.push(...found);
        url = findNextPage(html, url, c.nextPage);
      } catch (e) {
        errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
        log(`  error ${url}: ${e instanceof Error ? e.message : e}`);
        break;
      }
    }
  }

  const unique = new Map(listings.map((l) => [l.key, l]));
  return { dealerId: c.id, date: opts.date, scrapedAt: new Date().toISOString(), pages, listings: [...unique.values()], errors };
}
