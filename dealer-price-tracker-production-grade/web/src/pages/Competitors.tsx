import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { isAdmin, useMe, useMeta } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { fmtDate, fmtMoney, fmtNum } from "../lib/format";
import type { CompetitorInput } from "../../../shared/schemas";
import type { Listing } from "../../../shared/types";

interface CompetitorRow {
  id: string;
  name: string;
  active: boolean;
  config: CompetitorInput;
  lastSnapshot: { date: string; listings: number; pages: number; errors: string[] } | null;
}

const SELECTOR_FIELDS: [keyof NonNullable<CompetitorInput["selectors"]>, string, boolean][] = [
  ["card", "Car card", true],
  ["title", "Title", true],
  ["price", "Price", true],
  ["link", "Link (e.g. a@href)", false],
  ["mileage", "Mileage", false],
  ["vin", "VIN", false],
  ["stockNo", "Stock number", false],
  ["year", "Year", false],
];

export function Competitors() {
  const me = useMe();
  const meta = useMeta();
  const admin = isAdmin(me.data);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["competitors"], queryFn: () => api<{ items: CompetitorRow[] }>("/competitors") });
  const [editing, setEditing] = useState<CompetitorRow | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const scrapeOne = useMutation({
    mutationFn: (competitorId: string) => api<{ id: number }>("/runs", { method: "POST", body: { competitorId } }),
    onSuccess: () => {
      setNotice("Scrape started. Progress is under Scrapes; the dashboard updates when it finishes.");
      void qc.invalidateQueries({ queryKey: ["meta"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/competitors/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["competitors"] });
      void qc.invalidateQueries({ queryKey: ["report"] });
    },
  });

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Competitors</h1>
        <span className="spacer" />
        {admin && (
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            + Add competitor
          </button>
        )}
      </div>
      <p className="muted small">
        Each competitor is scraped once a day{meta.data?.settings.scheduleEnabled ? ` at ${meta.data.settings.scrapeTime} (${meta.data.timeZone})` : " when the schedule is on"}. The scraper obeys robots.txt,
        waits between pages and only reads public listing pages.
      </p>
      {notice && <div className="notice notice-good">{notice}</div>}
      {(scrapeOne.isError || remove.isError) && <div className="notice">{errorText(scrapeOne.error ?? remove.error)}</div>}
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Competitor</th>
              <th>Method</th>
              <th>Last scrape</th>
              <th className="r">Cars</th>
              <th>Status</th>
              {admin && <th />}
            </tr>
          </thead>
          <tbody>
            {q.data?.items.map((c) => {
              const s = c.lastSnapshot;
              return (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong>
                    <div className="muted small">
                      <a href={c.config.website} target="_blank" rel="noreferrer noopener">
                        {c.config.website.replace(/^https?:\/\//, "")}
                      </a>
                    </div>
                  </td>
                  <td>{c.config.mode === "selectors" ? "CSS selectors" : c.config.mode === "jsonld" ? "Structured data" : "Automatic"}</td>
                  <td>{s ? fmtDate(s.date) : <span className="muted">never</span>}</td>
                  <td className="r">{s ? fmtNum(s.listings) : "—"}</td>
                  <td>
                    {!c.active ? (
                      <span className="badge">Paused</span>
                    ) : !s ? (
                      <span className="badge">New</span>
                    ) : s.listings === 0 ? (
                      <span className="badge badge-warn" title={s.errors[0]}>
                        ⚠ Nothing found
                      </span>
                    ) : s.errors.length ? (
                      <span className="badge badge-warn" title={s.errors[0]}>
                        ⚠ Partly failed
                      </span>
                    ) : (
                      <span className="badge badge-good">OK</span>
                    )}
                  </td>
                  {admin && (
                    <td className="r">
                      <div className="btn-row">
                        <button className="btn btn-sm" disabled={!c.active || scrapeOne.isPending || !!meta.data?.running} onClick={() => scrapeOne.mutate(c.id)}>
                          Scrape now
                        </button>
                        <button className="btn btn-sm" onClick={() => setEditing(c)}>
                          Edit
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (window.confirm(`Delete ${c.name} and all its history? To keep the history, edit it and untick Active instead.`)) remove.mutate(c.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {q.data?.items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted center">
                  No competitors yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {q.data?.items.some((c) => c.lastSnapshot?.errors.length) && (
        <div className="card">
          <h2>Latest problems</h2>
          <ul className="small">
            {q.data.items
              .filter((c) => c.lastSnapshot?.errors.length)
              .map((c) => (
                <li key={c.id}>
                  <strong>{c.name}:</strong> {c.lastSnapshot!.errors[0]}
                </li>
              ))}
          </ul>
          <p className="muted small">
            A blocked or broken page never marks cars as sold; see <Link to="/runs">Scrapes</Link> for each run.
          </p>
        </div>
      )}
      {editing && (
        <CompetitorDialog
          row={editing === "new" ? null : editing}
          taken={new Set(q.data?.items.map((c) => c.id))}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["competitors"] });
            void qc.invalidateQueries({ queryKey: ["report"] });
          }}
        />
      )}
    </div>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

interface TestResult {
  found: number;
  pages: number;
  errors: string[];
  sample: Listing[];
}

function CompetitorDialog({ row, taken, onClose, onSaved }: { row: CompetitorRow | null; taken: Set<string>; onClose: () => void; onSaved: () => void }) {
  const c = row?.config;
  const [id, setId] = useState(row?.id ?? "");
  const [idTouched, setIdTouched] = useState(!!row);
  const [f, setF] = useState({
    name: c?.name ?? "",
    website: c?.website ?? "",
    startUrls: (c?.startUrls ?? []).join("\n"),
    mode: c?.mode ?? "auto",
    nextPage: c?.nextPage ?? "",
    maxPages: String(c?.maxPages ?? 20),
    delaySec: String((c?.delayMs ?? 3000) / 1000),
    active: row?.active ?? true,
  });
  const [sel, setSel] = useState<Record<string, string>>({ ...(c?.selectors ?? {}) });
  const [test, setTest] = useState<TestResult | null>(null);

  const config = (): CompetitorInput => {
    const selectors = Object.fromEntries(Object.entries(sel).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    return {
      name: f.name.trim(),
      website: f.website.trim(),
      startUrls: f.startUrls
        .split(/\s+/)
        .map((u) => u.trim())
        .filter(Boolean),
      mode: f.mode as CompetitorInput["mode"],
      ...(Object.keys(selectors).length ? { selectors: selectors as CompetitorInput["selectors"] } : {}),
      ...(f.nextPage.trim() ? { nextPage: f.nextPage.trim() } : {}),
      maxPages: Number(f.maxPages),
      delayMs: Math.round(Number(f.delaySec) * 1000),
    };
  };
  const save = useMutation({
    mutationFn: () =>
      row
        ? api(`/competitors/${row.id}`, { method: "PUT", body: { active: f.active, config: config() } })
        : api("/competitors", { method: "POST", body: { id, active: f.active, config: config() } }),
    onSuccess: onSaved,
  });
  const runTest = useMutation({ mutationFn: () => api<TestResult>("/competitors/test", { method: "POST", body: config() }), onSuccess: setTest });
  const err = save.error ?? runTest.error;
  const errs = err instanceof ApiError ? err.details : {};
  const fieldErr = (k: string) => errs[k] ?? errs[`config.${k}`] ?? Object.entries(errs).find(([e]) => e.startsWith(`config.${k}.`) || e.startsWith(`${k}.`))?.[1];
  const set = (k: keyof typeof f, v: string | boolean) => {
    setF((x) => ({ ...x, [k]: v }));
    if (k === "name" && !idTouched && !row) setId(slug(String(v)));
  };
  const idClash = !row && taken.has(id);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!idClash) save.mutate();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={row ? `Edit ${row.name}` : "Add competitor"} onClick={onClose}>
      <form className="card modal stack" onClick={(e) => e.stopPropagation()} onSubmit={submit} noValidate>
        <h2>{row ? `Edit ${row.name}` : "Add competitor"}</h2>
        <div className="form-grid">
          <label>
            Dealer name
            <input value={f.name} onChange={(e) => set("name", e.target.value)} />
            {fieldErr("name") && <div className="field-error">{fieldErr("name")}</div>}
          </label>
          <label>
            ID (used in exports)
            <input
              value={id}
              disabled={!!row}
              onChange={(e) => {
                setIdTouched(true);
                setId(e.target.value);
              }}
            />
            {(idClash || errs.id) && <div className="field-error">{idClash ? "Already used" : errs.id}</div>}
          </label>
          <label className="span2">
            Website
            <input type="url" placeholder="https://www.dealer.com" value={f.website} onChange={(e) => set("website", e.target.value)} />
            {fieldErr("website") && <div className="field-error">{fieldErr("website")}</div>}
          </label>
          <label className="span2">
            Inventory page(s), one per line
            <textarea rows={2} placeholder="https://www.dealer.com/used-cars" value={f.startUrls} onChange={(e) => set("startUrls", e.target.value)} />
            {fieldErr("startUrls") && <div className="field-error">{fieldErr("startUrls")}</div>}
          </label>
          <label>
            How to read the page
            <select value={f.mode} onChange={(e) => set("mode", e.target.value)}>
              <option value="auto">Automatic (structured data, then selectors)</option>
              <option value="jsonld">Structured data only</option>
              <option value="selectors">CSS selectors only</option>
            </select>
          </label>
          <label>
            "Next page" link selector
            <input placeholder="a.next (optional)" value={f.nextPage} onChange={(e) => set("nextPage", e.target.value)} />
          </label>
          <label>
            Max pages
            <input type="number" min={1} max={100} value={f.maxPages} onChange={(e) => set("maxPages", e.target.value)} />
            {fieldErr("maxPages") && <div className="field-error">{fieldErr("maxPages")}</div>}
          </label>
          <label>
            Seconds between pages
            <input type="number" min={1} max={60} step={0.5} value={f.delaySec} onChange={(e) => set("delaySec", e.target.value)} />
            {fieldErr("delayMs") && <div className="field-error">{fieldErr("delayMs")}</div>}
          </label>
        </div>
        {f.mode !== "jsonld" && (
          <details open={f.mode === "selectors"}>
            <summary className="small">
              <strong>CSS selectors</strong> <span className="muted">(for sites without structured data: inspect a car card in the browser)</span>
            </summary>
            <div className="form-grid" style={{ marginTop: "0.5rem" }}>
              {SELECTOR_FIELDS.map(([k, label, req]) => (
                <label key={k}>
                  {label}
                  {req && f.mode === "selectors" ? " *" : ""}
                  <input value={sel[k] ?? ""} onChange={(e) => setSel({ ...sel, [k]: e.target.value })} />
                  {fieldErr(`selectors.${k}`) && <div className="field-error">{fieldErr(`selectors.${k}`)}</div>}
                </label>
              ))}
            </div>
            {fieldErr("selectors") && <div className="field-error">{fieldErr("selectors")}</div>}
          </details>
        )}
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Active (untick to pause without losing history)
        </label>
        {err && !Object.keys(errs).length && <div className="field-error">{errorText(err)}</div>}
        {test && (
          <div className={`notice ${test.found ? "notice-good" : ""}`} role="status">
            <strong>
              Test: {test.found} car{test.found === 1 ? "" : "s"} found on the first page.
            </strong>{" "}
            {test.errors[0] && <span>{test.errors[0]}</span>}
            {test.sample.length > 0 && (
              <div className="table-wrap" style={{ marginTop: "0.5rem" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th className="r">Price</th>
                      <th className="r">Mileage</th>
                      <th>VIN / stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {test.sample.map((l) => (
                      <tr key={l.key}>
                        <td>{l.title}</td>
                        <td className="r">{fmtMoney(l.price)}</td>
                        <td className="r">{fmtNum(l.mileage)}</td>
                        <td>{l.vin ?? l.stockNo ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <div className="btn-row">
          <button type="button" className="btn" disabled={runTest.isPending} onClick={() => runTest.mutate()}>
            {runTest.isPending ? "Testing…" : "Test first page"}
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
