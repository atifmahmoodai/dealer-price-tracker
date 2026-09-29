// Simulates three competitor dealerships whose stock changes day by day.

export interface DemoCar {
  vin: string;
  stockNo: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  price: number;
  fuel: string;
  body: string;
  transmission: string;
  listedOn: string;
}

export interface DemoDealer {
  id: string;
  name: string;
  /** How the fake website publishes its stock. */
  format: "jsonld-itemlist" | "html-cards" | "jsonld-graph";
  targetStock: number;
  /** Price level relative to market (1.05 = 5% above). */
  pricing: number;
  cars: DemoCar[];
  sold: number;
}

const MODELS: [string, string, string[], number, string, string][] = [
  ["Toyota", "Corolla", ["LE", "SE", "XSE"], 24000, "Sedan", "Petrol"],
  ["Toyota", "RAV4", ["LE", "XLE"], 32000, "SUV", "Hybrid"],
  ["Toyota", "Camry", ["LE", "SE"], 29000, "Sedan", "Petrol"],
  ["Honda", "Civic", ["LX", "Sport", "EX"], 25000, "Sedan", "Petrol"],
  ["Honda", "CR-V", ["EX", "Touring"], 33000, "SUV", "Petrol"],
  ["Hyundai", "Tucson", ["SE", "SEL"], 30000, "SUV", "Petrol"],
  ["Hyundai", "Elantra", ["SE", "SEL"], 22000, "Sedan", "Petrol"],
  ["Kia", "Sportage", ["LX", "EX"], 29000, "SUV", "Petrol"],
  ["Ford", "F-150", ["XL", "XLT", "Lariat"], 45000, "Pickup", "Petrol"],
  ["Ford", "Escape", ["S", "SE"], 28000, "SUV", "Petrol"],
  ["Nissan", "Rogue", ["S", "SV"], 29000, "SUV", "Petrol"],
  ["Mazda", "CX-5", ["Sport", "Touring"], 30000, "SUV", "Petrol"],
  ["Tesla", "Model 3", ["RWD", "Long Range"], 40000, "Sedan", "Electric"],
  ["BMW", "3 Series", ["330i", "M340i"], 45000, "Sedan", "Petrol"],
  ["Chevrolet", "Silverado", ["LT", "RST"], 44000, "Pickup", "Petrol"],
];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VIN_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

export function createMarket(seed = 7, startDate = "2026-08-01") {
  const r = rng(seed);
  const int = (a: number, b: number) => Math.floor(r() * (b - a + 1)) + a;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  let serial = 1;

  const dealers: DemoDealer[] = [
    { id: "metro-motors", name: "Metro Motors", format: "jsonld-itemlist", targetStock: 38, pricing: 1.03, cars: [], sold: 0 },
    { id: "city-autos", name: "City Autos", format: "html-cards", targetStock: 28, pricing: 0.97, cars: [], sold: 0 },
    { id: "prime-cars", name: "Prime Cars", format: "jsonld-graph", targetStock: 22, pricing: 1.0, cars: [], sold: 0 },
  ];

  function fairPrice(base: number, year: number, mileage: number, trimIdx: number, refYear: number): number {
    const age = Math.max(0, refYear - year);
    return base * (1 + trimIdx * 0.07) * Math.pow(0.87, age) * (1 - Math.min(0.25, mileage / 500_000));
  }

  function newCar(d: DemoDealer, date: string): DemoCar {
    const [make, model, trims, base, body, fuel] = pick(MODELS);
    const refYear = Number(date.slice(0, 4));
    const year = refYear - int(0, 7);
    const mileage = year === refYear ? int(5, 40) : (refYear - year) * int(8000, 15000) + int(0, 5000);
    const trimIdx = int(0, trims.length - 1);
    let vin = "";
    for (let i = 0; i < 17; i++) vin += VIN_CHARS[int(0, VIN_CHARS.length - 1)];
    const price = Math.round((fairPrice(base, year, mileage, trimIdx, refYear) * d.pricing * (0.94 + r() * 0.12)) / 100) * 100 - 5;
    return {
      vin,
      stockNo: `${d.id.slice(0, 2).toUpperCase()}${1000 + serial++}`,
      year, make, model, trim: trims[trimIdx], mileage, price,
      fuel, body, transmission: r() < 0.9 ? "Automatic" : "Manual", listedOn: date,
    };
  }

  for (const d of dealers) for (let i = 0; i < d.targetStock; i++) d.cars.push(newCar(d, startDate));

  /** Advances one day: some cars sell (cheaper ones faster), stale ones get discounted, new stock arrives. */
  function step(date: string) {
    for (const d of dealers) {
      d.cars = d.cars.filter((c) => {
        const ageDays = (Date.parse(date) - Date.parse(c.listedOn)) / 86_400_000;
        const sellChance = 0.035 / d.pricing ** 4 + (ageDays > 45 ? 0.01 : 0);
        if (r() < sellChance) {
          d.sold++;
          return false;
        }
        return true;
      });
      for (const c of d.cars) {
        const ageDays = (Date.parse(date) - Date.parse(c.listedOn)) / 86_400_000;
        if (ageDays > 21 && r() < 0.035) c.price = Math.round((c.price * (0.94 + r() * 0.03)) / 100) * 100 - 5;
      }
      while (d.cars.length < d.targetStock && r() < 0.75) d.cars.push(newCar(d, date));
    }
  }

  /** The user's own stock for the market-comparison view. */
  function ownStock(date: string, count = 14) {
    const me: DemoDealer = { id: "me", name: "My dealership", format: "html-cards", targetStock: count, pricing: 1.0, cars: [], sold: 0 };
    return Array.from({ length: count }, () => {
      const c = newCar(me, date);
      // Make a few deliberately over- and under-priced to give the comparison something to show.
      const tweak = r() < 0.25 ? 1.12 : r() < 0.2 ? 0.9 : 1;
      return { stockNo: `MY${c.stockNo.slice(2)}`, year: c.year, make: c.make, model: c.model, mileage: c.mileage, price: Math.round((c.price * tweak) / 100) * 100 };
    });
  }

  return { dealers, step, ownStock };
}
