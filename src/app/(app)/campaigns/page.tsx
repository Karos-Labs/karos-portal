import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listCampaigns, listClientTasks, listClients } from "@/lib/data";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { campaignRows, campaignTone, describeCampaignProgress } from "@/lib/campaign-progress";
import { relativeTime } from "@/lib/utils";
import type { Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * EVERY CAMPAIGN, WHICH HAS NEVER HAD A PAGE.
 *
 * §09: *"the function that fetches campaigns is already written and unused,
 * and there is a detail route with no list page."* Both halves were true:
 * `listCampaigns` had no caller anywhere in the app, and `/campaigns/[id]`
 * could only be reached by a link nobody generated. A bundle of four or five
 * dependent tasks — the anchor, the newsletter that summarises it, the social
 * pieces that point at it — existed in Firestore and nowhere on screen.
 *
 * ## What the list answers that the detail page cannot
 *
 * Which campaign needs somebody. The status strip is derived from the steps
 * rather than read off `campaign.status`, because that field's three values
 * (`planned` / `active` / `done`) cannot separate "four steps waiting for
 * review" from "first step still running" — see `campaign-progress.ts`.
 *
 * ## Staff only, deliberately
 *
 * The detail route already serves a CLIENT_USER their own campaign, and this
 * page could. It does not, because a cross-client list is a staff surface and
 * giving the client's shell a new top-level destination is a product decision
 * rather than a missing page: `client-rail.tsx` is where their nav is decided.
 *
 * ## The empty state says what makes one
 *
 * Campaigns are written by the swarm when a trend scores past
 * `CAMPAIGN_TREND_MIN_WEIGHT`, not by a button on this page. An empty list
 * with "no campaigns yet" would leave a reader looking for the create action
 * there is not.
 */
export default async function CampaignsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const clients = await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined);
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  // Per client, because `listCampaigns` is a per-client query and the visible
  // set is already fenced above — an employee sees their assignments' campaigns
  // and nobody else's, by construction rather than by a filter afterwards.
  const [campaignsPerClient, tasks] = await Promise.all([
    Promise.all(clients.map((client) => listCampaigns(client.id).catch(() => [] as Campaign[]))),
    listClientTasks({ clientIds: clients.map((c) => c.id), includeArchived: true }),
  ]);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const rows = campaignRows(campaignsPerClient.flat(), tasksById);

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="One brief across channels: the anchor, the newsletter that summarises it, and the social pieces that point at it."
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="Layers" className="h-7 w-7" />}
          title="No campaigns yet"
          description="A campaign is written when a trend scores high enough to be worth more than a single post — it is not created by hand here. Run an agent swarm for a client and one appears if the week's trend earns it."
        />
      ) : (
        <ul className="space-y-2">
          {rows.map(({ campaign, progress }) => (
            <li key={campaign.id}>
              <Link
                href={`/campaigns/${campaign.id}`}
                className="focus-ring flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-foreground/30 hover:bg-foreground/[0.04]"
              >
                <span className="font-medium">{campaign.title}</span>
                <Badge tone={campaignTone(progress)}>{describeCampaignProgress(progress)}</Badge>
                {nameById.get(campaign.clientId) && <Badge tone="neutral">{nameById.get(campaign.clientId)}</Badge>}
                <span className="ml-auto text-xs text-muted-2">{relativeTime(campaign.createdAt)}</span>
                {campaign.themeScope && (
                  <span className="basis-full text-xs text-muted" dir="auto">
                    {campaign.themeScope}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
