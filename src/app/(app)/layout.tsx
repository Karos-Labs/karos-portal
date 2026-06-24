import { getViewingContext } from "@/lib/auth";
import { listUsers, listClients } from "@/lib/data";
import { Sidebar } from "@/components/sidebar";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import type { AppUser, Client } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isImpersonating, realAdmin } = await getViewingContext();

  let pendingCount = 0;
  let clientUsers: AppUser[] = [];
  let clients: Client[] = [];

  if (user.role === "admin") {
    const [allUsers, allClients] = await Promise.all([listUsers(), listClients()]);
    pendingCount = allUsers.filter((u) => u.disabled && !u.approvedAt).length;
    clientUsers = allUsers.filter((u) => u.role === "client" && !u.disabled);
    clients = allClients;
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
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-6xl animate-fade-up">{children}</div>
        </main>
      </div>
    </div>
  );
}
