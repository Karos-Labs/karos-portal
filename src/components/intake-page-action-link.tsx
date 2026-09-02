import Link from "next/link";
import { Icon } from "@/components/icon";

/**
 * The intake page's one header control — back to the agent, or to the roster
 * when no single instance resolves (`intakePageAction` resolves which).
 *
 * ONE LABEL AND ONE ARROW FOR BOTH ROLES since the parity pass (2026-09): the
 * resolver used to hand staff their own wording and the opposite chevron, so a
 * staff member previewing this page saw a control the client never gets.
 *
 * A real button, not the grey text link it used to be: this page is a leaf a
 * client reaches FROM the agent, so the way back is the header's only action,
 * and a 12px muted label in the corner was the easiest thing on the page to
 * miss. Styled as ui.tsx's "subtle" button so it reads as a control without
 * competing with the accent CTA rationing.
 */
export function IntakePageActionLink({
  href,
  label,
  back,
}: {
  href: string;
  label: string;
  /** Arrow direction: true draws a left chevron (returning), false a right arrow. */
  back: boolean;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-3"
    >
      {back && <Icon name="ChevronLeft" className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
      {!back && <Icon name="ArrowRight" className="h-3.5 w-3.5" aria-hidden="true" />}
    </Link>
  );
}
