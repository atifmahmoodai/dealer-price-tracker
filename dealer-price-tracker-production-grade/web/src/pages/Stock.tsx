import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { isAdmin, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { fmtMoney, fmtNum } from "../lib/format";
import type { OwnVehicle } from "../../../shared/types";

/** The dealer's own stock, compared with competitors on the dashboard. */
export function Stock() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["stock"], queryFn: () => api<{ items: OwnVehicle[] }>("/stock") });
  const file = useRef<HTMLInputElement>(null);
  const [done, setDone] = useState("");
  const [tooBig, setTooBig] = useState(false);
  const upload = useMutation({
    mutationFn: (csv: string) => api<{ count: number }>("/stock", { method: "PUT", body: { csv } }),
    onSuccess: (r) => {
      setDone(`Stock replaced: ${r.count} vehicles. The dashboard comparison is updated.`);
      void qc.invalidateQueries({ queryKey: ["stock"] });
      void qc.invalidateQueries({ queryKey: ["report"] });
    },
  });

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>My stock</h1>
        <span className="spacer" />
        <a className="btn" href="/api/stock.csv" download>
          Download CSV
        </a>
        {isAdmin(me.data) && (
          <>
            <button className="btn btn-primary" disabled={upload.isPending} onClick={() => file.current?.click()}>
              {upload.isPending ? "Uploading…" : "Upload stock CSV"}
            </button>
            <input
              ref={file}
              type="file"
              accept=".csv,text/csv"
              hidden
              aria-label="Stock CSV file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setDone("");
                upload.reset();
                setTooBig(f.size > 2_000_000);
                if (f.size <= 2_000_000) upload.mutate(await f.text());
              }}
            />
          </>
        )}
      </div>
      <p className="muted small">
        Upload your current stock as a CSV with the columns <code>StockNo,Year,Make,Model,Mileage,Price</code> (an export from your DMS or a spreadsheet saved as
        CSV). Each upload replaces the whole list, so sold cars drop off.
      </p>
      {tooBig && (
        <div className="notice" role="alert">
          That file is larger than 2 MB. Export only the columns listed above.
        </div>
      )}
      {upload.isError && (
        <div className="notice" role="alert">
          {errorText(upload.error)}
        </div>
      )}
      {done && (
        <div className="notice notice-good" role="status">
          {done}
        </div>
      )}
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Stock</th>
              <th>Vehicle</th>
              <th className="r">Mileage</th>
              <th className="r">Price</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.items.map((v) => (
              <tr key={v.stockNo}>
                <td>{v.stockNo}</td>
                <td>
                  {v.year} {v.make} {v.model}
                </td>
                <td className="r">{fmtNum(v.mileage)}</td>
                <td className="r">{fmtMoney(v.price)}</td>
              </tr>
            ))}
            {q.data?.items.length === 0 && (
              <tr>
                <td colSpan={4} className="muted center">
                  No stock uploaded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
