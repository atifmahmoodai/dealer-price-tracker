import type { DemoCar, DemoDealer } from "./market";

// Renders a demo dealer's stock as a website in one of three common shapes.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const title = (c: DemoCar) => `${c.year} ${c.make} ${c.model} ${c.trim}`;

function page(head: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inventory</title>${head}</head><body>${body}</body></html>`;
}

function carJson(c: DemoCar, base: string, asProduct = false) {
  return {
    "@type": asProduct ? "Product" : "Car",
    name: title(c),
    url: `${base}/vehicle/${c.stockNo}?utm_source=listing`,
    brand: { "@type": "Brand", name: c.make },
    model: c.model,
    vehicleConfiguration: c.trim,
    vehicleModelDate: String(c.year),
    mileageFromOdometer: { "@type": "QuantitativeValue", value: c.mileage, unitCode: "SMI" },
    vehicleIdentificationNumber: c.vin,
    sku: c.stockNo,
    fuelType: c.fuel,
    bodyType: c.body,
    vehicleTransmission: c.transmission,
    itemCondition: c.mileage < 100 ? "https://schema.org/NewCondition" : "https://schema.org/UsedCondition",
    offers: { "@type": "Offer", price: c.price, priceCurrency: "USD", availability: "https://schema.org/InStock" },
  };
}

/** Returns the HTML for `path` on this dealer's fake site, or null for 404. */
export function renderSite(d: DemoDealer, path: string, base: string): string | null {
  const url = new URL(path, base);
  const prefix = new URL(base).pathname.replace(/\/$/, ""); // e.g. "/city-autos" on the shared demo server
  if (url.pathname === "/robots.txt") return "User-agent: *\nDisallow: /admin\nCrawl-delay: 0\n";
  const pageNo = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const perPage = d.format === "jsonld-graph" ? 1000 : 12;
  const cars = d.cars.slice((pageNo - 1) * perPage, pageNo * perPage);
  const hasNext = pageNo * perPage < d.cars.length;
  if (url.pathname !== "/inventory") return null;

  if (d.format === "jsonld-itemlist") {
    const ld = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: cars.map((c, i) => ({ "@type": "ListItem", position: i + 1, item: carJson(c, base) })),
    };
    const next = hasNext ? `<link rel="next" href="${prefix}/inventory?page=${pageNo + 1}">` : "";
    const cards = cars.map((c) => `<article><h2>${esc(title(c))}</h2><p>${money(c.price)}</p></article>`).join("");
    return page(`<script type="application/ld+json">${JSON.stringify(ld)}</script>${next}`, cards);
  }

  if (d.format === "jsonld-graph") {
    const ld = { "@context": "https://schema.org", "@graph": [{ "@type": "AutoDealer", name: d.name }, ...cars.map((c) => carJson(c, base, true))] };
    // A malformed block next to the good one, as real sites sometimes have.
    return page(`<script type="application/ld+json">{ broken json </script><script type="application/ld+json">${JSON.stringify(ld)}</script>`, "<h1>Stock</h1>");
  }

  // Plain HTML cards, no structured data: needs CSS selectors.
  const cards = cars
    .map(
      (c) => `<div class="vehicle-card">
  <a class="vehicle-link" href="${prefix}/cars/${c.stockNo}?ref=grid"><h3 class="vehicle-title">${esc(title(c))}</h3></a>
  <span class="vehicle-price">${money(c.price)}</span>
  <ul class="specs"><li class="odometer">${c.mileage.toLocaleString("en-US")} mi</li><li class="stock">Stock #: ${c.stockNo}</li><li class="vin">VIN: ${c.vin}</li></ul>
</div>`,
    )
    .join("\n");
  const next = hasNext ? `<a class="pagination-next" href="?page=${pageNo + 1}">Next</a>` : "";
  return page("", `<main>${cards}</main><nav>${next}</nav>`);
}
