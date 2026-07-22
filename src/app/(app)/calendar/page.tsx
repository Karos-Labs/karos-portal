import { requireUser } from "@/lib/auth";
import { CalendarBody } from "./calendar-body";

export default async function CalendarPage() {
  const user = await requireUser();
  return <CalendarBody user={user} />;
}
