import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Learnify — Grab. Generate. Learn.", description: "A schema-driven personal learning studio." };
// No viewport-fit=cover: with it, phone browsers whose toolbars float over the page (iOS 26 Safari, Chrome) let the
// page start underneath the top toolbar and the menu button ends up hidden. Without it the page stays inside the
// safe area. (There is no fixed bottom bar anymore, so edge-to-edge is not needed.)
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#10132a" },
  ],
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
