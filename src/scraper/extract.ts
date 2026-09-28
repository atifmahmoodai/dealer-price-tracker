import * as cheerio from "cheerio";
import { canonicalMake, canonicalUrl, listingKey, parseMileage, parsePrice, parseTitle, parseVin, parseYear } from "../core/normalize";
import type { Listing } from "../core/types";

export interface SelectorConfig {
  /** One element per vehicle card. */
  card: string;
  title: string;
  price: string;
  /** Link to the vehicle page; "a@href" style (defaults to the first link in the card). */
  link?: string;
  mileage?: string;
  vin?: string;
  stockNo?: string;
  year?: string;
  image?: string;
}

export interface CompetitorConfig {
  id: string;
  name: string;
  website: string;
  startUrls: string[];
  /** "auto" tries schema.org JSON-LD first, then selectors. */
  mode?: "auto" | "jsonld" | "selectors";
  selectors?: SelectorConfig;
  /** Selector for the "next page" link. */
  nextPage?: string;
  maxPages?: number;
  /** Delay between requests to this site in ms, default 3000 (robots.txt Crawl-delay wins if larger). */
  delayMs?: number;
}

type Json = Record<string, unknown>;

const VEHICLE_TYPES = new Set(["car", "vehicle", "motorvehicle", "busorcoach", "motorcycle"]);

function types(node: Json): string[] {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : t ? [t] : [];
  return list.map((x) => String(x).toLowerCase().replace(/^.*[/#]/, ""));
}

function text(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "name" in v) return text((v as Json).name);
  return undefined;
}

/** Walks any JSON-LD shape (@graph, arrays, ItemList, nested offers) and yields vehicle-like nodes. */
function* vehicleNodes(node: unknown, depth = 0): Generator<Json> {
  if (depth > 8 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) yield* vehicleNodes(n, depth + 1);
    return;
  }
  const obj = node as Json;
  const ts = types(obj);
  const looksLikeVehicle =
    ts.some((t) => VEHICLE_TYPES.has(t)) ||
    (ts.includes("product") && ("vehicleIdentificationNumber" in obj || "mileageFromOdometer" in obj || "vehicleModelDate" in obj));
  if (looksLikeVehicle) {
    yield obj;
    return;
  }
  for (const key of ["@graph", "itemListElement", "item", "mainEntity", "about", "offers"]) {
    if (key in obj) yield* vehicleNodes(obj[key], depth + 1);
  }
}

function offerPrice(offers: unknown): number | undefined {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const x = o as Json;
    const p = parsePrice(x.price ?? x.lowPrice ?? (x.priceSpecification as Json | undefined)?.price);
    if (p !== undefined) return p;
  }
  return undefined;
}

function buildListing(dealerId: string, pageUrl: string, f: Partial<Listing> & { title: string; href?: string }): Listing {
  const url = canonicalUrl(f.href ?? pageUrl, pageUrl);
  const fromTitle = parseTitle(f.title);
  const vin = f.vin;
  return {
    key: listingKey(dealerId, vin, url),
    dealerId,
    url,
    title: f.title.replace(/\s+/g, " ").trim(),
    year: f.year ?? fromTitle.year,
    make: f.make ? canonicalMake(f.make) : fromTitle.make,
    model: f.model ?? fromTitle.model,
    trim: f.trim ?? fromTitle.trim,
    price: f.price,
    mileage: f.mileage,
    vin,
    stockNo: f.stockNo,
    condition: f.condition,
    fuel: f.fuel,
    bodyType: f.bodyType,
    transmission: f.transmission,
    imageUrl: f.imageUrl ? canonicalUrl(f.imageUrl, pageUrl) : undefined,
  };
}

export function extractJsonLd(html: string, pageUrl: string, dealerId: string): Listing[] {
  const $ = cheerio.load(html);
  const out: Listing[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: unknown;
    try {
      data = JSON.parse($(el).text());
    } catch {
      return; // one broken block shouldn't stop the others
    }
    for (const v of vehicleNodes(data)) {
      const brand = text(v.brand) ?? text(v.manufacturer);
      const model = text(v.model);
      const year = parseYear(v.vehicleModelDate ?? v.modelDate ?? v.productionDate ?? v.releaseDate);
      const title = text(v.name) ?? [year, brand, model].filter(Boolean).join(" ");
      if (!title) continue;
      const odo = v.mileageFromOdometer as Json | string | number | undefined;
      const cond = String((v.itemCondition ?? (v.offers as Json | undefined)?.itemCondition) ?? "").toLowerCase();
      const image = Array.isArray(v.image) ? v.image[0] : v.image;
      out.push(
        buildListing(dealerId, pageUrl, {
          title,
          href: text(v.url) ?? text((v.offers as Json | undefined)?.url),
          year,
          make: brand,
          model,
          trim: text(v.vehicleConfiguration),
          price: offerPrice(v.offers),
          mileage: parseMileage(typeof odo === "object" && odo ? odo.value : odo),
          vin: parseVin(text(v.vehicleIdentificationNumber)),
          stockNo: text(v.sku) ?? text(v.productID),
          condition: cond.includes("new") ? "New" : cond.includes("used") ? "Used" : undefined,
          fuel: text(v.fuelType),
          bodyType: text(v.bodyType),
          transmission: text(v.vehicleTransmission),
          imageUrl: typeof image === "string" ? image : text((image as Json | undefined)?.url),
        }),
      );
    }
  });
  return out;
}

/** "a.title@href" → element + attribute; plain selector → text. */
function pick($card: cheerio.Cheerio<any>, spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const [sel, attr] = spec.split("@");
  const el = sel.trim() ? $card.find(sel.trim()).first() : $card;
  if (!el.length) return undefined;
  const v = attr ? el.attr(attr.trim()) : el.text();
  return v?.replace(/\s+/g, " ").trim() || undefined;
}

export function extractWithSelectors(html: string, pageUrl: string, dealerId: string, sel: SelectorConfig): Listing[] {
  const $ = cheerio.load(html);
  const out: Listing[] = [];
  $(sel.card).each((_, el) => {
    const card = $(el);
    const title = pick(card, sel.title);
    if (!title) return;
    const vinText = pick(card, sel.vin);
    out.push(
      buildListing(dealerId, pageUrl, {
        title,
        href: pick(card, sel.link ?? "a@href"),
        price: parsePrice(pick(card, sel.price)),
        mileage: parseMileage(pick(card, sel.mileage)),
        vin: parseVin(vinText),
        stockNo: pick(card, sel.stockNo)?.replace(/^stock\s*(no\.?|#)?\s*:?\s*/i, ""),
        year: parseYear(pick(card, sel.year)),
        imageUrl: pick(card, sel.image),
      }),
    );
  });
  return out;
}

export function findNextPage(html: string, pageUrl: string, selector = 'link[rel="next"], a[rel="next"]'): string | undefined {
  const $ = cheerio.load(html);
  const href = $(selector).first().attr("href");
  return href ? canonicalUrl(href, pageUrl) : undefined;
}

export function extractListings(html: string, pageUrl: string, c: CompetitorConfig): Listing[] {
  const mode = c.mode ?? "auto";
  if (mode !== "selectors") {
    const fromLd = extractJsonLd(html, pageUrl, c.id);
    if (fromLd.length || mode === "jsonld") return fromLd;
  }
  return c.selectors ? extractWithSelectors(html, pageUrl, c.id, c.selectors) : [];
}
