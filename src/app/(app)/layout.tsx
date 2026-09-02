import { redirect } from "next/navigation";
import { getViewingContext } from "@/lib/auth";
import {
  listUsers,
  listClients,
  listAssignedActionItems,
  listReviewJobs,
  listReviewJobsForClients,
  listClientTasks,
  getClient,
  getClientCredits,
  getClientReport,
  listClientIntegrations,
  listCustomAgents,
  updateClient,
} from "@/lib/data";
import { railAgentsForClient } from "@/lib/rail-agents";
import { ActiveClientProvider } from "@/lib/active-client-context";
import { availableCredits } from "@/lib/credits";
import { clientSafeTaskAlerts } from "@/lib/notification-rows";
import {
  toClientPortalView,
  toStaffShellView,
  type StaffShellClientView,
} from "@/lib/client-visibility";
import { integrationIsUsable } from "@/lib/integration-status";
import { shouldBlockForOnboarding } from "@/lib/onboarding";
import { Sidebar } from "@/components/sidebar";
import { ClientRail } from "@/components/client-rail";
import { CopilotDock } from "@/components/copilot-dock";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import { ClientContextBar } from "@/components/client-context-bar";
import { StaffCopilotDock } from "@/components/staff-chatbot-widget";
import { StaffShellMain } from "@/components/staff-shell-main";
import type { ActionItemNotification, AgentReviewNotification, Client, ClientTask } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isImpersonating, realAdmin } = await getViewingContext();

  // Block the entire portal until a freshly-created client account finishes the
  // 2-step onboarding wizard. Checked first - before any other data fetching.
  // Exempt impersonation: staff "viewing as" an unonboarded client must land on
  // the real dashboard, not get funneled into (and stuck in) that client's wizard.
  if (shouldBlockForOnboarding({ isImpersonating, user })) redirect("/onboarding");

  let pendingCount = 0;
  // The PROJECTION, not the documents: this array is a prop of the Sidebar, a
  // "use client" component that renders on every staff page, so a whole Client
  // here puts every client's join token into every one of those RSC payloads.
  // StaffShellClientView carries exactly what the picker rows and the rail read.
  let clients: StaffShellClientView[] = [];

  // Staff bell feeds are cross-client, so they need the viewer's client scope:
  // admins see every client, an employee only their assigned ones - the same
  // fence /jobs, /assets and the task board use.
  const isStaffViewer = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const staffClients: Client[] = isStaffViewer
    ? await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined)
    : [];
  const staffClientNames = new Map(staffClients.map((c) => [c.id, c.name]));

  const [adminData, actionItems, reviewJobs, taskAlerts] = await Promise.all([
    user.role === "KAROS_ADMIN"
      ? Promise.all([listUsers(), listClients()]).then(([allUsers, allClients]) => ({
          allUsers,
          allClients,
        }))
      : Promise.resolve(null),
    // CLIENT_USER notifications are strictly scoped to their own client account;
    // a client user with no clientId has no company context, so no items at all.
    user.role === "CLIENT_USER"
      ? user.clientId
        ? listAssignedActionItems(user.uid, { forClientId: user.clientId })
        : Promise.resolve([] as ActionItemNotification[])
      : listAssignedActionItems(user.uid),
    // Reviews + tasks: the client's own, or - for staff - everything in their
    // client scope. These two feeds used to be handed empty arrays to staff, so
    // "Ready for review" and "Pending tasks" were structurally unreachable for
    // the people who run the agency, and the bell claimed "All caught up!"
    // while drafts sat in review (QA F68).
    user.role === "CLIENT_USER"
      ? user.clientId
        ? listReviewJobs(user.clientId, { limit: 15 })
        : Promise.resolve([] as AgentReviewNotification[])
      : listReviewJobsForClients([...staffClientNames.keys()], { limit: 15 }),
    user.role === "CLIENT_USER"
      ? user.clientId
        ? listClientTasks({
            clientId: user.clientId,
            status: ["pending", "review_pending"],
            limit: 50,
          })
        : Promise.resolve([] as ClientTask[])
      : listClientTasks({ status: ["pending", "review_pending"], limit: 200 }),
  ]);

  // Annotate staff rows with the client name (same pattern as tasks-body) and
  // fence them to the viewer's scope.
  const scopedReviewJobs: AgentReviewNotification[] = isStaffViewer
    ? reviewJobs.map((j) => ({ ...j, clientName: staffClientNames.get(j.clientId) ?? undefined }))
    : reviewJobs;
  const scopedTaskAlerts: (ClientTask & { _clientName?: string })[] = isStaffViewer
    ? taskAlerts
        .filter((t) => staffClientNames.has(t.clientId))
        .slice(0, 20)
        .map((t) => ({ ...t, _clientName: staffClientNames.get(t.clientId) }))
    : taskAlerts;

  if (adminData) {
    pendingCount = adminData.allUsers.filter((u) => u.disabled && !u.approvedAt).length;
  }
  // AN EMPLOYEE'S PICKER WAS EMPTY (ruling D24, parity pass 2026-09). `clients`
  // was seeded only inside the `adminData` branch above, and `adminData` is
  // null for a KAROS_EMPLOYEE — so the "Client context" picker at the foot of
  // their rail listed nothing at all and the whole client-context shell was
  // unreachable for them. `staffClients` is the same fence every other employee
  // surface uses (listClients({ employeeId })), already fetched above, so the
  // fix costs no extra read: admins get every client, employees their assigned
  // ones, and a CLIENT_USER's `staffClients` is `[]` by construction.
  clients = (adminData?.allClients ?? staffClients).map(toStaffShellView);

  // ── Client portal shell (CLIENT_USER only) ──
  if (user.role === "CLIENT_USER" && user.clientId) {
    const client = await getClient(user.clientId);
    if (client) {
      // contextDocs/competitors/correctionPricing no longer feed ClientRail —
      // Documents, Competitor Track and Brand Colors all moved to Account
      // Center (portal revamp, Surface 01/06), which fetches its own data on
      // its own route rather than riding along on every page's layout.
      const [integrations, report, credits, customAgents] = await Promise.all([
        listClientIntegrations(user.clientId),
        getClientReport(user.clientId),
        getClientCredits(user.clientId),
        listCustomAgents(),
      ]);

      // The rail's "AI agents" dropdown (Surface 01) — GRANTED agents, PLUS any
      // agent already starred even without a grant (2026-08). The filter itself
      // moved to lib/rail-agents.ts in the parity pass 2026-09: the staff
      // shell's client-context arm renders the same roster for the same client
      // (ruling D3), and the two must not be able to answer differently. See
      // that module for why each clause is there.
      const railAgents = railAgentsForClient(customAgents, client);

      // Onboarding default stars ("Karos sets the first stars at onboarding,
      // to steer what they use" — SOW p.4). Checked on `=== undefined`, not
      // `.length === 0`: a client who stars something and later unpins back
      // down to zero has made a choice, and `toggleStarredAgentAction` always
      // writes a real (possibly empty) array, never `undefined` — so this
      // fires exactly once per client, the first time their rail is ever
      // built, and never again once any stars exist. Every client onboarded
      // before this field existed reads as `undefined` today, which is the
      // "existing users" backfill case as well as the fresh-signup case; both
      // get the same one-time default. Awaited, not fire-and-forget: it only
      // runs once per client ever, and awaiting means THIS render already
      // reflects it, instead of the pinned rows appearing a navigation later.
      if (client.starredAgentIds === undefined && railAgents.length > 0) {
        const defaultStarredIds = railAgents.slice(0, 2).map((a) => a.id);
        await updateClient(client.id, { starredAgentIds: defaultStarredIds });
        client.starredAgentIds = defaultStarredIds;
      }

      // The SPENDABLE figure, not the raw balance. The pill is labelled "credits
      // remaining", and what the charge transaction actually enforces is the
      // balance clipped by the weekly/monthly caps. This is the same call the
      // Agents page makes, so the rail and that page can no longer print two
      // different "available" numbers for the same second.
      // `now` is omitted on purpose: getClientCredits rolls the spend windows on
      // read, and it just ran in this same request, so the doc is already
      // current. Calling Date.now() here would only add an impure call in render
      // (react-hooks/purity) for no behavioural gain.
      const spendableCredits = availableCredits(credits);

      // Same rule as the docs above, applied to the client record itself: the
      // rail is a "use client" component, so the WHOLE document would be
      // serialized into every client-portal RSC payload - including
      // clientKeyId, the join token that auto-approves any signup into this
      // workspace (QA F56). Whitelist-projected before it crosses.
      const clientView = toClientPortalView(client);

      return (
        <ActiveClientProvider>
          <div className="flex min-h-screen flex-col md:flex-row">
            <ClientRail
              user={user}
              client={clientView}
              agents={railAgents}
              actionItems={actionItems as ActionItemNotification[]}
              reviewJobs={reviewJobs}
              taskAlerts={clientSafeTaskAlerts(taskAlerts)}
              spendableCredits={spendableCredits}
            />

            <div className="flex min-w-0 flex-1 flex-col">
              {isImpersonating && realAdmin && (
                <ImpersonationBanner realAdmin={realAdmin} viewingAs={user} />
              )}
              <main className="flex-1 overflow-x-clip px-4 pb-28 pt-6 md:px-8 md:pt-8 md:pb-16 lg:pb-8">
                {/* Same cap as the staff shell - the two shells must render pages
                    at identical widths or tabs appear to change size. */}
                <div className="@container mx-auto w-full max-w-6xl animate-fade-up">
                  {/* The client shell - this banner's audience is a CLIENT_USER,
                      who has neither Regenerate nor Refresh Task Map (F20). */}
                  <AiProcessingBanner client={clientView} isClientViewer />
                  {children}
                </div>
              </main>
            </div>

            <CopilotDock
              clientId={client.id}
              viewerUid={user.uid}
              clientName={client.name}
              userName={user.name}
              hasGoogleIntegration={integrations.some(
                (i) => i.platform === "google" && integrationIsUsable(i),
              )}
              report={
                report ? { overallGrade: report.overallGrade, overallScore: report.overallScore } : null
              }
            />
          </div>
        </ActiveClientProvider>
      );
    }
  }

  // ── Staff workspace shell ──
  return (
    <ActiveClientProvider>
      <div className="flex min-h-screen flex-col md:flex-row">
        {/* Support, light/dark and the bell used to float in an AppHeader strip
            at the top right of every staff page. CD-G9c retired that strip -
            the rail's account menu carries them now, and the Company sheet
            carries them at narrow width in client context. */}
        <Sidebar
          user={user}
          pendingCount={pendingCount}
          realAdmin={realAdmin}
          clients={clients}
          actionItems={actionItems as ActionItemNotification[]}
          reviewJobs={scopedReviewJobs}
          taskAlerts={scopedTaskAlerts}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {isImpersonating && realAdmin && (
            <ImpersonationBanner realAdmin={realAdmin} viewingAs={user} />
          )}
          {/* Client-context mode gets its own persistent bar - see F60. */}
          <ClientContextBar />
          {/* Scroll reserve, and it is CONDITIONAL here where the client shell's
              is flat — the bottom chrome it clears (tab bar + copilot strip)
              only exists in client-context mode. StaffShellMain reads the same
              context both of those gate on; see #127 in that file. */}
          <StaffShellMain>
            <div className="@container mx-auto w-full max-w-6xl animate-fade-up">{children}</div>
          </StaffShellMain>
        </div>
        {/* Docked copilot right-rail - visible when admin selects a client via "View as Client" */}
        <StaffCopilotDock userName={user.name} viewerUid={user.uid} />
      </div>
    </ActiveClientProvider>
  );
}
