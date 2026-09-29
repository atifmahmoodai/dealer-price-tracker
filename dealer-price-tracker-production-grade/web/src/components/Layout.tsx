import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useRef } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { isAdmin, useLogout, useMe, useMeta } from "../api/auth";
import { errorText } from "../api/client";

export function Layout() {
  const me = useMe();
  const meta = useMeta(!!me.data);
  const logout = useLogout();
  const location = useLocation();
  const qc = useQueryClient();
  // When a scrape finishes, refresh everything it changed.
  const runningId = meta.data?.running?.id ?? null;
  const lastRunning = useRef<number | null>(null);
  useEffect(() => {
    if (lastRunning.current !== null && runningId === null) {
      for (const key of ["runs", "report", "competitors"]) void qc.invalidateQueries({ queryKey: [key] });
    }
    lastRunning.current = runningId;
  }, [runningId, qc]);

  if (me.isPending) return <div className="wrap muted">Loading…</div>;
  if (me.isError) return <div className="wrap"><div className="notice">{errorText(me.error)}</div></div>;
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (meta.isPending) return <div className="wrap muted">Loading…</div>;
  if (meta.isError) {
    return (
      <div className="wrap">
        <div className="card">
          <h1>Couldn't reach the server</h1>
          <p className="muted">{errorText(meta.error)}</p>
          <button className="btn btn-primary" onClick={() => void meta.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  const user = me.data;
  const admin = isAdmin(user);
  return (
    <>
      <header className="appbar">
        <div className="appbar-inner">
          <NavLink to="/" end className="brand">
            <img src="/favicon.svg" alt="" width={26} height={26} />
            <span>{meta.data.settings.companyName}</span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>
              Dashboard
            </NavLink>
            <NavLink to="/competitors">Competitors</NavLink>
            <NavLink to="/runs">
              Scrapes {meta.data.running && <span className="badge badge-brand pulse">running</span>}
            </NavLink>
            <NavLink to="/stock">My stock</NavLink>
            {admin && <NavLink to="/settings">Settings &amp; users</NavLink>}
            {admin && <NavLink to="/audit">Activity</NavLink>}
          </nav>
          <span className="spacer" />
          <div className="user small">
            <NavLink to="/account" title="My account">
              {user.name}
            </NavLink>{" "}
            <span className="muted">({user.role})</span>
            <button className="btn btn-sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main>
        <Suspense fallback={<div className="wrap muted">Loading…</div>}>
          <Outlet />
        </Suspense>
      </main>
    </>
  );
}
