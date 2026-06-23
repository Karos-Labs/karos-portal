import { requireUser } from "@/lib/auth";
import { listUsers, listClients } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { TeamManager } from "@/components/team-manager";

export default async function TeamPage() {
  const user = await requireUser(["admin"]);
  const [allUsers, clients] = await Promise.all([listUsers(), listClients()]);
  // Pending self-signups live on the Registrations tab; Team shows approved members only.
  const users = allUsers.filter((u) => !(u.disabled && !u.approvedAt));
  return (
    <>
      <PageHeader title="Team" description="Manage employees, client logins and roles." />
      <TeamManager users={users} clients={clients} currentUid={user.uid} />
    </>
  );
}
