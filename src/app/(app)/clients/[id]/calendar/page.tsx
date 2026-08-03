import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { CalendarBody } from "@/app/(app)/calendar/calendar-body";

/**
 * Staff browsing a single client's Calendar via the sidebar's "View as
 * client" picker. CLIENT_USER already has their own Calendar at the flat
 * /calendar route - sent back there rather than duplicating it here.
 */
export default async function ClientCalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    redirect(user.clientId === id ? "/calendar" : user.clientId ? `/clients/${user.clientId}` : "/calendar");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

  return <CalendarBody user={user} viewClientId={client.id} />;
}
