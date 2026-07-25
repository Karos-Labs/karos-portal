import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getAgentIntake,
  getClient,
  listAgentIntake,
  listClientSeats,
  listJobs,
  listLiDraftFeedback,
  listXNewsUpdates,
} from "@/lib/data";
import { PageHeader } from "@/components/ui";
import {
  LinkedInAgentIntake,
  type LiIntakeView,
  type LiRunRowView,
  type LiSeatView,
} from "@/components/linkedin-agent-intake";
import type { AgentIntake, Job } from "@/lib/types";

/** Strip an intake doc to the client-safe view (the CV itself stays private). */
function toIntakeView(intake: AgentIntake | null): LiIntakeView | null {
  if (!intake) return null;
  return {
    handle: intake.handle,
    ...(intake.comeAcross ? { comeAcross: intake.comeAcross } : {}),
    offLimits: intake.offLimits,
    ...(intake.role ? { role: intake.role } : {}),
    ...(intake.focus ? { focus: intake.focus } : {}),
    ...(intake.fallbackKind ? { fallbackKind: intake.fallbackKind } : {}),
    ...(intake.fallbackText ? { fallbackText: intake.fallbackText } : {}),
    ...(intake.cvName ? { cvName: intake.cvName } : {}),
  };
}

/**
 * The client's LinkedIn agent page: the company-page form, seats (shared with
 * the other agents - one person, one seat), the shared news drop, and
 * per-draft feedback. Draft-first end to end: LinkedIn bars unattended
 * auto-posting, so a person always posts.
 */
export default async function LinkedInAgentPage({ params }: { params: Promise<{ id: string }> }) {
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

  const [seats, companyIntake, allIntake, news, feedback, jobs] = await Promise.all([
    listClientSeats(id),
    getAgentIntake(id, "linkedin", null),
    listAgentIntake(id, "linkedin"),
    listXNewsUpdates(id),
    listLiDraftFeedback(id),
    listJobs({ clientId: id }),
  ]);

  const intakeBySeat = new Map(allIntake.filter((i) => i.seatId).map((i) => [i.seatId as string, i]));
  const seatViews: LiSeatView[] = seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    slug: seat.slug,
    intake: toIntakeView(intakeBySeat.get(seat.id) ?? null),
  }));

  // The customAgents key is per client instance (karos-linkedin-company-<slug>),
  // so run history matches on the agent name rather than one fixed key.
  const liJobs: Job[] = jobs
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        /linkedin/i.test(j.agentName),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const runs: LiRunRowView[] = liJobs.slice(0, 8).map((j) => ({
    id: j.id,
    status: j.status,
    createdAt: j.createdAt,
    ...(isStaff ? { href: `/jobs/${j.id}` } : {}),
  }));

  return (
    <>
      <PageHeader
        title="LinkedIn agent"
        description="What we collect to run LinkedIn for you: the company page, a seat per person, and your ongoing drops. Drafts only - a person always posts."
        action={
          <a
            href={`/clients/${id}/agents`}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            Run the agent →
          </a>
        }
      />
      <LinkedInAgentIntake
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
