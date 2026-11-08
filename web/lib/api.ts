const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
export async function api<T=any>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("omnilearn.jwt");
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); detail = b.detail || detail; } catch {}
    if (res.status === 401 && typeof window !== "undefined" && path !== "/auth/login" && path !== "/auth/register") {
      localStorage.removeItem("omnilearn.jwt");
      window.dispatchEvent(new Event("omnilearn:unauthorized"));
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
export const json = (method:string, body:any):RequestInit => ({method,body:JSON.stringify(body)});
