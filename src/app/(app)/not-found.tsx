import Link from "next/link";
import { Icon } from "@/components/icon";

/**
 * Rendered when a page inside the workspace calls `notFound()` or the URL
 * matches no route — same intent as `error.tsx`: a branded page instead of
 * Next's default unstyled 404, without losing the sidebar/rail chrome
 * `(app)/layout.tsx` renders around it.
 */
export default function AppNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted-2">
        <Icon name="Compass" className="h-6 w-6" />
      </div>
      <p className="text-lg font-medium text-foreground">We couldn't find that page</p>
      <p className="mt-2 max-w-sm text-sm text-muted">
        It may have been moved, renamed, or never existed. Check the link, or head back to your dashboard.
      </p>
      <div className="mt-6">
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-[0_8px_22px_-8px_color-mix(in_srgb,var(--primary)_55%,transparent)] transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
