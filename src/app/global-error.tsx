"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * The last-resort boundary — fires only when the ROOT layout itself throws
 * (everything below it, including `(app)/layout.tsx`, has its own boundary).
 * Next.js requires this to render its own complete `<html>`/`<body>`, which
 * means it renders without `ThemeProvider` or the Google Fonts `next/font`
 * variables the rest of the app uses — an acceptable trade-off for a page
 * that exists purely so this one catastrophic case still reads as Karos
 * rather than a blank white screen. `globals.css`'s tokens default to the
 * dark Ember palette with no theme class applied, which is this app's
 * default theme anyway.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] root layout error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-background px-6 font-sans text-foreground antialiased">
        <div className="flex flex-col items-center text-center">
          <p className="text-lg font-medium">Karos hit a snag</p>
          <p className="mt-2 max-w-sm text-sm text-muted">
            Something went wrong loading the app. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-6 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
          >
            Reload
          </button>
          {error.digest && (
            <p className="mt-8 font-mono text-[11px] text-muted-2">Reference: {error.digest}</p>
          )}
        </div>
      </body>
    </html>
  );
}
