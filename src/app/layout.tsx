import type { Metadata } from "next";
import { Spectral, Hanken_Grotesk, DM_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

/* Ember type system - three families, three jobs (brand guidelines §5; the
   rule for each, including "numbers are sans", is in globals.css's header). */
const spectral = Spectral({
  variable: "--font-spectral",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
});

const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

/* The mono FACE. It is only ever used through --font-mono in globals.css, so
   changing the face is this declaration plus that one token line — nothing in
   the components moves. Was JetBrains Mono until 2026-09; DM Mono is lighter
   and rounder, sits closer to Hanken, and reads as a label face rather than a
   terminal. 600 is gone with it (DM Mono stops at 500) — mono is labels, ids
   and code, none of which want a bold. */
const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Karos Labs · Your AI CMO",
  description: "Your AI CMO. Always-on agents that run strategy, content, and growth.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${spectral.variable} ${hanken.variable} ${dmMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
