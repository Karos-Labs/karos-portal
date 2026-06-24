import { getViewingContext } from "@/lib/auth";
import { listUsers, listClients } from "@/lib/data";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { TeamManager } from "@/components/team-manager";

export default async function TeamPage() {
  const { user } = await getViewingContext();

  if (user.role === "employee") redirect("/dashboard");
  if (user.role === "client" && !user.isGroupAdmin) redirect("/dashboard");

  const [allUsers, clients] = await Promise.all([listUsers(), listClients()]);

  let users;
  if (user.role === "admin") {
    users = allUsers.filter((u) => !(u.disabled && !u.approvedAt));
  } else {
    // Group admin: only their client group, approved only
    users = allUsers.filter(
      (u) => u.clientId === user.clientId && !(u.disabled && !u.approvedAt),
    );
  }

  return (
    <>
      <PageHeader
        title="Team"
        description={
          user.role === "admin"
            ? "Manage employees, client logins and roles."
            : "Manage your team members."
        }
      />
      <TeamManager
        users={users}
        clients={clients}
        currentUid={user.uid}
        currentUserRole={user.role}
        currentClientId={user.clientId ?? undefined}
      />
    </>
  );
}
