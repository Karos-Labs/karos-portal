import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  getClientCredits,
  listClientIntegrations,
  listCreditLedger,
  listCustomAgents,
  listScheduledRuns,
  listTranscripts,
  getClientSettings,
} from "@/lib/data";
import { getOAuthEnabledPlatforms } from "@/lib/integrations/oauth";
import { sanitizeIntegrations, sanitizeLinkedinSeats } from "@/lib/integrations/sanitize";
import { CREDIT_COSTS, DEFAULT_LINKEDIN_SEAT_LIMIT } from "@/lib/credits";
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
import { LogoutButton } from "@/components/logout-button";
import { relativeTime } from "@/lib/utils";
import type { ClientIntegration, Transcript, ClientCredits, CreditLedgerEntry, CustomAgent, ClientSettings, EmployeeSeat, ScheduledRun } from "@/lib/types";

export default async function ClientSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const isAdmin = user.role === "KAROS_ADMIN";
  const isStaff = isAdmin || user.role === "KAROS_EMPLOYEE";
  const [integrations, transcripts, credits, creditLedger, customAgents, settings, scheduledRuns] = (await Promise.all([
    listClientIntegrations(id),
    listTranscripts({ clientId: id }),
    getClientCredits(id),
    listCreditLedger(id, 15),
    isAdmin ? listCustomAgents() : Promise.resolve([]),
    getClientSettings(id),
    isAdmin ? listScheduledRuns({ clientId: id }) : Promise.resolve([]),
  ])) as [ClientIntegration[], Transcript[], ClientCredits, CreditLedgerEntry[], CustomAgent[], ClientSettings | null, ScheduledRun[]];
  const oauthEnabledPlatforms = getOAuthEnabledPlatforms();

  // Sanitized LinkedIn seats for the multi-seat workspace — strip tokens; the UI
  // never needs (and must never receive) the credentials, encrypted or not.
  const linkedIntegration = integrations.find((i) => i.platform === "linkedin") as ClientIntegration | undefined;
  const sanitizedLinkedinSeats = sanitizeLinkedinSeats(linkedIntegration?.employeeSeats as EmployeeSeat[] | undefined);

  // Same rule for the integrations themselves: the docs carry OAuth access/refresh
  // tokens and pasted API keys in `credentials`, so only the non-secret fields cross
  // — plus which secrets are set, for the form's placeholder.
  const sanitizedIntegrations = sanitizeIntegrations(integrations);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Connect channels, review meetings, and invite teammates."
        action={
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            <Icon name="User" className="h-3.5 w-3.5" />
            Account settings
          </Link>
        }
      />

      {/* CLIENT_USER already sees this via the (app) shell's own wrapper — only
          render here for staff, who use the plain Sidebar shell with no such wrapper. */}
      {user.role !== "CLIENT_USER" && (
        <div className="mb-6">
          <AiProcessingBanner client={client} isAdmin={user.role === "KAROS_ADMIN"} />
        </div>
      )}

      {/* Brand profile (logo, voice, contact) — staff-managed */}
      {isStaff && (
        <div className="mb-8">
          <ClientEditor client={client} />
        </div>
      )}

      {/* Credits & usage */}
      <div className="mb-8">
        <CreditsPanel clientId={client.id} credits={credits} ledger={creditLedger} role={user.role} />
      </div>

      {/* Agent access (admin) — which custom agents this client may fire themselves */}
      {isAdmin && (
        <div className="mb-8">
          <Card>
            <CardTitle className="mb-1">AI agent access</CardTitle>
            <p className="mb-3 text-sm text-muted-2">
              Agents this client&apos;s users can run from their AI Agents page. Each run charges
              the client&apos;s credits.
            </p>
            <ClientAgentAccessCard
              clientId={client.id}
              agents={customAgents}
              allowedIds={client.customAgentIds ?? []}
            />
          </Card>
        </div>
      )}

      {/* Scheduled runs (admin) — recurring generators fired on a cadence, draft-first + free */}
      {isAdmin && (
        <div className="mb-8">
          <Card>
            <CardTitle className="mb-1">Scheduled runs</CardTitle>
            <p className="mb-3 text-sm text-muted-2">
              Fire a custom agent for this client on a recurring cadence (e.g. the LinkedIn
              company-page generator, Tue–Thu). Runs are draft-first and never charge credits.
            </p>
            <ScheduledRunsCard
              clientId={client.id}
              runs={scheduledRuns}
              agents={customAgents
                .filter((a) => a.enabled)
                .map((a) => ({ id: a.id, name: a.name, entrySkillDir: a.entrySkillDir }))}
            />
          </Card>
        </div>
      )}

      {/* Integrations */}
      <IntegrationsTab
        clientId={client.id}
        integrations={sanitizedIntegrations}
        oauthEnabledPlatforms={oauthEnabledPlatforms}
        currentUserRole={user.role}
        linkedinSeats={sanitizedLinkedinSeats}
        seatLimit={client.linkedinSeatLimit ?? DEFAULT_LINKEDIN_SEAT_LIMIT}
        seatCost={CREDIT_COSTS.employeeSeat}
      />

      {/* Auto-schedule opt-in toggle */}
      <div className="mt-6">
        {/* Render client-side toggle so the user gets immediate UI feedback */}
        <div>
          <AutoScheduleToggle clientId={client.id} enabled={settings?.autoScheduleEnabled} />
        </div>
      </div>

      {/* Meetings */}
      <div className="mt-8">
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
                    className="flex items-center justify-between gap-3 py-2.5 transition-colors hover:bg-surface-2/40 -mx-2 rounded-lg px-2"
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
      </div>

      {/* Invite teammates */}
      {client.clientKeyId && (
        <div className="mt-8">
          <Card>
            <CardTitle className="mb-1">Invite your team</CardTitle>
            <p className="mb-3 text-sm text-muted-2">
              Share this key with a teammate so they can join your workspace.
            </p>
            <ClientKeyInline clientKeyId={client.clientKeyId} />
          </Card>
        </div>
      )}

      {/* Account */}
      <div className="mt-8">
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Account</CardTitle>
            <p className="mt-0.5 text-sm text-muted-2">Sign out of your Karos workspace.</p>
          </div>
          <LogoutButton />
        </Card>
      </div>
    </>
  );
}
