import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import {
  getClientCredits,
  listClientIntegrations,
  listCreditLedger,
  listCustomAgents,
  listJobs,
  listScheduledRuns,
  listTranscripts,
  getClientSettings,
} from "@/lib/data";
import { getOAuthEnabledPlatforms, googleBusinessProfileRequested } from "@/lib/integrations/oauth";
import { sanitizeIntegrations, sanitizeLinkedinSeats } from "@/lib/integrations/sanitize";
import { CREDIT_COSTS, DEFAULT_LINKEDIN_SEAT_LIMIT } from "@/lib/credits";
import { summarizeClientSpend } from "@/lib/credit-reporting";

/** Rows the "Recent activity" feed shows. */
const LEDGER_FEED_LIMIT = 15;
/** Rows the per-agent breakdown aggregates over (§6.2a). */
const LEDGER_SUMMARY_LIMIT = 500;
import { Card, CardTitle, PageHeader } from "@/components/ui";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import AutoScheduleToggle from "@/components/auto-schedule-toggle";
import { Icon } from "@/components/icon";
import { IntegrationsTab } from "@/components/integrations-tab";
import { ClientKeyInline } from "@/components/client-key-inline";
import { CreditsPanel } from "@/components/credits-panel";
import { ClientAgentAccessCard } from "@/components/custom-agents";
import { ScheduledRunsCard } from "@/components/scheduled-runs";
import { ClientEditor } from "@/components/client-editor";
import { SettingsTabs, type SettingsTab } from "@/components/settings-tabs";
import { agentKeyMatchesClientSlug } from "@/lib/custom-agent-launch";
import { relativeTime } from "@/lib/utils";
import type { ClientIntegration, Transcript, ClientCredits, CreditLedgerEntry, CustomAgent, ClientSettings, EmployeeSeat, JobRunType, ScheduledRun } from "@/lib/types";

export default async function ClientSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // Read here rather than with useSearchParams in SettingsTabs: this keeps the
  // tab component free of a Suspense requirement and seeds it from the URL on a
  // hard load, which is what makes a ?tab= link work at all.
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { tab: initialTab } = await searchParams;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

  const isAdmin = user.role === "KAROS_ADMIN";
  const isStaff = isAdmin || user.role === "KAROS_EMPLOYEE";
  const [integrations, transcripts, credits, creditLedger, customAgents, settings, scheduledRuns] = (await Promise.all([
    listClientIntegrations(id),
    listTranscripts({ clientId: id }),
    getClientCredits(id),
    // The FEED is capped at 15; the breakdown below is aggregated over a much
    // deeper slice, because "where your credits went" computed from the last
    // fifteen rows would be a breakdown of this week presented as a breakdown
    // of spend.
    listCreditLedger(id, LEDGER_SUMMARY_LIMIT),
    isAdmin ? listCustomAgents() : Promise.resolve([]),
    getClientSettings(id),
    isAdmin ? listScheduledRuns({ clientId: id }) : Promise.resolve([]),
  ])) as [ClientIntegration[], Transcript[], ClientCredits, CreditLedgerEntry[], CustomAgent[], ClientSettings | null, ScheduledRun[]];

  // §6.2(a). The split between a scheduled fire and a run the client started
  // lives on the JOB, not the ledger row, so the jobs are joined here on the
  // server — the browser never needs them and a client payload carrying every
  // job would be both wasteful and a staff-detail leak.
  const spendJobs = await listJobs({ clientId: id });
  const runTypeByJobId: Record<string, JobRunType | undefined> = {};
  for (const job of spendJobs) runTypeByJobId[job.id] = job.runType;
  const agentNameById: Record<string, string> = {};
  for (const job of spendJobs) {
    if (job.customAgentId) agentNameById[job.customAgentId] = job.agentName;
  }
  const spendByAgent = summarizeClientSpend({
    ledger: creditLedger,
    runTypeByJobId,
    agentNameById,
  });
  const oauthEnabledPlatforms = getOAuthEnabledPlatforms();

  // Both agent controls below act on THIS client, so neither may offer a
  // per-client agent instance belonging to another one: granting it would be
  // inert (both submit cores refuse the pair) and scheduling it would build a
  // row that refuses on every fire.
  const clientAgents = customAgents.filter((a) =>
    agentKeyMatchesClientSlug(a.key, client.agentsRepoSlug),
  );

  // Sanitized LinkedIn seats for the multi-seat workspace — strip tokens; the UI
  // never needs (and must never receive) the credentials, encrypted or not.
  const linkedIntegration = integrations.find((i) => i.platform === "linkedin") as ClientIntegration | undefined;
  const sanitizedLinkedinSeats = sanitizeLinkedinSeats(linkedIntegration?.employeeSeats as EmployeeSeat[] | undefined);

  // Same rule for the integrations themselves: the docs carry OAuth access/refresh
  // tokens and pasted API keys in `credentials`, so only the non-secret fields cross
  // — plus which secrets are set, for the form's placeholder.
  const sanitizedIntegrations = sanitizeIntegrations(integrations);

  // Grouped by task instead of stacked. Sections keep their existing markup —
  // only where they live changes. A tab whose content is entirely staff-gated
  // collapses to null and is dropped below, so a client is never shown an empty
  // tab (the Profile tab is admin/employee-only in practice).
  const profileSection = isStaff ? <ClientEditor client={client} /> : null;

  const creditsSection = (
    <CreditsPanel
      clientId={client.id}
      credits={credits}
      ledger={creditLedger.slice(0, LEDGER_FEED_LIMIT)}
      spendByAgent={spendByAgent}
      role={user.role}
      viewer={{ name: user.name, email: user.email }}
    />
  );

  const channelsSection = (
    <IntegrationsTab
      clientId={client.id}
      integrations={sanitizedIntegrations}
      oauthEnabledPlatforms={oauthEnabledPlatforms}
      googleBusinessProfileRequested={googleBusinessProfileRequested()}
      currentUserRole={user.role}
      linkedinSeats={sanitizedLinkedinSeats}
      seatLimit={client.linkedinSeatLimit ?? DEFAULT_LINKEDIN_SEAT_LIMIT}
      seatCost={CREDIT_COSTS.employeeSeat}
    />
  );

  const automationSection = (
    <div className="space-y-8">
      <AutoScheduleToggle clientId={client.id} enabled={settings?.autoScheduleEnabled} />

      {/* Agent access (admin) — which custom agents this client may fire themselves */}
      {isAdmin && (
        <Card>
          <CardTitle className="mb-1">AI agent access</CardTitle>
          <p className="mb-3 text-sm text-muted-2">
            Agents this client&apos;s users can run from their AI Agents page. Each run charges the
            client&apos;s credits.
          </p>
          <ClientAgentAccessCard
            clientId={client.id}
            agents={clientAgents}
            allowedIds={client.customAgentIds ?? []}
          />
        </Card>
      )}

      {/* Scheduled runs (admin) — recurring generators fired on a cadence, draft-first + free */}
      {isAdmin && (
        <Card>
          <CardTitle className="mb-1">Scheduled runs</CardTitle>
          <p className="mb-3 text-sm text-muted-2">
            Fire a custom agent for this client on a recurring cadence (e.g. the LinkedIn
            company-page generator, Tue–Thu). Runs are draft-first and never charge credits.
          </p>
          <ScheduledRunsCard
            clientId={client.id}
            runs={scheduledRuns}
            agents={clientAgents
              .filter((a) => a.enabled)
              .map((a) => ({ id: a.id, name: a.name, entrySkillDir: a.entrySkillDir }))}
          />
        </Card>
      )}
    </div>
  );

  const meetingsSection = (
    <Card>
      <CardTitle className="mb-3">Meetings</CardTitle>
      {transcripts.length === 0 ? (
        <p className="text-sm text-muted-2">
          No meetings linked yet. Calls synced from Fireflies appear here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {transcripts.slice(0, 12).map((t) => (
            <li key={t.id}>
              <Link
                href={`/transcripts/${t.id}`}
                className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-2/40"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <p className="text-xs text-muted-2">{relativeTime(t.meetingDate ?? t.createdAt)}</p>
                </div>
                <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  // F56: the key is a standing credential — staff and the workspace's own group
  // admin only, and whoever can see it can rotate it.
  const teamSection =
    client.clientKeyId && (isStaff || user.isGroupAdmin) ? (
      <Card>
        <CardTitle className="mb-1">Invite your team</CardTitle>
        <p className="mb-3 text-sm text-muted-2">
          Share this key with a teammate so they can join your workspace.
        </p>
        <ClientKeyInline clientKeyId={client.clientKeyId} clientId={client.id} canRotate />
      </Card>
    ) : null;

  const sections: SettingsTab[] = [
    { id: "profile", label: "Profile", icon: "Building2", content: profileSection },
    { id: "channels", label: "Channels", icon: "Share2", content: channelsSection },
    { id: "credits", label: "Credits", icon: "Coins", content: creditsSection },
    { id: "automation", label: "Automation", icon: "Bot", content: automationSection },
    { id: "meetings", label: "Meetings", icon: "Mic", content: meetingsSection },
    { id: "team", label: "Team", icon: "Users", content: teamSection },
  ].filter((t) => t.content !== null);

  // Account settings is the last entry of the same row, not a header link
  // stranded beside it: someone scanning "everything settings related" should
  // find it where the other settings are. It is the one entry that navigates —
  // /settings is its own route — so SettingsTabs renders it as a link.
  const tabs: SettingsTab[] = [
    ...sections,
    { id: "account", label: "Account settings", icon: "User", href: "/settings" },
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        description="Credits and usage, connected channels, automation, meetings, and teammates."
      />

      {/* CLIENT_USER already sees this via the (app) shell's own wrapper — only
          render here for staff, who use the plain Sidebar shell with no such wrapper. */}
      {user.role !== "CLIENT_USER" && (
        <div className="mb-6">
          <AiProcessingBanner client={client} isAdmin={user.role === "KAROS_ADMIN"} />
        </div>
      )}

      {/* The Account card that used to close this page held nothing but a Sign
          out button, which already lives in the rail's account menu. */}
      <SettingsTabs tabs={tabs} initialTab={initialTab} />
    </>
  );
}
