import { requireUser } from "@/lib/auth";
import { listUsers, listClients } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { RegistrationManager } from "@/components/registration-manager";

export default async function RegistrationsPage() {
  await requireUser(["admin"]);
  const [users, clients] = await Promise.all([listUsers(), listClients()]);
  // Pending = self-signed-up and not yet approved (disabled, no approvedAt stamp).
  const pending = users.filter((u) => u.disabled && !u.approvedAt);

  return (
    <>
      <PageHeader
        title="Registrations"
        description="Approve new sign-ups, set their role and assign them to a client."
      />
      <RegistrationManager pending={pending} clients={clients} />
    </>
  );
}
