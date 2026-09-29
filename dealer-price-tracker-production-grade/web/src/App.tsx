import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";

const Competitors = lazy(() => import("./pages/Competitors").then((m) => ({ default: m.Competitors })));
const Runs = lazy(() => import("./pages/Runs").then((m) => ({ default: m.Runs })));
const Stock = lazy(() => import("./pages/Stock").then((m) => ({ default: m.Stock })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Account = lazy(() => import("./pages/Account").then((m) => ({ default: m.Account })));
const AuditLog = lazy(() => import("./pages/AuditLog").then((m) => ({ default: m.AuditLog })));

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="wrap muted">Loading…</div>}>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="competitors" element={<Competitors />} />
            <Route path="runs" element={<Runs />} />
            <Route path="stock" element={<Stock />} />
            <Route path="settings" element={<Settings />} />
            <Route path="audit" element={<AuditLog />} />
            <Route path="account" element={<Account />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
