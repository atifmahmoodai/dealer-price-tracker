import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applySettings } from "../lib/format";
import type { Meta, SessionUser } from "../../../shared/schemas";
import { api, ApiError, setCsrfToken } from "./client";

interface MeResponse {
  user: SessionUser;
  csrfToken: string;
}

/** The signed-in user, or null. */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const r = await api<MeResponse>("/auth/me");
        setCsrfToken(r.csrfToken);
        return r.user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api<MeResponse>("/auth/login", { method: "POST", body: input }),
    onSuccess: (r) => {
      setCsrfToken(r.csrfToken);
      qc.setQueryData(["me"], r.user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSettled: () => {
      setCsrfToken("");
      qc.clear();
      qc.setQueryData(["me"], null);
    },
  });
}

/** Settings everyone needs (company name, currency) and whether a scrape is running. */
export function useMeta(enabled = true) {
  return useQuery({
    queryKey: ["meta"],
    enabled,
    queryFn: async () => {
      const m = await api<Meta>("/meta");
      applySettings(m.settings);
      return m;
    },
    // Poll faster while a scrape runs, so its progress and the new data show up promptly.
    refetchInterval: (q) => (q.state.data?.running ? 3000 : 60_000),
  });
}

export const isAdmin = (u: SessionUser | null | undefined) => u?.role === "admin";
