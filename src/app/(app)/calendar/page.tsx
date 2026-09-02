import { requireUser } from "@/lib/auth";
import { CalendarBody } from "./calendar-body";

/**
 * `searchParams` is threaded through for the archive deep link (portal feedback
 * round 2, 2026-09): Account Center gave up its Archive tab — "Archive does not
 * need to be in settings, it's in the calendar" — so `?view=archive[&status=…]`
 * is the destination every producer of the old settings link now writes. Read
 * here and validated in CalendarBody, which owns the one parser both calendar
 * routes share. Next 16 hands them over as a Promise.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; status?: string }>;
}) {
  const user = await requireUser();
  const { view, status } = await searchParams;
  return (
    <CalendarBody
      user={user}
      {...(view ? { view } : {})}
      {...(status ? { status } : {})}
    />
  );
}
