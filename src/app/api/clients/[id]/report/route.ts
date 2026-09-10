import { requireUser } from "@/lib/auth";
import { getClient, getClientReport } from "@/lib/data";
import { canViewClient } from "@/lib/client-visibility";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"]);
  const { id } = await params;

  // CLIENT_USER may only access their own client's report — not other accounts'.
  if (user.role === "CLIENT_USER" && user.clientId !== id) {
    return new Response("Forbidden", { status: 403 });
  }

  // STAFF SCOPE. The role list above admits every employee, so an employee 404'd
  // on /clients/[id] could read any client's full intelligence report — the whole
  // document, rendered — straight from here. Same predicate the pages ask, asked
  // unconditionally rather than under `role === "KAROS_EMPLOYEE"`.
  //
  // THE REFUSAL SHAPE IS THIS ROUTE'S OWN, not the JSON its siblings return: this
  // handler serves text/html and already answers "no report here" with a bare
  // 404 body, so the refusal reuses that exact response. A client this actor may
  // not see is then indistinguishable from a client that has never been
  // reported on, and the route tells them nothing about which ids are real.
  const client = await getClient(id);
  if (!client || !canViewClient(user, client)) {
    return new Response("Report not available", { status: 404 });
  }

  const report = await getClientReport(id);

  if (!report?.reportHtml) {
    return new Response("Report not available", { status: 404 });
  }

  return new Response(report.reportHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
