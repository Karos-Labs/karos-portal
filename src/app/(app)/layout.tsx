import { redirect } from "next/navigation";
import { getViewingContext } from "@/lib/auth";
import {
  listUsers,
  listClients,
  listAssignedActionItems,
  listReviewJobs,
  listClientTasks,
  getClient,
  getClientCredits,
  getClientReport,
  listClientContextDocs,
  listClientIntegrations,
  listClientCompetitors,
} from "@/lib/data";
import { ActiveClientProvider } from "@/lib/active-client-context";
import { integrationIsUsable } from "@/lib/integration-status";
import { isAiProcessingLockActive } from "@/lib/constants";
import { shouldBlockForOnboarding } from "@/lib/onboarding";
import { Sidebar } from "@/components/sidebar";
import { ClientRail } from "@/components/client-rail";
import { CopilotDock } from "@/components/copilot-dock";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import { AppHeader } from "@/components/app-header";
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
    user.role === "CLIENT_USER" && user.clientId
      ? listReviewJobs(user.clientId)
      : Promise.resolve([] as AgentReviewNotification[]),
    user.role === "CLIENT_USER" && user.clientId
      ? listClientTasks({
          clientId: user.clientId,
          status: ["pending", "review_pending"],
          limit: 50,
        })
      : Promise.resolve([] as ClientTask[]),
  ]);

  if (adminData) {
    pendingCount = adminData.allUsers.filter((u) => u.disabled && !u.approvedAt).length;
    clients = adminData.allClients;
  }

  // ── Client portal shell (CLIENT_USER only) ──
  if (user.role === "CLIENT_USER" && user.clientId) {
    const client = await getClient(user.clientId);
    if (client) {
      const [contextDocs, integrations, report, competitors, credits] = await Promise.all([
        listClientContextDocs(user.clientId),
        listClientIntegrations(user.clientId),
        getClientReport(user.clientId),
        listClientCompetitors(user.clientId),
        getClientCredits(user.clientId),
      ]);

      return (
        <ActiveClientProvider>
          <div className="flex min-h-screen flex-col md:flex-row">
            <ClientRail
              user={user}
              client={client}
              contextDocs={contextDocs}
              competitors={competitors}
              isAdmin={false}
              actionItems={actionItems as ActionItemNotification[]}
              reviewJobs={reviewJobs}
              taskAlerts={taskAlerts}
              creditBalance={credits.balance}
            />

            <div className="flex min-w-0 flex-1 flex-col">
              {isImpersonating && realAdmin && (
                <ImpersonationBanner realAdmin={realAdmin} viewingAs={user} />
              )}
              <main className="flex-1 overflow-x-clip px-4 pb-28 pt-6 md:px-8 md:pt-8 md:pb-16 lg:pb-8">
                {/* Same cap as the staff shell — the two shells must render pages
                    at identical widths or tabs appear to change size. */}
                <div className="mx-auto w-full max-w-6xl animate-fade-up">
                  {/* The client shell — this banner's audience is a CLIENT_USER,
                      who has neither Regenerate nor Refresh Task Map (F20). */}
                  <AiProcessingBanner client={client} isClientViewer />
                  {children}
                </div>
              </main>
            </div>

            <CopilotDock
              clientId={client.id}
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
        <Sidebar
          user={user}
          pendingCount={pendingCount}
          realAdmin={realAdmin}
          clients={clients}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {isImpersonating && realAdmin && (
            <ImpersonationBanner realAdmin={realAdmin} viewingAs={user} />
          )}
          <AppHeader
            actionItems={actionItems as ActionItemNotification[]}
            reviewJobs={reviewJobs}
            taskAlerts={taskAlerts}
            userName={user.name}
            userEmail={user.email}
          />
          <main className="flex-1 overflow-x-clip px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto w-full max-w-6xl animate-fade-up">{children}</div>
          </main>
        </div>
        {/* Docked copilot right-rail — visible when admin selects a client via "View as Client" */}
        <StaffCopilotDock userName={user.name} />
      </div>
    </ActiveClientProvider>
  );
}
