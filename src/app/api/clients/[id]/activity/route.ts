import { NextResponse } from "next/server";
import { getClient, latestClientJobActivity } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { canViewClient } from "@/lib/client-visibility";

/**
 * "Has anything changed for this client?" — one number, one document read.
 *
 * ## Why a watch endpoint and not another in-flight endpoint
 *
 * `AutoRefresh` already supports a narrow `statusUrl`, and one page uses it:
 * the Job detail page asks `/api/jobs/[id]/status` "is it done yet". The other
 * eleven call sites poll by calling `router.refresh()` every four seconds,
 * which re-renders the entire route segment tree — every layout, every
 * Suspense boundary, every data fetch on the page — to discover, almost every
 * time, that nothing has happened.
 *
 * They were left that way for a good reason, stated in `AutoRefresh`'s own
 * comment: each one watches a DIFFERENT in-flight signal. The calendar asks
 * whether a job belonging to a rendered row is queued or running; the agents
 * page also counts launch state and an active template run. Those predicates
 * are correct, they are computed from data the page already holds, and moving
 * them server-side would be copying page logic into a route where the two
 * can drift.
 *
 * So this does not answer "is it in flight". It answers "did anything move",
 * and the page keeps its own predicate for whether to watch at all. A poll
 * that returns the same number costs one document; the expensive refresh
 * happens on the tick where the number changes, which is the tick where there
 * is something new to render.
 *
 * Read-only on purpose, like the job status route: a request that fires every
 * few seconds must never also be a write path.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Same fence as every other client-scoped route: an employee who is not
  // assigned to this client cannot watch it either. Polling is a read, and a
  // read of somebody else's activity is still a read of it.
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await getClient(id);
  // 404 and not 403, matching the sibling client routes: "no such client" and
  // "not yours" must be the same answer, or the response becomes an oracle for
  // which client ids exist.
  if (!client || !canViewClient(user, client)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ changedAt: await latestClientJobActivity(id) });
}
