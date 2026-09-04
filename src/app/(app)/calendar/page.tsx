import { requireUser } from "@/lib/auth";
import { CalendarBody } from "./calendar-body";

/**
 * `searchParams` is threaded through for the archive deep link (portal feedback
 * round 2, 2026-09): Account Center gave up its Archive tab — "Archive does not
 * need to be in settings, it's in the calendar" — so `?view=archive[&status=…]`
 * is the destination every producer of the old settings link now writes. Read
 * here and validated in CalendarBody, which owns the one parser both calendar
 * routes share. Next 16 hands them over as a Promise.
 *
 * `date`, `agent` and `q` joined them for the flow audit 2026-09, R5: the
 * calendar wrote nothing back to the URL, so Back left the page instead of
 * undoing the last move and no week or filtered archive was shareable. The
 * calendar writes all six now, and every one of them is read back here.
 *
 * `hidden` is the sixth (review wave, 2026-09): the legend chips dim what the
 * grid paints, so a week sent on with drafts hidden has to arrive that way.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    status?: string;
    date?: string;
    agent?: string;
    q?: string;
    hidden?: string;
  }>;
}) {
  const user = await requireUser();
  const { view, status, date, agent, q, hidden } = await searchParams;
  return (
    <CalendarBody
      user={user}
      {...(view ? { view } : {})}
      {...(status ? { status } : {})}
      {...(date ? { date } : {})}
      {...(agent ? { agent } : {})}
      {...(q ? { q } : {})}
      {...(hidden ? { hidden } : {})}
    />
  );
}
