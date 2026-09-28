import { Fragment, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compareToMarket } from "../core/history";
import { addDays, median } from "../core/normalize";
import type { ChangeEvent, History } from "../core/types";
import { fmtDate, fmtMoney, fmtNum, fmtPct } from "./format";

// Categorical slots 1–3 of the validated palette; colour is fixed per dealer (not per rank).
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];

const PERIODS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 0, label: "All history" },
];

type EventFilter = "all" | ChangeEvent["type"];

const axis = { stroke: "var(--grid)", tick: { fill: "var(--muted)", fontSize: 12 }, tickLine: false };
const tip = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 13 },
  labelStyle: { color: "var(--text)", fontWeight: 700 },
};

export function App() {
  const [h, setH] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("./data/history.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<History>;
      })
      .then(setH)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <div className="wrap">
        <div className="card">
          <h1>No data yet</h1>
          <p className="muted">
            Couldn't load <code>data/history.json</code> ({error}). Run <code>npm run demo</code> for sample data, or <code>npm run scrape</code> with your
            competitors configured.
          </p>
        </div>
      </div>
    );
  }
  if (!h) return <div className="wrap muted">Loading…</div>;
  if (!h.dates.length) {
    return (
      <div className="wrap">
        <div className="card">
          <h1>No snapshots yet</h1>
          <p className="muted">Run a scrape first.</p>
        </div>
      </div>
    );
  }
  return <Dashboard h={h} />;
}

function Dashboard({ h }: { h: History }) {
  const [period, setPeriod] = useState(30);
  const [dealer, setDealer] = useState("all");
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [status, setStatus] = useState<"active" | "removed">("active");
  const [q, setQ] = useState("");
  const [openStock, setOpenStock] = useState<string | null>(null);

  const last = h.dates[h.dates.length - 1];
  const from = period ? addDays(last, -(period - 1)) : h.dates[0];
  const inPeriod = (d: string) => d >= from && d <= last;
  const dealerOk = (id: string) => dealer === "all" || id === dealer;
  const dealerName = useMemo(() => new Map(h.dealers.map((d) => [d.id, d.name])), [h.dealers]);
  const colorOf = (id: string) => SERIES[Math.max(0, h.dealers.findIndex((d) => d.id === id)) % SERIES.length];

  const events = useMemo(() => h.events.filter((e) => inPeriod(e.date) && dealerOk(e.dealerId)), [h.events, from, last, dealer]);
  const active = useMemo(() => h.listings.filter((l) => l.status === "active" && dealerOk(l.dealerId)), [h.listings, dealer]);
  const cuts = events.filter((e) => e.type === "price_change" && (e.delta ?? 0) < 0);
  const removed = events.filter((e) => e.type === "removed");
  const removedListings = h.listings.filter((l) => l.status === "removed" && l.removedOn && inPeriod(l.removedOn) && dealerOk(l.dealerId));
  const avgCutPct = cuts.length ? cuts.reduce((s, e) => s + (e.delta ?? 0) / (e.oldPrice ?? 1), 0) / cuts.length : null;

  const comparisons = useMemo(
    () =>
      h.ownStock
        .map((v) => compareToMarket(v, h.listings))
        .sort((a, b) => (b.position ?? -Infinity) - (a.position ?? -Infinity)),
    [h.ownStock, h.listings],
  );
  const overpriced = comparisons.filter((c) => (c.position ?? 0) > 0.05).length;

  // One row per date with a column per dealer, for the multi-line chart.
  const trend = useMemo(() => {
    const rows = new Map<string, Record<string, number | string>>();
    for (const d of h.daily) {
      if (!inPeriod(d.date)) continue;
      const row = rows.get(d.date) ?? { date: d.date, label: fmtDate(d.date) };
      row[d.dealerId] = d.active;
      rows.set(d.date, row);
    }
    return [...rows.values()];
  }, [h.daily, from, last]);
  const shownDealers = h.dealers.filter((d) => dealerOk(d.id));

  const daysByDealer = shownDealers.map((d) => {
    const ls = removedListings.filter((l) => l.dealerId === d.id);
    return { id: d.id, name: d.name, median: median(ls.map((l) => l.daysOnSite)) ?? 0, count: ls.length };
  });

  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const table = h.listings
    .filter((l) => l.status === status && dealerOk(l.dealerId))
    .filter((l) => tokens.every((t) => `${l.title} ${l.vin ?? ""} ${l.stockNo ?? ""}`.toLowerCase().includes(t)))
    .sort((a, b) => b.daysOnSite - a.daysOnSite);

  const shownEvents = events.filter((e) => eventFilter === "all" || e.type === eventFilter);

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>Competitor price tracker</h1>
          <p className="muted small">
            {h.dealers.length} competitors · snapshots {fmtDate(h.dates[0])} – {fmtDate(last)} · updated {new Date(h.generatedAt).toLocaleString("en-US")}
          </p>
        </div>
        <div className="filters" role="group" aria-label="Filters">
          <label>
            Period
            <select value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
              {PERIODS.map((p) => (
                <option key={p.days} value={p.days}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Competitor
            <select value={dealer} onChange={(e) => setDealer(e.target.value)}>
              <option value="all">All competitors</option>
              {h.dealers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {h.warnings.length > 0 && (
        <details className="notice">
          <summary>
            ⚠ {h.warnings.length} scrape{h.warnings.length > 1 ? "s" : ""} looked incomplete and {h.warnings.length > 1 ? "were" : "was"} handled safely
          </summary>
          <ul>
            {h.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      <section className="kpis">
        <Kpi label="Cars listed now" value={fmtNum(active.length)} sub={`${fmtMoney(median(active.map((l) => l.price ?? NaN).filter(Number.isFinite)))} median price`} />
        <Kpi label="New listings" value={fmtNum(events.filter((e) => e.type === "new" || e.type === "relisted").length)} sub="added in period" />
        <Kpi label="Sold / removed" value={fmtNum(removed.length)} sub="left their website" />
        <Kpi label="Price cuts" value={fmtNum(cuts.length)} sub={avgCutPct === null ? "none" : `${fmtPct(avgCutPct)} average cut`} />
        <Kpi label="Median days on site" value={fmtNum(median(removedListings.map((l) => l.daysOnSite)))} sub="for cars that sold in period" />
        <Kpi
          label="Your cars above market"
          value={h.ownStock.length ? fmtNum(overpriced) : "—"}
          sub={h.ownStock.length ? `of ${h.ownStock.length} (more than 5% over)` : "add config/my-inventory.csv"}
          tone={overpriced > 0 ? "warn" : undefined}
        />
      </section>

      <section className="grid2">
        <div className="card">
          <h2>Cars listed per competitor</h2>
          <div className="legend">
            {shownDealers.map((d) => (
              <span key={d.id}>
                <i className="swatch" style={{ background: colorOf(d.id) }} />
                {d.name} <strong>{fmtNum(h.daily.filter((x) => x.dealerId === d.id).at(-1)?.active)}</strong>
              </span>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={trend} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="label" {...axis} minTickGap={24} />
              <YAxis {...axis} axisLine={false} allowDecimals={false} />
              <Tooltip {...tip} />
              {shownDealers.map((d) => (
                <Line key={d.id} dataKey={d.id} name={d.name} stroke={colorOf(d.id)} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h2>How fast their cars sell</h2>
          <p className="muted small">Median days on site before removal, for cars removed in the period</p>
          <ResponsiveContainer width="100%" height={236}>
            <BarChart data={daysByDealer} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }}>
              <CartesianGrid horizontal={false} stroke="var(--grid)" />
              <XAxis type="number" {...axis} allowDecimals={false} />
              <YAxis type="category" dataKey="name" {...axis} axisLine={false} width={100} />
              <Tooltip {...tip} formatter={(v, _n, p) => [`${v} days (${(p.payload as { count: number }).count} cars)`, "Median"]} />
              <Bar dataKey="median" fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={26} isAnimationActive={false} label={{ position: "right", fill: "var(--text-2)", fontSize: 12 }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {h.ownStock.length > 0 && (
        <section className="card">
          <h2>Your stock vs the market</h2>
          <p className="muted small">
            Comparable = same make and model, ±1 model year, ±25,000 miles, currently listed by a competitor. Click a row to see the comparables.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stock</th>
                  <th>Vehicle</th>
                  <th className="r">Your price</th>
                  <th className="r">Market median</th>
                  <th className="r">Comps</th>
                  <th>Position</th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((c) => {
                  const pos = c.position;
                  const open = openStock === c.vehicle.stockNo;
                  return (
                    <Fragment key={c.vehicle.stockNo}>
                      <tr className="clickable" onClick={() => setOpenStock(open ? null : c.vehicle.stockNo)} aria-expanded={open}>
                        <td>{c.vehicle.stockNo}</td>
                        <td>
                          {c.vehicle.year} {c.vehicle.make} {c.vehicle.model} <span className="muted small">· {fmtNum(c.vehicle.mileage)} mi</span>
                        </td>
                        <td className="r">{fmtMoney(c.vehicle.price)}</td>
                        <td className="r">{fmtMoney(c.marketMedian)}</td>
                        <td className="r">{c.comps.length}</td>
                        <td>
                          {pos === null ? (
                            <span className="badge">No comparables</span>
                          ) : pos > 0.05 ? (
                            <span className="badge badge-warn">▲ {fmtPct(pos)} above</span>
                          ) : pos < -0.05 ? (
                            <span className="badge badge-good">▼ {fmtPct(pos)} below</span>
                          ) : (
                            <span className="badge">● in line ({fmtPct(pos)})</span>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="sub">
                          <td colSpan={6}>
                            {c.comps.length ? (
                              <ul className="comps">
                                {c.comps
                                  .slice()
                                  .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))
                                  .map((l) => (
                                    <li key={`${l.dealerId}${l.key}`}>
                                      <a href={l.url} target="_blank" rel="noreferrer noopener">
                                        {l.title}
                                      </a>{" "}
                                      · {fmtNum(l.mileage)} mi · <strong>{fmtMoney(l.price)}</strong> · {dealerName.get(l.dealerId)} · {l.daysOnSite} days listed
                                    </li>
                                  ))}
                              </ul>
                            ) : (
                              <span className="muted">No competitor currently lists a comparable car.</span>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <div className="row">
          <h2>Latest changes</h2>
          <span className="spacer" />
          <div className="tabs" role="tablist" aria-label="Change type">
            {(
              [
                ["all", "All"],
                ["price_change", "Price changes"],
                ["new", "New"],
                ["removed", "Removed"],
              ] as [EventFilter, string][]
            ).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={eventFilter === k} onClick={() => setEventFilter(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrap" style={{ maxHeight: 360 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Competitor</th>
                <th>Change</th>
                <th>Vehicle</th>
                <th className="r">Price</th>
              </tr>
            </thead>
            <tbody>
              {shownEvents.slice(0, 200).map((e, i) => (
                <tr key={`${e.date}${e.dealerId}${e.key}${e.type}${i}`}>
                  <td>{fmtDate(e.date)}</td>
                  <td>{dealerName.get(e.dealerId)}</td>
                  <td>
                    <EventBadge e={e} />
                  </td>
                  <td>{e.title}</td>
                  <td className="r">
                    {e.type === "price_change" ? (
                      <>
                        <s className="muted">{fmtMoney(e.oldPrice)}</s> → {fmtMoney(e.newPrice)}
                      </>
                    ) : (
                      fmtMoney(e.newPrice ?? e.oldPrice)
                    )}
                  </td>
                </tr>
              ))}
              {shownEvents.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted center">
                    No changes in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="row">
          <h2>Competitor listings</h2>
          <span className="spacer" />
          <div className="tabs" role="tablist" aria-label="Listing status">
            <button role="tab" aria-selected={status === "active"} onClick={() => setStatus("active")}>
              Listed now
            </button>
            <button role="tab" aria-selected={status === "removed"} onClick={() => setStatus("removed")}>
              Sold / removed
            </button>
          </div>
          <input type="search" placeholder="Search make, model, VIN…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search listings" />
        </div>
        <p className="muted small">{table.length} vehicles, longest on site first. "+" means the car was already listed when tracking began.</p>
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table>
            <thead>
              <tr>
                <th>Vehicle</th>
                <th>Competitor</th>
                <th className="r">Mileage</th>
                <th className="r">First price</th>
                <th className="r">{status === "active" ? "Price now" : "Last price"}</th>
                <th className="r">Cuts</th>
                <th className="r">Days</th>
              </tr>
            </thead>
            <tbody>
              {table.slice(0, 300).map((l) => (
                <tr key={`${l.dealerId}${l.key}`}>
                  <td>
                    <a href={l.url} target="_blank" rel="noreferrer noopener">
                      {l.title}
                    </a>
                  </td>
                  <td>{dealerName.get(l.dealerId)}</td>
                  <td className="r">{fmtNum(l.mileage)}</td>
                  <td className="r">{fmtMoney(l.firstPrice)}</td>
                  <td className="r">{fmtMoney(l.price)}</td>
                  <td className="r">{l.priceChanges || ""}</td>
                  <td className="r" title={l.firstSeen === h.dates[0] ? "Already listed when tracking started, so the real age is at least this" : undefined}>
                    {status === "active" && l.daysOnSite > 45 ? (
                      <span className="badge badge-warn">⚠ {l.daysOnSite}{l.firstSeen === h.dates[0] ? "+" : ""}</span>
                    ) : (
                      `${l.daysOnSite}${l.firstSeen === h.dates[0] ? "+" : ""}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <footer className="muted small">
        CSV exports for Excel / Power BI are written to <code>data/exports/</code> on every run.
      </footer>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "warn" }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

function EventBadge({ e }: { e: ChangeEvent }) {
  if (e.type === "price_change") {
    const down = (e.delta ?? 0) < 0;
    return <span className="badge">{down ? "▼ cut" : "▲ raised"} {fmtMoney(Math.abs(e.delta ?? 0))}</span>;
  }
  if (e.type === "new") return <span className="badge badge-brand">+ New</span>;
  if (e.type === "relisted") return <span className="badge badge-brand">↺ Relisted</span>;
  return <span className="badge">✕ Removed</span>;
}
