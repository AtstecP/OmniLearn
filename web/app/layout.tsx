import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Learnify — Grab. Generate. Learn.", description: "A schema-driven personal learning studio." };
// viewport-fit=cover lets the page reach the screen edges on iPhones, so the bottom tab bar sits flush
// with the bottom and env(safe-area-inset-*) can pad it above the home indicator.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#10132a" },
  ],
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
