// Same-origin requests to the Next.js /api proxy. The session lives in an
// httpOnly cookie set by the API, so no token is stored or handled in JS.
const base = "/api";
export async function api<T=any>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  // The learner's own calendar day, so streaks follow local midnight rather than UTC.
  const d = new Date();
  headers.set("X-Local-Date", `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  // Hosting platforms reject request bodies over ~4.5 MB (413), so big JSON bodies (imports, edits) go gzipped.
  let body = init?.body;
  if (typeof body === "string" && body.length > 200_000 && typeof CompressionStream !== "undefined") {
    try {
      body = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
      headers.set("Content-Encoding", "gzip");
    } catch { body = init?.body; }
  }
  const res = await fetch(`${base}${path}`, { ...init, body, headers, cache: "no-store", credentials: "same-origin" });
  if (res.status === 304 && (init as any)?.onNotModified) return (init as any).onNotModified();
  (init as any)?.onResponse?.(res);
  if (!res.ok) {
    let detail: any = `${res.status} ${res.statusText}`;
    if (res.status === 413) detail = "This file is too big for the server, even compressed (limit about 4.5 MB). Split it into two or three smaller JSON files and import them one after another.";
    try { const b = await res.json(); if (res.status !== 413) detail = b.detail || detail; } catch {}
    // Import errors: {message, errors: [...]}; FastAPI validation: [{loc, msg}, ...]
    if (detail && typeof detail === "object" && Array.isArray(detail.errors)) {
      detail = [detail.message, ...detail.errors.map((e: string) => "• " + e)].filter(Boolean).join("\n");
    } else if (Array.isArray(detail)) {
      detail = detail.map((e: any) => "• " + (Array.isArray(e?.loc) ? e.loc.filter((x: any) => x !== "body").join(".") + ": " : "") + (e?.msg || JSON.stringify(e))).join("\n");
    }
    if (res.status === 401 && typeof window !== "undefined" && path !== "/auth/login" && path !== "/auth/register" && path !== "/auth/me") {
      window.dispatchEvent(new Event("omnilearn:unauthorized"));
    }
    const err: Error & { status?: number; body?: any } = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    err.status = res.status; // callers such as the canvas autosave react to 409 / 422
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
export const json = (method:string, body:any):RequestInit => ({method,body:JSON.stringify(body)});

// Subject workspace with an ETag: when nothing changed the API answers 304 (a few bytes) and the copy we
// already have is reused, so routine refreshes do not pull the whole subject out of the database again.
const tagged = new Map<string, { tag: string; data: any }>();
export async function apiTagged<T = any>(path: string, seed?: { tag?: string; data: T } | null): Promise<{ data: T; tag: string }> {
  const have = tagged.get(path) || (seed?.tag ? { tag: seed.tag, data: seed.data } : null);
  let tag = "";
  const init: any = {
    headers: have ? { "If-None-Match": have.tag } : undefined,
    onNotModified: () => have!.data,
    onResponse: (r: Response) => { tag = r.headers.get("ETag") || ""; },
  };
  const data = await api<T>(path, init);
  if (have && data === have.data) return { data, tag: have.tag };
  if (tag) tagged.set(path, { tag, data }); else tagged.delete(path);
  return { data, tag };
}
export const clearTagged = () => tagged.clear();
