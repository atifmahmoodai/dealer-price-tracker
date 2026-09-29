import { z } from "zod";

// Input rules shared by the API (enforced) and the web app (early feedback).

const text = (max: number) => z.string().trim().max(max);

/** admin: competitors, runs, stock, settings, users. viewer: dashboard and exports. */
export const ROLES = ["admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });

export const passwordSchema = z
  .string()
  .min(10, "At least 10 characters")
  .max(200)
  .refine((p) => /[a-z]/i.test(p) && /\d/.test(p), "Use letters and at least one number");
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });

export const userCreateSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), name: text(120).min(2), role: z.enum(ROLES), password: passwordSchema });
export const userUpdateSchema = z.object({ name: text(120).min(2), role: z.enum(ROLES), active: z.boolean() });
export const resetPasswordSchema = z.object({ password: passwordSchema });

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

const webUrl = z
  .string()
  .trim()
  .max(500)
  .url("Enter a full address starting with https://")
  .refine((u) => {
    // zod runs refinements even when .url() already failed, so this must not throw on bad input.
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false;
    }
  }, "Only http and https addresses");
const selector = text(200);

export const selectorsSchema = z.object({
  card: selector.min(1, "Required"),
  title: selector.min(1, "Required"),
  price: selector.min(1, "Required"),
  link: selector.optional(),
  mileage: selector.optional(),
  vin: selector.optional(),
  stockNo: selector.optional(),
  year: selector.optional(),
  image: selector.optional(),
});

/** How to scrape one competitor. */
export const competitorConfigSchema = z
  .object({
    name: text(120).min(2, "Enter the dealer's name"),
    website: webUrl,
    startUrls: z.array(webUrl).min(1, "Add at least one inventory page").max(10),
    mode: z.enum(["auto", "jsonld", "selectors"]).default("auto"),
    selectors: selectorsSchema.optional(),
    nextPage: selector.optional(),
    maxPages: z.number().int().min(1).max(100).default(20),
    /** Politeness: at least a second between requests to the same site. */
    delayMs: z.number().int().min(1000, "At least 1000 ms (1 second)").max(60_000).default(3000),
  })
  .refine((c) => c.mode !== "selectors" || c.selectors, { message: "Selectors mode needs the card, title and price selectors", path: ["selectors"] });
export type CompetitorInput = z.infer<typeof competitorConfigSchema>;

export const competitorCreateSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "2–40 lowercase letters, digits and dashes"),
  active: z.boolean().default(true),
  config: competitorConfigSchema,
});
export const competitorUpdateSchema = z.object({ active: z.boolean(), config: competitorConfigSchema });

export const settingsSchema = z.object({
  companyName: text(120).min(1),
  currency: z.string().regex(/^[A-Z]{3}$/, "3-letter code like USD"),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Like en-US"),
  /** Daily scrape on/off and the local time it runs (server TIMEZONE). */
  scheduleEnabled: z.boolean(),
  scrapeTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour"),
  /** Daily digest recipients. */
  alertEmails: z.array(z.string().trim().toLowerCase().email()).max(10),
  /** Days of history the dashboard replays. */
  historyDays: z.number().int().min(14).max(730),
});
export type Settings = z.infer<typeof settingsSchema>;

export const stockUploadSchema = z.object({ csv: z.string().max(2_000_000) });

export type RunStatus = "running" | "done" | "failed";
export interface RunResult {
  competitorId: string;
  name: string;
  listings: number;
  pages: number;
  errors: string[];
  ms: number;
}
export interface Run {
  id: number;
  trigger: "schedule" | "manual";
  requestedBy: string | null;
  status: RunStatus;
  forDate: string;
  startedAt: string;
  finishedAt: string | null;
  results: RunResult[];
  error: string | null;
}

export interface Meta {
  timeZone: string;
  settings: Settings;
  running: Run | null;
}
