import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Learnify — Grab. Generate. Learn.", description: "A schema-driven personal learning studio." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
