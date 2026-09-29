import type { Settings } from "./schemas";

// Kept apart from schemas.ts so the web app can use it without bundling zod.
export const DEFAULT_SETTINGS: Settings = {
  companyName: "My Dealership",
  currency: "USD",
  locale: "en-US",
  scheduleEnabled: true,
  scrapeTime: "06:00",
  alertEmails: [],
  historyDays: 180,
};
