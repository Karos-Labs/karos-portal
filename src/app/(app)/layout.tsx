import { getViewingContext } from "@/lib/auth";
import {
  listUsers,
  listClients,
  listAssignedActionItems,
  listReviewJobs,
  listClientTasks,
  getClient,
  getClientReport,
  listAgents,
  listClientContextDocs,
  listClientIntegrations,
  listClientCompetitors,
} from "@/lib/data";
import { ActiveClientProvider } from "@/lib/active-client-context";
import { Sidebar } from "@/components/sidebar";
import { ClientRail } from "@/components/client-rail";
import { CopilotDock } from "@/components/copilot-dock";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { AppHeader } from "@/components/app-header";
import type { ActionItemNotification, AgentReviewNotification, AppUser, Client, ClientTask } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isImpersonating, realAdmin } = await getViewingContext();

  let pendingCount = 0;
  let clients: Client[] = [];

  const [adminData, actionItems, reviewJobs, taskAlerts] = await Promise.all([
    user.role === "KAROS_ADMIN"
      ? Promise.all([listUsers(), listClients()]).then(([allUsers, allClients]) => ({
          allUsers,
          allClients,
        }))
      : Promise.resolve(null),
    listAssignedActionItems(user.uid),
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
      const [contextDocs, agents, integrations, report, competitors] = await Promise.all([
        listClientContextDocs(user.clientId),
        listAgents({ status: "published" }),
        listClientIntegrations(user.clientId),
        getClientReport(user.clientId),
        listClientCompetitors(user.clientId),
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
            />

            <div className="flex min-w-0 flex-1 flex-col">
              {isImpersonating && realAdmin && (
                <ImpersonationBanner realAdmin={realAdmin} viewingAs={user} />
              )}
              <main className="flex-1 px-4 pb-28 pt-6 md:px-8 md:pt-8 md:pb-16 lg:pb-8">
                <div className="mx-auto w-full max-w-5xl animate-fade-up">{children}</div>
              </main>
            </div>

            <CopilotDock
              clientId={client.id}
              clientName={client.name}
              agents={agents.filter((a) => a.isActive && !a.isSystem && a.id !== "intel-report-agent")}
              userName={user.name}
              hasGoogleIntegration={integrations.some(
                (i) => i.platform === "google" && i.status === "active",
              )}
              client={{ name: client.name, website: client.website, industry: client.industry }}
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
          />
          <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto w-full max-w-6xl animate-fade-up">{children}</div>
          </main>
        </div>
      </div>
    </ActiveClientProvider>
  );
}
