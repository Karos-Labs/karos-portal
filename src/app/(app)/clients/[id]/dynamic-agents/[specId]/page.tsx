import { notFound, redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { isBillableClientActor, isCreditsPlanV2Enabled } from "@/lib/credits";
import { getDynamicAgentSpec } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { DynamicAgentRun } from "@/components/dynamic-agent-run";

export default async function ClientDynamicAgentRunPage({
  params,
}: {
  params: Promise<{ id: string; specId: string }>;
}) {
  const user = await requireUser();
  const { id, specId } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const spec = await getDynamicAgentSpec(specId);
  if (!spec || !spec.active) notFound();
  const allowed = spec.allowedClientIds ?? [];
  if (!isStaff && allowed.length > 0 && !allowed.includes(client.id)) notFound();

  return (
    <>
      <PageHeader title={spec.name} description={spec.description} />
      {/* Flow audit 2026-09, R2/R3: the run resolves in place (no push to the
          staff-only /jobs route) and the press quotes its own price — the
          figure the submit core freezes onto this run's specSnapshot. */}
      <DynamicAgentRun
        specId={spec.id}
        clientId={client.id}
        inputSchema={spec.inputSchema}
        creditsCost={spec.creditsCost}
        // Wording only, resolved here because a client component cannot read a
        // non-NEXT_PUBLIC_ env var. A dynamic run settles like any other
        // (review wave, 2026-09) — see DynamicAgentRun.priceIsEstimate.
        priceIsEstimate={isCreditsPlanV2Enabled()}
        viewerIsBilled={isBillableClientActor(user)}
        isStaff={isStaff}
      />
    </>
  );
}
