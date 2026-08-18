"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

// next-themes renders an inline <script> (dangerouslySetInnerHTML) to set the
// theme class before hydration, avoiding a flash of the wrong theme — the
// standard technique, and it still works correctly. React 19 added a dev-only
// warning for ANY <script> a component renders, which next-themes (unmaintained
// since March 2025) predates; the false positive is confirmed upstream
// (shadcn-ui/ui#10104). Filtered here rather than left to print on every
// client-side re-render throughout the app — dev-only and scoped to this one
// message string, so a real console.error is never swallowed.
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("Encountered a script tag")) return;
    originalConsoleError.apply(console, args);
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
