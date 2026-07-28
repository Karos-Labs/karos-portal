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
  listClientContextDocs,
  listClientIntegrations,
  listClientCompetitors,
} from "@/lib/data";
import { ActiveClientProvider } from "@/lib/active-client-context";
import {
  CREDIT_COSTS,
  availableCredits,
  creditBlockReason,
  isBillableClientActor,
} from "@/lib/credits";
import { toClientPortalView } from "@/lib/client-visibility";
import { integrationIsUsable } from "@/lib/integration-status";
import { isAiProcessingLockActive } from "@/lib/constants";
import { shouldBlockForOnboarding } from "@/lib/onboarding";
import { Sidebar } from "@/components/sidebar";
import { ClientRail } from "@/components/client-rail";
import { CopilotDock } from "@/components/copilot-dock";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import { ClientContextBar } from "@/components/client-context-bar";
import { StaffCopilotDock } from "@/components/staff-chatbot-widget";
import type { ActionItemNotification, AgentReviewNotification, Client, ClientTask } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isImpersonating, realAdmin } = await getViewingContext();

  // Block the entire portal until a freshly-created client account finishes the
  // 2-step onboarding wizard. Checked first — before any other data fetching.
  // Exempt impersonation: staff "viewing as" an unonboarded client must land on
  // the real dashboard, not get funneled into (and stuck in) that client's wizard.
  if (shouldBlockForOnboarding({ isImpersonating, user })) redirect("/onboarding");

  let pendingCount = 0;
  let clients: Client[] = [];

  // Staff bell feeds are cross-client, so they need the viewer's client scope:
  // admins see every client, an employee only their assigned ones — the same
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
    // Reviews + tasks: the client's own, or — for staff — everything in their
    // client scope. These two feeds used to be handed empty arrays to staff, so
    // "Ready for review" and "Pending tasks" were structurally unreachable for
    // the people who run the agency, and the bell claimed "All caught up!"
    // while drafts sat in review (QA F68).
    user.role === "CLIENT_USER"
      ? user.clientId
        ? listReviewJobs(user.clientId)
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
    clients = adminData.allClients;
  }

  // ── Client portal shell (CLIENT_USER only) ──
  if (user.role === "CLIENT_USER" && user.clientId) {
    const client = await getClient(user.clientId);
    if (client) {
      const [contextDocs, integrations, report, competitors, credits] = await Promise.all([
        // Tier-filtered at the server boundary, not at render: ClientRail is a
        // "use client" component, so anything fetched here is serialized into the
        // RSC payload the client's browser downloads. Internal analyst docs and
        // never-published internal-only docs must not travel with it.
        listClientContextDocs(user.clientId, "client"),
        listClientIntegrations(user.clientId),
        getClientReport(user.clientId),
        listClientCompetitors(user.clientId),
        getClientCredits(user.clientId),
      ]);

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

      // Price + refusal for a targeted doc correction, resolved HERE rather than
      // in the modal — same shape as the Agents page's creditBlockReasons map:
      // the reason comes from the server's own ladder, so the modal can't invent
      // a different one. Present only for a billable client viewer; staff and
      // admins in "View as Client" are never charged, so they see no price.
      const correctionPricing = isBillableClientActor(user)
        ? {
            cost: CREDIT_COSTS.targetedCorrection,
            ...(spendableCredits < CREDIT_COSTS.targetedCorrection
              ? { blockReason: creditBlockReason(credits, CREDIT_COSTS.targetedCorrection) }
              : {}),
          }
        : undefined;
      // Same rule as the docs above, applied to the client record itself: the
      // rail is a "use client" component, so the WHOLE document would be
      // serialized into every client-portal RSC payload — including
      // clientKeyId, the join token that auto-approves any signup into this
      // workspace (QA F56). Whitelist-projected before it crosses.
      const clientView = toClientPortalView(client);

      return (
        <ActiveClientProvider>
          <div className="flex min-h-screen flex-col md:flex-row">
            <ClientRail
              user={user}
              client={clientView}
              contextDocs={contextDocs}
              competitors={competitors}
              isAdmin={false}
              actionItems={actionItems as ActionItemNotification[]}
              reviewJobs={reviewJobs}
              taskAlerts={taskAlerts}
              spendableCredits={spendableCredits}
              correctionPricing={correctionPricing}
            />

            <div className="flex min-w-0 flex-1 flex-col">
              {isImpersonating && realAdmin && (
                <ImpersonationBanner realAdmin={realAdmin} viewingAs={user} />
              )}
              <main className="flex-1 overflow-x-clip px-4 pb-28 pt-6 md:px-8 md:pt-8 md:pb-16 lg:pb-8">
                {/* Same cap as the staff shell — the two shells must render pages
                    at identical widths or tabs appear to change size. */}
                <div className="@container mx-auto w-full max-w-6xl animate-fade-up">
                  {/* The client shell — this banner's audience is a CLIENT_USER,
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
              client={{
                name: client.name,
                website: client.website,
                industry: client.industry,
                isAiProcessing: isAiProcessingLockActive(client),
              }}
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
            at the top right of every staff page. CD-G9c retired that strip —
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
          {/* Client-context mode gets its own persistent bar — see F60. */}
          <ClientContextBar />
          {/* Scroll reserve, same ladder as the client shell. The staff main had
              none, so the last rows of a fully-scrolled page sat behind the
              copilot strip. Below md the reserve covers the STACK — copilot
              strip on top of the 54px bottom tab bar (MOBILE_TAB_BAR_H, client
              context); at md+ the bar is gone and only the strip needs clearing. */}
          <main className="flex-1 overflow-x-clip px-4 pb-28 pt-6 md:px-8 md:pb-16 md:pt-8 lg:pb-8">
            <div className="@container mx-auto w-full max-w-6xl animate-fade-up">{children}</div>
          </main>
        </div>
        {/* Docked copilot right-rail — visible when admin selects a client via "View as Client" */}
        <StaffCopilotDock userName={user.name} viewerUid={user.uid} />
      </div>
    </ActiveClientProvider>
  );
}
