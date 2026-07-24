import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getAgentIntake,
  getClient,
  getCustomAgentByKey,
  listAgentIntake,
  listClientSeats,
  listJobs,
  listXDraftFeedback,
  listXNewsUpdates,
  listXTakes,
} from "@/lib/data";
import { PageHeader } from "@/components/ui";
import {
  XAgentIntake,
  type XIntakeView,
  type XRunRowView,
  type XSeatView,
} from "@/components/x-agent-intake";
import type { AgentIntake, Job } from "@/lib/types";

/** Strip an intake doc to the client-safe view. */
function toIntakeView(intake: AgentIntake | null): XIntakeView | null {
  if (!intake) return null;
  return {
    handle: intake.handle,
    ...(intake.comeAcross ? { comeAcross: intake.comeAcross } : {}),
    offLimits: intake.offLimits,
    roster: intake.roster,
    ...(intake.premium !== undefined ? { premium: intake.premium } : {}),
  };
}

/**
 * The client's X agent page: the company-page form, seats, the two ongoing
 * boxes, and per-draft feedback — the one canonical set of X intake surfaces.
 */
export default async function XAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";

  const client = await getClient(id);
  if (!client) notFound();

  const [seats, companyIntake, allIntake, news, takes, feedback, jobs, xAgent] = await Promise.all([
    listClientSeats(id),
    getAgentIntake(id, "x", null),
    listAgentIntake(id, "x"),
    listXNewsUpdates(id),
    listXTakes(id),
    listXDraftFeedback(id),
    listJobs({ clientId: id }),
    getCustomAgentByKey("karos-x-agent"),
  ]);

  const intakeBySeat = new Map(allIntake.filter((i) => i.seatId).map((i) => [i.seatId as string, i]));
  const seatViews: XSeatView[] = seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    slug: seat.slug,
    intake: toIntakeView(intakeBySeat.get(seat.id) ?? null),
    takes: takes
      .filter((t) => t.seatId === seat.id)
      .map((t) => ({ id: t.id, take: t.take, date: t.date, ...(t.topic ? { topic: t.topic } : {}) })),
  }));

  const xJobs: Job[] = jobs
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        (xAgent ? j.agentName === xAgent.name : /\bX Agent\b/i.test(j.agentName)),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const runs: XRunRowView[] = xJobs.slice(0, 8).map((j) => ({
    id: j.id,
    status: j.status,
    createdAt: j.createdAt,
    ...(isStaff ? { href: `/jobs/${j.id}` } : {}),
  }));


  return (
    <>
      <PageHeader
        title="X agent"
        description="What we collect to run X for you: the company page, a seat per person, and your ongoing drops. Drafts only - nothing posts without a human."
        action={
          <a
            href={`/clients/${id}/agents`}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            Run the agent →
          </a>
        }
      />
      <XAgentIntake
        clientId={id}
        company={toIntakeView(companyIntake)}
        seats={seatViews}
        news={news.map((n) => ({
          id: n.id,
          title: n.title,
          date: n.date,
          ...(n.type ? { type: n.type } : {}),
        }))}
        feedback={feedback.slice(0, 12).map((f) => ({
          id: f.id,
          account: f.account,
          action: f.action,
          ...(f.draftRef ? { draftRef: f.draftRef } : {}),
          createdAt: f.createdAt,
        }))}
        runs={runs}
      />
    </>
  );
}
