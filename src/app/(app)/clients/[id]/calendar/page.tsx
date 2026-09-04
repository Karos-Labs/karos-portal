import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { CalendarBody } from "@/app/(app)/calendar/calendar-body";

/**
 * Staff browsing a single client's Calendar via the sidebar's "View as
 * client" picker. CLIENT_USER already has their own Calendar at the flat
 * /calendar route - sent back there rather than duplicating it here.
 *
 * `searchParams` rides through both branches (portal feedback round 2,
 * 2026-09). The calendar holds the archive now, at `?view=archive[&status=…]`,
 * and a link built for staff is routinely pasted to a client — so the redirect
 * CARRIES the query rather than dropping the reader on an unfiltered week.
 *
 * The set grew with the calendar's own URL state (flow audit 2026-09, R5):
 * `date` (the week/month anchor) and the archive's `agent`/`q` filters are
 * written by the calendar now, so a staff link to "that week" or "that agent's
 * archive" must survive this redirect as intact as `view`/`status` already did.
 * `hidden` (the dimmed legend chips) joined them in the review wave, 2026-09.
 */
export default async function ClientCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    view?: string;
    status?: string;
    date?: string;
    agent?: string;
    q?: string;
    hidden?: string;
    /** One deliverable to open on load (round 6, decision 8). */
    asset?: string;
  }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { view, status, date, agent, q, hidden, asset } = await searchParams;
  const query = new URLSearchParams({
    ...(view ? { view } : {}),
    ...(status ? { status } : {}),
    ...(date ? { date } : {}),
    ...(agent ? { agent } : {}),
    ...(q ? { q } : {}),
    ...(hidden ? { hidden } : {}),
    ...(asset ? { asset } : {}),
  }).toString();
  const suffix = query ? `?${query}` : "";

  if (user.role === "CLIENT_USER") {
    // ALWAYS the flat route, whichever client the URL named (review wave,
    // 2026-09). A client following a staff link to someone else's calendar used
    // to land on their own client HOME with the query dropped — a different
    // page from the one the link described, and silently so. There is exactly
    // one calendar a CLIENT_USER may read, it is at /calendar, and the query
    // says which week or which archive slice they were sent to; the id in the
    // path is the only part they cannot have.
    redirect(`/calendar${suffix}`);
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

  return (
    <CalendarBody
      user={user}
      viewClientId={client.id}
      {...(view ? { view } : {})}
      {...(status ? { status } : {})}
      {...(date ? { date } : {})}
      {...(agent ? { agent } : {})}
      {...(q ? { q } : {})}
      {...(hidden ? { hidden } : {})}
      {...(asset ? { asset } : {})}
    />
  );
}
