/** One vehicle as advertised on a competitor's website on a given day. */
export interface Listing {
  /** Stable identity: the VIN when available, otherwise dealer + listing URL. */
  key: string;
  dealerId: string;
  url: string;
  title: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  price?: number;
  mileage?: number;
  vin?: string;
  stockNo?: string;
  condition?: "New" | "Used";
  fuel?: string;
  bodyType?: string;
  transmission?: string;
  imageUrl?: string;
}

/** Result of scraping one dealer on one day. */
export interface Snapshot {
  dealerId: string;
  /** YYYY-MM-DD */
  date: string;
  /** ISO datetime */
  scrapedAt: string;
  pages: number;
  listings: Listing[];
  errors: string[];
}

export interface DealerInfo {
  id: string;
  name: string;
  website: string;
}

export interface TrackedListing extends Listing {
  firstSeen: string;
  lastSeen: string;
  status: "active" | "removed";
  removedOn?: string;
  firstPrice?: number;
  priceChanges: number;
  daysOnSite: number;
}

export type EventType = "new" | "price_change" | "removed" | "relisted";

export interface ChangeEvent {
  date: string;
  dealerId: string;
  key: string;
  type: EventType;
  title: string;
  oldPrice?: number;
  newPrice?: number;
  delta?: number;
}

export interface DailyStat {
  date: string;
  dealerId: string;
  active: number;
  added: number;
  removed: number;
  priceChanges: number;
  medianPrice: number | null;
}

/** A vehicle in the user's own stock, compared against the market. */
export interface OwnVehicle {
  stockNo: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  price: number;
}

export interface History {
  generatedAt: string;
  dealers: DealerInfo[];
  dates: string[];
  listings: TrackedListing[];
  events: ChangeEvent[];
  daily: DailyStat[];
  ownStock: OwnVehicle[];
  /** Snapshots ignored because they looked like failed scrapes. */
  warnings: string[];
}
