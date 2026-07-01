import { requireUser } from "@/lib/auth";
import { getClientReport } from "@/lib/data";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"]);
  const { id } = await params;

  // CLIENT_USER may only access their own client's report — not other accounts'.
  if (user.role === "CLIENT_USER" && user.clientId !== id) {
    return new Response("Forbidden", { status: 403 });
  }

  const report = await getClientReport(id);

  if (!report?.reportHtml) {
    return new Response("Report not available", { status: 404 });
  }

  return new Response(report.reportHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
