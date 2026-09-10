"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";

/**
 * The workspace's error boundary — catches a thrown page/layout render below
 * it (a Firestore hiccup, a webhook race, anything else uncaught) so a client
 * or staff member gets a branded page telling them what to do next, instead
 * of Next's default unstyled "Application error" screen. Nested inside
 * `(app)/layout.tsx`, so the sidebar/rail chrome around it stays intact —
 * only the page content area is replaced.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] unhandled error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
        <Icon name="TriangleAlert" className="h-6 w-6" />
      </div>
      <p className="text-lg font-medium text-foreground">Something went wrong</p>
      <p className="mt-2 max-w-sm text-sm text-muted">
        This page hit a snag on our end. Nothing you were working on was lost. Try again, or head back to your dashboard.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button variant="primary" onClick={() => reset()}>
          <Icon name="RefreshCw" className="h-4 w-4" />
          Try again
        </Button>
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
        >
          Back to dashboard
        </Link>
      </div>
      {error.digest && (
        <p className="mt-8 font-mono text-[11px] text-muted-2">Reference: {error.digest}</p>
      )}
    </div>
  );
}
