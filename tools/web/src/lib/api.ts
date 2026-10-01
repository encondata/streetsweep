import type { Area, AreaDraft, AreaProgress, ExclusionReason, Network, User } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Every call to the server goes through here. The session is a cookie, so there is
 * nothing to attach; a 401 means it has gone, and the sign-in page brings you back.
 */
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
    throw new ApiError("Signed out", 401);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError((data && data.error) || `The server answered ${res.status}`, res.status);
  return data as T;
}

export const api = {
  me: () => call<{ user: User }>("/api/auth/me").then((d) => d.user),
  logout: () => call("/api/auth/logout", "POST", {}),

  areas: () => call<{ areas: Area[] }>("/api/areas").then((d) => d.areas),
  progress: () => call<{ areas: AreaProgress[] }>("/api/areas/progress").then((d) => d.areas),
  createArea: (a: AreaDraft) => call<{ area: Area }>("/api/areas", "POST", a).then((d) => d.area),
  updateArea: (id: number, a: AreaDraft) => call<{ area: Area }>(`/api/areas/${id}`, "PUT", a).then((d) => d.area),
  deleteArea: (id: number) => call(`/api/areas/${id}`, "DELETE"),

  /** Streets with their status; `cells` for a big area, a screenful of map cells at a time. */
  network: (id: number, cells?: string[]) =>
    call<Network>(`/api/areas/${id}/network?status=1` + (cells ? "&cells=" + cells.join(",") : "")),

  markComplete: (wayIds: number[], marked: boolean) =>
    call("/api/street-completions", "POST", { wayIds, marked }),
  exclude: (wayIds: number[], excluded: boolean, reason?: ExclusionReason) =>
    call("/api/street-exclusions", "POST", { wayIds, excluded, reason }),
};
