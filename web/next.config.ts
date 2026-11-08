import type { NextConfig } from "next";

// The browser only ever talks to this app's own origin. Requests to /api/* are
// proxied to FastAPI, so the API's httpOnly session cookie is first-party.
// API_ORIGIN is read at build time (rewrites are compiled into the build) and is
// not exposed to the browser. It is not a secret.
const apiOrigin = (process.env.API_ORIGIN || "http://localhost:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }];
  },
};
export default nextConfig;
