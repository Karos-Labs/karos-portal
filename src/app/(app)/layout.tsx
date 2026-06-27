import { getViewingContext } from "@/lib/auth";
import {
  listUsers,
  listClients,
  listAssignedActionItems,
  listReviewJobs,
} from "@/lib/data";
import { Sidebar } from "@/components/sidebar";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { AppHeader } from "@/components/app-header";
import type { ActionItemNotification, AgentReviewNotification, AppUser, Client } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isImpersonating, realAdmin } = await getViewingContext();

  let pendingCount = 0;
  let clientUsers: AppUser[] = [];
  let clients: Client[] = [];

  // Fetch sidebar data + notification data concurrently
  const [adminData, actionItems, reviewJobs] = await Promise.all([
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
  ]);

  if (adminData) {
    pendingCount = adminData.allUsers.filter((u) => u.disabled && !u.approvedAt).length;
    clientUsers = adminData.allUsers.filter((u) => u.role === "CLIENT_USER" && !u.disabled);
    clients = adminData.allClients;
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar
        user={user}
        pendingCount={pendingCount}
        realAdmin={realAdmin}
        clientUsers={clientUsers}
        clients={clients}
      />
      <div className="flex flex-1 flex-col min-w-0">
        {isImpersonating && realAdmin && (
          <ImpersonationBanner realAdmin={realAdmin} viewingAs={user} />
        )}
        <AppHeader
          actionItems={actionItems as ActionItemNotification[]}
          reviewJobs={reviewJobs}
        />
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-6xl animate-fade-up">{children}</div>
        </main>
      </div>
    </div>
  );
}
