import { cn } from "@/lib/utils";

/**
 * The frame for anything a staff member sees on a client-facing page that the
 * client themselves never will.
 *
 * PARITY PASS (2026-09). The product owner's ruling is that a staff member in
 * client context looks at the client's own page - same elements, same order,
 * same colours - and that whatever staff keep on top of it is ADDITIVE and
 * says so. Before this, the operator's extras (the ops strip, the Performance
 * charts, AI Insights, an approval control) were interleaved with the shared
 * cards and styled like them, so nobody previewing an account could tell
 * which part of the screen the client would actually get.
 *
 * One frame, one label, used by every page that keeps a staff-only block, so
 * the marker is the same everywhere and a reader learns it once. Dashed
 * hairline on the ground tone, no fill and no accent: it must recede behind
 * the client's content, not compete with it.
 */
export function StaffOnlySection({
  children,
  className,
  label = "Staff only · not shown to the client",
}: {
  children: React.ReactNode;
  className?: string;
  /** Override the caption where a page has something more specific to say. */
  label?: string;
}) {
  return (
    <section
      aria-label="Staff only"
      className={cn(
        "space-y-6 rounded-[var(--radius)] border border-dashed border-border p-4 md:p-5",
        className,
      )}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">{label}</p>
      {children}
    </section>
  );
}
