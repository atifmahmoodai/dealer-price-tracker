// Turns the messy text found on dealer websites into clean numbers and fields.

const MAKES = [
  "Alfa Romeo", "Aston Martin", "Land Rover", "Mercedes-Benz", "Mercedes", "Rolls-Royce",
  "Acura", "Audi", "BMW", "BYD", "Buick", "Cadillac", "Changan", "Chevrolet", "Chery", "Chrysler", "Citroen",
  "Dodge", "Ferrari", "Fiat", "Ford", "Genesis", "GMC", "Haval", "Honda", "Hyundai", "Infiniti", "Isuzu",
  "Jaguar", "Jeep", "Kia", "Lamborghini", "Lexus", "Lincoln", "Mazda", "MG", "Mini", "Mitsubishi", "Nissan",
  "Peugeot", "Porsche", "Proton", "Ram", "Renault", "Skoda", "Subaru", "Suzuki", "Tesla", "Toyota",
  "Volkswagen", "VW", "Volvo",
];

/**
 * "$23,995" → 23995, "PKR 4,250,000" → 4250000, "AED 89,500.00" → 89500,
 * "£12.5k" → 12500. Returns undefined for "Call for price" and similar.
 */
export function parsePrice(input: unknown): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? Math.round(input) : undefined;
  if (typeof input !== "string") return undefined;
  const s = input.replace(/ /g, " ").trim();
  const m = s.match(/(\d[\d,.]*)\s*([kKmM])?\b/);
  if (!m) return undefined;
  let digits = m[1].replace(/,/g, "");
  const suffix = m[2]?.toLowerCase();
  // "1.250.000" and "12.500" (European style) use dots as thousands separators; no car costs 12.5.
  if (/^\d+\.\d{3}(\.\d{3})+$/.test(digits) || (!suffix && /^\d{1,3}\.\d{3}$/.test(digits))) digits = digits.replace(/\./g, "");
  let n = Number(digits);
  if (!Number.isFinite(n)) return undefined;
  if (suffix === "k") n *= 1_000;
  if (suffix === "m") n *= 1_000_000;
  return n > 0 ? Math.round(n) : undefined;
}

/** "45,210 mi" → 45210, "72k km" → 72000, "New" → undefined. */
export function parseMileage(input: unknown): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.round(input) : undefined;
  if (typeof input !== "string") return undefined;
  const m = input.replace(/ /g, " ").match(/(\d[\d,.]*)\s*([kK])?/);
  if (!m) return undefined;
  let digits = m[1].replace(/,/g, "");
  // "45.210 km" (European thousands separator) is 45,210, not 45.
  if (/^\d{1,3}(\.\d{3})+$/.test(digits) && !m[2]) digits = digits.replace(/\./g, "");
  let n = Number(digits);
  if (!Number.isFinite(n)) return undefined;
  if (m[2]) n *= 1000;
  return Math.round(n);
}

export function parseYear(input: unknown): number | undefined {
  const s = typeof input === "number" ? String(input) : typeof input === "string" ? input : "";
  const m = s.match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  return m ? Number(m[1]) : undefined;
}

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;

export function parseVin(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const m = input.toUpperCase().match(VIN_RE);
  return m ? m[0] : undefined;
}

export function canonicalMake(make: string): string {
  const lower = make.toLowerCase();
  if (lower === "vw") return "Volkswagen";
  if (lower === "mercedes") return "Mercedes-Benz";
  const hit = MAKES.find((m) => m.toLowerCase() === lower);
  return hit ?? make.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "2021 Toyota Corolla LE Hybrid" → { year: 2021, make: "Toyota", model: "Corolla", trim: "LE Hybrid" }. */
export function parseTitle(title: string): { year?: number; make?: string; model?: string; trim?: string } {
  const clean = title.replace(/\s+/g, " ").trim();
  const year = parseYear(clean);
  const rest = year ? clean.replace(String(year), "").trim() : clean;
  const lower = rest.toLowerCase();
  // Longest make first so "Land Rover" wins over nothing and "Mercedes-Benz" over "Mercedes".
  const make = [...MAKES].sort((a, b) => b.length - a.length).find((m) => lower.startsWith(m.toLowerCase() + " ") || lower === m.toLowerCase());
  if (!make) return { year };
  const after = rest.slice(make.length).trim().split(" ");
  return {
    year,
    make: canonicalMake(make),
    model: after[0] || undefined,
    trim: after.slice(1).join(" ") || undefined,
  };
}

/** Absolute URL without tracking query strings or fragments, for a stable identity. */
export function canonicalUrl(href: string, base: string): string {
  try {
    const u = new URL(href, base);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(p)) u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return href;
  }
}

export function listingKey(dealerId: string, vin: string | undefined, url: string): string {
  return vin ? `vin:${vin}` : `${dealerId}:${url}`;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const DAY = 86_400_000;
export const parseDay = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const daysBetween = (a: string, b: string) => Math.round((parseDay(b) - parseDay(a)) / DAY);
export const addDays = (d: string, n: number) => new Date(parseDay(d) + n * DAY).toISOString().slice(0, 10);
