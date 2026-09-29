import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Public origin, e.g. https://prices.example.com. Used for links in emails and the CSRF origin check. */
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  /** smtp(s)://user:pass@host:port — when set, the daily digest is emailed to the recipients in Settings. */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Price Tracker <no-reply@localhost>"),
  /** Runs the daily scrape from this process. Turn off on extra replicas if you like (they coordinate anyway). */
  SCHEDULER: bool.default(true),
  /**
   * Lets the scraper fetch private and local network addresses. Off in production so a competitor URL
   * can't be used to reach internal services; the demo and tests turn it on for their local fake sites.
   */
  SCRAPER_ALLOW_PRIVATE: bool.default(false),
  /** Largest page the scraper will read, in megabytes. */
  SCRAPER_MAX_PAGE_MB: z.coerce.number().min(1).max(50).default(8),
  /** Set when running behind a reverse proxy / load balancer so client IPs and https are detected. */
  TRUST_PROXY: bool.default(false),
  /** Secure cookies need https. Defaults to on in production. */
  COOKIE_SECURE: bool.optional(),
  SESSION_TTL_HOURS: z.coerce.number().min(1).max(24 * 90).default(24 * 7),
  SESSION_IDLE_HOURS: z.coerce.number().min(0.25).max(24 * 30).default(12),
  /** IANA zone for the daily scrape time and snapshot dates. */
  TIMEZONE: z.string().default("UTC"),
  /** Built web app to serve; empty disables static serving (e.g. when a CDN serves it). */
  WEB_DIST: z.string().default("../web/dist"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).default(300),
});

export type Config = z.infer<typeof schema> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  const c = parsed.data;
  if (!isValidTimeZone(c.TIMEZONE)) throw new Error(`Invalid configuration:\n  TIMEZONE: unknown time zone "${c.TIMEZONE}"`);
  return { ...c, cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === "production" };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's date (YYYY-MM-DD) in the given time zone. */
/** "HH:MM" wall-clock time in the given time zone. */
export function clockIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
