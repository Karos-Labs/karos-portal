import { getViewingContext } from "@/lib/auth";
import { listUsers, listClients, listClientRequests, listClientSeats } from "@/lib/data";
import type { ClientSeat } from "@/lib/types";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { TeamManager } from "@/components/team-manager";
import { RegistrationManager, ClientRequestManager } from "@/components/registration-manager";

export default async function TeamPage() {
  const { user } = await getViewingContext();

  if (user.role === "KAROS_EMPLOYEE") redirect("/dashboard");
  if (user.role === "CLIENT_USER" && !user.isGroupAdmin) redirect("/dashboard");

  const isAdmin = user.role === "KAROS_ADMIN";

  const [allUsers, allClients, accessRequests] = await Promise.all([
    listUsers(),
    listClients(),
    isAdmin ? listClientRequests("PENDING_APPROVAL") : Promise.resolve([]),
  ]);

  // Admins approve pending self-signups here; the roster below excludes them.
  const pending = isAdmin ? allUsers.filter((u) => u.disabled && !u.approvedAt) : [];

  let users;
  let clients;
  if (isAdmin) {
    users = allUsers.filter((u) => !(u.disabled && !u.approvedAt));
    clients = allClients;
  } else {
    // Group admin: only their client group, approved only
    users = allUsers.filter(
      (u) => u.clientId === user.clientId && !(u.disabled && !u.approvedAt),
    );
    // Scope the roster's clients too: it crosses to a client component, so every
    // client doc handed over here - clientKeyId included, which is enough to join
    // that client's workspace - is readable in the RSC payload.
    clients = allClients.filter((c) => c.id === user.clientId);
  }

  // The roster the LinkedIn/X seat agents draft personal content for — one
  // login can be linked to one of these, per client. Fetched per client
  // rather than globally since ClientSeat has no cross-client listing.
  const seatsByClient: Record<string, ClientSeat[]> = Object.fromEntries(
    await Promise.all(clients.map(async (c) => [c.id, await listClientSeats(c.id)] as const)),
  );

  return (
    <>
      <PageHeader
        title="Team"
        description={
          isAdmin
            ? "Approve sign-ups, manage employees, client logins and roles."
            : "Manage your team members."
        }
      />

      {isAdmin && (accessRequests.length > 0 || pending.length > 0) && (
        <div className="mb-10 space-y-10">
          {accessRequests.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-warning/20 text-warning text-[10px] font-bold">
                  {accessRequests.length}
                </span>
                New Client Access Requests
              </h2>
              <p className="mb-4 text-sm text-muted">
                These companies submitted the public request form. They don&apos;t have a Client Access
                Key yet. Review, then create a client and share their key.
              </p>
              <ClientRequestManager requests={accessRequests} />
            </section>
          )}

          {pending.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-warning/20 text-warning text-[10px] font-bold">
                  {pending.length}
                </span>
                Pending Account Sign-ups
              </h2>
              <RegistrationManager pending={pending} clients={clients} />
            </section>
          )}
        </div>
      )}

      <TeamManager
        users={users}
        clients={clients}
        seatsByClient={seatsByClient}
        currentUid={user.uid}
        currentUserRole={user.role}
        currentClientId={user.clientId ?? undefined}
      />
    </>
  );
}
