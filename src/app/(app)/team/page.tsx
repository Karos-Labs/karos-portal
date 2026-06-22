import { requireUser } from "@/lib/auth";
import { listUsers, listClients } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { TeamManager } from "@/components/team-manager";

export default async function TeamPage() {
  const user = await requireUser(["admin"]);
  const [users, clients] = await Promise.all([listUsers(), listClients()]);
  return (
    <>
      <PageHeader title="Team" description="Manage employees, client logins and roles." />
      <TeamManager users={users} clients={clients} currentUid={user.uid} />
    </>
  );
}
