import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { isAdmin, useMe, useMeta } from "../api/auth";
import { api, errorText } from "../api/client";
import { fmtDate, fmtDateTime, fmtDuration, fmtNum } from "../lib/format";
import type { Run } from "../../../shared/schemas";

/** Scrape history: when each ran, what it found, and anything that went wrong. */
export function Runs() {
  const me = useMe();
  const meta = useMeta();
  const qc = useQueryClient();
  const running = !!meta.data?.running;
  const q = useQuery({
    queryKey: ["runs"],
    queryFn: () => api<{ items: Run[] }>("/runs"),
    // Poll while any listed run is still going, so its progress and final status show without a reload.
    refetchInterval: (query) => (query.state.data?.items.some((r) => r.status === "running") ? 2000 : 60_000),
  });
  const [open, setOpen] = useState<number | null>(null);
  // A run that finished between two status checks: refresh what it changed.
  const hadRunning = useRef(false);
  const anyRunning = !!q.data?.items.some((r) => r.status === "running");
  useEffect(() => {
    if (hadRunning.current && !anyRunning) for (const key of ["report", "competitors", "meta"]) void qc.invalidateQueries({ queryKey: [key] });
    hadRunning.current = anyRunning;
  }, [anyRunning, qc]);
  const start = useMutation({
    mutationFn: () => api<{ id: number }>("/runs", { method: "POST", body: {} }),
    onSuccess: (r) => {
      setOpen(r.id);
      void qc.invalidateQueries({ queryKey: ["meta"] });
      void qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const s = meta.data?.settings;

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Scrapes</h1>
        <span className="spacer" />
        {isAdmin(me.data) && (
          <button className="btn btn-primary" disabled={running || start.isPending} onClick={() => start.mutate()}>
            {running ? "Scrape running…" : "Scrape all now"}
          </button>
        )}
      </div>
      <p className="muted small">
        {s?.scheduleEnabled ? `Runs automatically every day at ${s.scrapeTime} (${meta.data?.timeZone}).` : "The daily schedule is off (Settings)."} Only one scrape runs at a
        time. A scrape that finds far fewer cars than the day before is treated as a failure and never marks cars as sold.
      </p>
      {start.isError && <div className="notice">{errorText(start.error)}</div>}
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>For</th>
              <th>Trigger</th>
              <th>Status</th>
              <th className="r">Competitors</th>
              <th className="r">Cars found</th>
              <th className="r">Took</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.items.map((r) => {
              const cars = r.results.reduce((n, x) => n + x.listings, 0);
              const problems = r.results.filter((x) => x.errors.length || x.listings === 0).length;
              const took = r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null;
              return (
                <Fragment key={r.id}>
                  <tr className="clickable" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                    <td>{fmtDateTime(r.startedAt)}</td>
                    <td>{fmtDate(r.forDate)}</td>
                    <td>{r.trigger === "schedule" ? "Daily schedule" : `Manual${r.requestedBy ? ` · ${r.requestedBy}` : ""}`}</td>
                    <td>
                      {r.status === "running" ? (
                        <span className="badge badge-brand pulse">Running</span>
                      ) : r.status === "failed" ? (
                        <span className="badge badge-bad">Failed</span>
                      ) : problems ? (
                        <span className="badge badge-warn">Done · {problems} with problems</span>
                      ) : (
                        <span className="badge badge-good">Done</span>
                      )}
                    </td>
                    <td className="r">{r.results.length}</td>
                    <td className="r">{fmtNum(cars)}</td>
                    <td className="r">{took === null ? "—" : fmtDuration(took)}</td>
                  </tr>
                  {open === r.id && (
                    <tr className="sub">
                      <td colSpan={7}>
                        {r.error && <div className="field-error">{r.error}</div>}
                        {r.results.length === 0 && !r.error && <span className="muted">Starting…</span>}
                        <ul className="comps">
                          {r.results.map((x) => (
                            <li key={x.competitorId}>
                              <strong>{x.name}</strong>: {fmtNum(x.listings)} cars on {x.pages} page{x.pages === 1 ? "" : "s"} in {fmtDuration(x.ms)}
                              {x.errors.map((e) => (
                                <div key={e} className="muted small">
                                  ⚠ {e}
                                </div>
                              ))}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {q.data?.items.length === 0 && (
              <tr>
                <td colSpan={7} className="muted center">
                  No scrapes yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
