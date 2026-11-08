// Same-origin requests to the Next.js /api proxy. The session lives in an
// httpOnly cookie set by the API, so no token is stored or handled in JS.
const base = "/api";
export async function api<T=any>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store", credentials: "same-origin" });
  if (!res.ok) {
    let detail: any = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); detail = b.detail || detail; } catch {}
    // Import errors: {message, errors: [...]}; FastAPI validation: [{loc, msg}, ...]
    if (detail && typeof detail === "object" && Array.isArray(detail.errors)) {
      detail = [detail.message, ...detail.errors.map((e: string) => "• " + e)].filter(Boolean).join("\n");
    } else if (Array.isArray(detail)) {
      detail = detail.map((e: any) => "• " + (Array.isArray(e?.loc) ? e.loc.filter((x: any) => x !== "body").join(".") + ": " : "") + (e?.msg || JSON.stringify(e))).join("\n");
    }
    if (res.status === 401 && typeof window !== "undefined" && path !== "/auth/login" && path !== "/auth/register" && path !== "/auth/me") {
      window.dispatchEvent(new Event("omnilearn:unauthorized"));
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
export const json = (method:string, body:any):RequestInit => ({method,body:JSON.stringify(body)});
