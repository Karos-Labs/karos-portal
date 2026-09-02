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
 */
export default async function ClientCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; status?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { view, status } = await searchParams;
  const query = new URLSearchParams({
    ...(view ? { view } : {}),
    ...(status ? { status } : {}),
  }).toString();
  const suffix = query ? `?${query}` : "";

  if (user.role === "CLIENT_USER") {
    redirect(
      user.clientId === id
        ? `/calendar${suffix}`
        : user.clientId
          ? `/clients/${user.clientId}`
          : `/calendar${suffix}`,
    );
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
    />
  );
}
