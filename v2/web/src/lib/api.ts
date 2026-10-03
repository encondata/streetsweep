// Every call to the server goes through here. Errors carry the server's own message,
// which is written to be shown to people as is.
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; raw?: Blob };

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (opts.raw) {
    headers["Content-Type"] = opts.raw.type;
    body = opts.raw;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const method = opts.method ?? (body === undefined ? "GET" : "POST");
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body });
  } catch {
    throw new ApiError(0, "Could not reach the server.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Session gone (expired, signed out elsewhere, password changed): back to sign-in.
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
    throw new ApiError(401, data.error ?? "Sign in first.");
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`);
  return data as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
