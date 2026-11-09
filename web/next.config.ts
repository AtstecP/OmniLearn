import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The browser only ever talks to this app's own origin. Requests to /api/* are
// proxied to FastAPI, so the API's httpOnly session cookie is first-party.
// The API origin is compiled into the rewrite at BUILD time. It is not a secret.
// Order: API_ORIGIN environment variable (Vercel, Docker, a Cloudflare build variable),
// then "vars.API_ORIGIN" in wrangler.jsonc (Cloudflare), then localhost for local development.
function wranglerVar(name: string): string | undefined {
  try {
    const raw = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const value = JSON.parse(raw)?.vars?.[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}
const configured = process.env.API_ORIGIN || wranglerVar("API_ORIGIN");
// Cloudflare Workers Builds sets WORKERS_CI. Without an origin the Worker would proxy to localhost
// (Cloudflare answers that with error 1003), so fail the build with a clear message instead.
if (process.env.WORKERS_CI && !configured) {
  throw new Error('API_ORIGIN is not set. Put your API address in web/wrangler.jsonc under "vars" (for example "API_ORIGIN": "https://your-api.vercel.app"), or add API_ORIGIN as a Cloudflare BUILD variable, then rebuild.');
}
const apiOrigin = (configured || "http://localhost:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }];
  },
};
export default nextConfig;
