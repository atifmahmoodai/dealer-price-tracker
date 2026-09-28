import { daysBetween, median } from "./normalize";
import type { ChangeEvent, DailyStat, DealerInfo, History, Listing, OwnVehicle, Snapshot, TrackedListing } from "./types";

/**
 * A scrape that suddenly returns far fewer cars than the day before is almost
 * always a broken page, a block or a layout change, not a real sell-out. Such
 * snapshots are skipped so they don't flood the report with fake "removed" events.
 */
export const SUSPICIOUS_DROP = 0.6;
const MIN_SIZE_FOR_DROP_CHECK = 5;

export function isSuspicious(snap: Snapshot, previousCount: number | undefined): string | null {
  if (snap.listings.length === 0 && (snap.errors.length > 0 || (previousCount ?? 0) > 0)) {
    return `${snap.dealerId} ${snap.date}: no listings found${snap.errors.length ? ` (${snap.errors[0]})` : ""}, skipped`;
  }
  if (previousCount !== undefined && previousCount >= MIN_SIZE_FOR_DROP_CHECK) {
    const drop = 1 - snap.listings.length / previousCount;
    if (drop >= SUSPICIOUS_DROP) {
      return `${snap.dealerId} ${snap.date}: listings fell from ${previousCount} to ${snap.listings.length}, looks like a failed scrape, skipped`;
    }
  }
  return null;
}

/** Replays daily snapshots in date order and derives listing lifecycles and change events. */
export function buildHistory(snapshots: Snapshot[], dealers: DealerInfo[], ownStock: OwnVehicle[] = [], generatedAt = new Date().toISOString()): History {
  const byDealer = new Map<string, Snapshot[]>();
  for (const s of snapshots) byDealer.set(s.dealerId, [...(byDealer.get(s.dealerId) ?? []), s]);

  const tracked = new Map<string, TrackedListing>();
  const events: ChangeEvent[] = [];
  const daily: DailyStat[] = [];
  const warnings: string[] = [];
  const dates = new Set<string>();

  for (const [dealerId, snaps] of byDealer) {
    snaps.sort((a, b) => a.date.localeCompare(b.date));
    let previousCount: number | undefined;
    const active = new Set<string>();

    for (const snap of snaps) {
      const problem = isSuspicious(snap, previousCount);
      if (problem) {
        warnings.push(problem);
        continue;
      }
      dates.add(snap.date);
      const seen = new Map<string, Listing>();
      for (const l of snap.listings) seen.set(l.key, l); // de-duplicate within a page set
      let added = 0;
      let removed = 0;
      let priceChanges = 0;

      // If any page failed, cars missing from this snapshot may simply be on the page we couldn't load.
      const partial = snap.errors.length > 0;
      if (partial) warnings.push(`${dealerId} ${snap.date}: partial scrape (${snap.errors[0]}); removals not inferred that day`);

      for (const [key, l] of seen) {
        // The same VIN can move between dealers; key tracking by dealer keeps each dealer's story separate.
        const id = `${dealerId}|${key}`;
        const t = tracked.get(id);
        if (!t) {
          tracked.set(id, {
            ...l,
            firstSeen: snap.date,
            lastSeen: snap.date,
            status: "active",
            firstPrice: l.price,
            priceChanges: 0,
            daysOnSite: 0,
          });
          if (previousCount !== undefined) {
            // Cars present on the very first scrape aren't "new"; we just started watching.
            events.push({ date: snap.date, dealerId, key, type: "new", title: l.title, newPrice: l.price });
            added++;
          }
        } else {
          if (t.status === "removed") {
            events.push({ date: snap.date, dealerId, key, type: "relisted", title: l.title, newPrice: l.price });
            t.status = "active";
            t.removedOn = undefined;
            added++;
          }
          if (l.price !== undefined && t.price !== undefined && l.price !== t.price) {
            events.push({ date: snap.date, dealerId, key, type: "price_change", title: l.title, oldPrice: t.price, newPrice: l.price, delta: l.price - t.price });
            t.priceChanges++;
            priceChanges++;
          }
          const { firstSeen, firstPrice, priceChanges: pc } = t;
          Object.assign(t, l, { firstSeen, firstPrice: firstPrice ?? l.price, priceChanges: pc, lastSeen: snap.date, status: "active" as const });
        }
        active.add(id);
      }

      for (const id of partial ? [] : [...active]) {
        if (seen.has(id.slice(dealerId.length + 1))) continue;
        const t = tracked.get(id)!;
        t.status = "removed";
        t.removedOn = snap.date;
        active.delete(id);
        events.push({ date: snap.date, dealerId, key: t.key, type: "removed", title: t.title, oldPrice: t.price });
        removed++;
      }

      const prices = [...seen.values()].map((l) => l.price).filter((p): p is number => p !== undefined);
      daily.push({ date: snap.date, dealerId, active: seen.size, added, removed, priceChanges, medianPrice: median(prices) });
      // A partial scrape under-counts; keep the last full count as the baseline for the drop check.
      if (!partial) previousCount = seen.size;
    }
  }

  const listings = [...tracked.values()].map((t) => ({
    ...t,
    daysOnSite: daysBetween(t.firstSeen, t.removedOn ?? t.lastSeen),
  }));

  return {
    generatedAt,
    dealers,
    dates: [...dates].sort(),
    listings,
    events: events.sort((a, b) => b.date.localeCompare(a.date) || a.dealerId.localeCompare(b.dealerId)),
    daily: daily.sort((a, b) => a.date.localeCompare(b.date) || a.dealerId.localeCompare(b.dealerId)),
    ownStock,
    warnings,
  };
}

export interface MarketComparison {
  vehicle: OwnVehicle;
  comps: TrackedListing[];
  marketMedian: number | null;
  /** (your price − market median) ÷ market median */
  position: number | null;
}

/** Comparable = same make & model, model year within ±1, mileage within ±25k, still advertised, with a price. */
export function compareToMarket(own: OwnVehicle, listings: TrackedListing[], yearTol = 1, mileageTol = 25_000): MarketComparison {
  const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const comps = listings.filter(
    (l) =>
      l.status === "active" &&
      l.price !== undefined &&
      norm(l.make) === norm(own.make) &&
      norm(l.model) === norm(own.model) &&
      l.year !== undefined &&
      Math.abs(l.year - own.year) <= yearTol &&
      (l.mileage === undefined || Math.abs(l.mileage - own.mileage) <= mileageTol),
  );
  const m = median(comps.map((c) => c.price!));
  return { vehicle: own, comps, marketMedian: m, position: m ? (own.price - m) / m : null };
}
