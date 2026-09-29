import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { isAdmin, useMe, useMeta } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import type { Role, Settings as AppSettings } from "../../../shared/schemas";

export function Settings() {
  const me = useMe();
  const meta = useMeta();
  if (!isAdmin(me.data)) return <Navigate to="/" replace />;
  return (
    <div className="wrap narrow">
      <div className="page-head">
        <h1>Settings &amp; users</h1>
      </div>
      {meta.data && <SettingsForm initial={meta.data.settings} timeZone={meta.data.timeZone} />}
      <Users />
    </div>
  );
}

function SettingsForm({ initial, timeZone }: { initial: AppSettings; timeZone: string }) {
  const qc = useQueryClient();
  const [s, setS] = useState({ ...initial, alertEmails: initial.alertEmails.join(", "), historyDays: String(initial.historyDays) });
  const save = useMutation({
    mutationFn: () =>
      api<AppSettings>("/settings", {
        method: "PUT",
        body: {
          ...s,
          companyName: s.companyName.trim(),
          currency: s.currency.trim().toUpperCase(),
          locale: s.locale.trim(),
          alertEmails: s.alertEmails
            .split(/[\s,;]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          historyDays: Number(s.historyDays),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["meta"] });
      void qc.invalidateQueries({ queryKey: ["report"] });
    },
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const emailErr = Object.entries(errs).find(([k]) => k.startsWith("alertEmails"))?.[1];
  const set = (k: keyof typeof s, v: string | boolean) => {
    save.reset();
    setS((x) => ({ ...x, [k]: v }));
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <form className="card stack" onSubmit={submit} noValidate>
      <h2>Business &amp; schedule</h2>
      <div className="form-grid">
        <label>
          Company name
          <input value={s.companyName} onChange={(e) => set("companyName", e.target.value)} />
          {errs.companyName && <div className="field-error">{errs.companyName}</div>}
        </label>
        <label>
          Currency / locale
          <span className="row" style={{ margin: 0, flexWrap: "nowrap" }}>
            <input aria-label="Currency" value={s.currency} onChange={(e) => set("currency", e.target.value)} style={{ minWidth: 0 }} />
            <input aria-label="Locale" value={s.locale} onChange={(e) => set("locale", e.target.value)} style={{ minWidth: 0 }} />
          </span>
          {(errs.currency || errs.locale) && <div className="field-error">{errs.currency ?? errs.locale}</div>}
        </label>
        <label className="check">
          <input type="checkbox" checked={s.scheduleEnabled} onChange={(e) => set("scheduleEnabled", e.target.checked)} /> Scrape every day automatically
        </label>
        <label>
          Daily at ({timeZone})
          <input type="time" value={s.scrapeTime} onChange={(e) => set("scrapeTime", e.target.value)} />
          {errs.scrapeTime && <div className="field-error">{errs.scrapeTime}</div>}
        </label>
        <label className="span2">
          Daily digest email to (comma separated)
          <input placeholder="owner@dealer.com, sales@dealer.com" value={s.alertEmails} onChange={(e) => set("alertEmails", e.target.value)} />
          <span className="muted small">After each daily scrape: price cuts, new and sold cars, your cars above market, and scrape problems. Needs SMTP set on the server.</span>
          {emailErr && <div className="field-error">{emailErr}</div>}
        </label>
        <label>
          Dashboard history (days)
          <input type="number" min={14} max={730} value={s.historyDays} onChange={(e) => set("historyDays", e.target.value)} />
          {errs.historyDays && <div className="field-error">{errs.historyDays}</div>}
        </label>
      </div>
      {save.isError && !Object.keys(errs).length && <div className="field-error">{errorText(save.error)}</div>}
      {save.isSuccess && (
        <div className="notice notice-good" role="status">
          Saved.
        </div>
      )}
      <div>
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  locked: boolean;
}

const ROLE_LABELS: { id: Role; label: string }[] = [
  { id: "viewer", label: "Viewer (dashboard, exports)" },
  { id: "admin", label: "Admin (also competitors, scrapes, stock, settings, users)" },
];

function Users() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api<{ items: StaffUser[] }>("/users") });
  const [editing, setEditing] = useState<StaffUser | "new" | null>(null);
  return (
    <section className="card stack" style={{ marginTop: "1rem" }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Staff logins</h2>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
          + Add user
        </button>
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      {q.data?.items.map((u) => (
        <div key={u.id} className="row" style={{ justifyContent: "space-between" }}>
          <span>
            <strong>{u.name}</strong> <span className="muted small">{u.email} · {u.role}</span>{" "}
            {!u.active ? <span className="badge">Disabled</span> : u.locked ? <span className="badge badge-bad">Locked</span> : null}
          </span>
          <button className="btn btn-sm" onClick={() => setEditing(u)}>
            Edit
          </button>
        </div>
      ))}
      {editing && <UserDialog user={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void qc.invalidateQueries({ queryKey: ["users"] })} />}
    </section>
  );
}

function UserDialog({ user, onClose, onSaved }: { user: StaffUser | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: user?.name ?? "", email: user?.email ?? "", role: user?.role ?? ("viewer" as Role), active: user?.active ?? true, password: "" });
  const [done, setDone] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      if (!user) return api("/users", { method: "POST", body: { email: f.email, name: f.name, role: f.role, password: f.password } });
      await api(`/users/${user.id}`, { method: "PUT", body: { name: f.name, role: f.role, active: f.active } });
      if (f.password) await api(`/users/${user.id}/password`, { method: "POST", body: { password: f.password } });
    },
    onSuccess: () => {
      onSaved();
      if (user && f.password) setDone("Saved. The new password is active and their other sessions were signed out.");
      else onClose();
    },
  });
  const errs = save.error instanceof ApiError ? save.error.details : {};
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={user ? "Edit user" : "Add user"} onClick={onClose}>
      <form
        className="card modal stack"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        noValidate
      >
        <h2 style={{ margin: 0 }}>{user ? `Edit ${user.name}` : "Add user"}</h2>
        <label>
          Name
          <input value={f.name} onChange={(e) => set("name", e.target.value)} />
          {errs.name && <div className="field-error">{errs.name}</div>}
        </label>
        <label>
          Email
          <input type="email" value={f.email} disabled={!!user} onChange={(e) => set("email", e.target.value)} />
          {errs.email && <div className="field-error">{errs.email}</div>}
        </label>
        <label>
          Role
          <select value={f.role} onChange={(e) => set("role", e.target.value)}>
            {ROLE_LABELS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {user ? "New password (leave blank to keep)" : "Password"}
          <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => set("password", e.target.value)} />
          <span className="muted small">At least 10 characters with letters and a number.</span>
          {errs.password && <div className="field-error">{errs.password}</div>}
        </label>
        {user && (
          <label style={{ display: "flex", alignItems: "center" }}>
            <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Active (untick when someone leaves)
          </label>
        )}
        {save.isError && !Object.keys(errs).length && <div className="field-error">{errorText(save.error)}</div>}
        {done && <div className="notice notice-good">{done}</div>}
        <div className="row">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
