import { requireUser } from "@/lib/auth";
import { getClientReport } from "@/lib/data";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE", "CLIENT_USER"]);
  const { id } = await params;
  const report = await getClientReport(id);

  if (!report?.reportHtml) {
    return new Response("Report not available", { status: 404 });
  }

  return new Response(report.reportHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
