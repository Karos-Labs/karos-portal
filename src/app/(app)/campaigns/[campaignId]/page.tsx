import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getCampaign, getClientTask } from "@/lib/data";
import { CampaignStepProgress } from "@/components/campaign-step-progress";
import { ResumeCampaignButton } from "@/components/resume-campaign-button";
import { PageHeader, Badge } from "@/components/ui";
import type { ClientTask } from "@/lib/types";

export const dynamic = "force-dynamic";

const CAMPAIGN_STATUS_TONE = {
  planned: "info",
  active: "neon",
  done: "success",
} as const;

/**
 * Client Run View for an omnichannel Campaign: a step-by-step progress bar
 * over the campaign's dependency-wired tasks (anchor → newsletter → socials),
 * plus a Resume control that dispatches whatever is eligible to run right now
 * without re-running or re-charging anything already completed (see
 * resumeCampaignAction). The campaign doc carries its own clientId, so
 * authorization is a straight ownership check - no separate staff/client
 * route split needed the way the flat /tasks vs /clients/[id]/tasks pair has.
 */
export default async function CampaignRunPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const user = await requireUser();
  const { campaignId } = await params;

  const campaign = await getCampaign(campaignId);
  if (!campaign) notFound();
  if (user.role === "CLIENT_USER" && user.clientId !== campaign.clientId) notFound();

  const tasks = (
    await Promise.all(campaign.taskIds.map((id) => getClientTask(id)))
  ).filter((t): t is ClientTask => !!t);

  const allDone = tasks.length > 0 && tasks.every((t) => t.status === "completed");
  const hasFailure = tasks.some(
    (t) => t.status === "pending" && !!t.metadata?.executionError,
  );

  return (
    <div>
      <PageHeader
        title={campaign.title}
        description={campaign.themeScope}
        action={
          <Badge tone={CAMPAIGN_STATUS_TONE[campaign.status ?? "planned"]}>
            {campaign.status ?? "planned"}
          </Badge>
        }
      />

      {tasks.length === 0 ? (
        <p className="text-sm text-muted-2">
          This campaign has no steps yet - its tasks may have been removed.
        </p>
      ) : (
        <>
          <CampaignStepProgress tasks={tasks} />
          {!allDone && (
            <ResumeCampaignButton
              campaignId={campaign.id}
              clientId={campaign.clientId}
              label={hasFailure ? "Retry failed steps" : "Resume run"}
            />
          )}
        </>
      )}
    </div>
  );
}
