import type { CompetitorInput } from "../../../shared/schemas";
import type { DemoDealer } from "./market";
import { renderSite } from "./sites";

/** The scraping recipe for each simulated dealer (the HTML-cards site needs CSS selectors). */
export function demoConfig(d: DemoDealer, origin: string): CompetitorInput {
  return {
    name: d.name,
    website: origin,
    startUrls: [`${origin}/inventory`],
    mode: d.format === "html-cards" ? "selectors" : "auto",
    maxPages: 20,
    delayMs: 1000,
    ...(d.format === "html-cards"
      ? {
          nextPage: "a.pagination-next",
          selectors: { card: ".vehicle-card", title: ".vehicle-title", price: ".vehicle-price", link: "a.vehicle-link@href", mileage: ".odometer", vin: ".vin", stockNo: ".stock" },
        }
      : {}),
  };
}

/**
 * A fetch() that answers from the simulated dealer websites instead of the network, so the demo
 * history is produced by the real scraper without any internet access. `origins` maps an origin
 * (e.g. https://city-autos.example) to its dealer.
 */
export function fakeWebFetch(origins: Map<string, DemoDealer>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const dealer = origins.get(url.origin);
    if (!dealer) return new Response("not found", { status: 404 });
    const body = renderSite(dealer, url.pathname + url.search, url.origin);
    if (body === null) return new Response("not found", { status: 404 });
    const type = url.pathname === "/robots.txt" ? "text/plain" : "text/html; charset=utf-8";
    return new Response(body, { status: 200, headers: { "content-type": type } });
  }) as typeof fetch;
}
