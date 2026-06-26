import { requireUser } from "@/lib/auth";
import { listUsers, listClients, listClientRequests } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { RegistrationManager, ClientRequestManager } from "@/components/registration-manager";

export default async function RegistrationsPage() {
  await requireUser(["KAROS_ADMIN"]);
  const [users, clients, accessRequests] = await Promise.all([
    listUsers(),
    listClients(),
    listClientRequests("PENDING_APPROVAL"),
  ]);
  const pending = users.filter((u) => u.disabled && !u.approvedAt);

  return (
    <>
      <PageHeader
        title="Registrations"
        description="Approve new sign-ups, set their role and assign them to a client."
      />

      {accessRequests.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/20 text-amber-400 text-[10px] font-bold">
              {accessRequests.length}
            </span>
            New Client Access Requests
          </h2>
          <p className="mb-4 text-sm text-muted">
            These companies submitted the public request form — they don&apos;t have a Client Access
            Key yet. Review, then create a client and share their key.
          </p>
          <ClientRequestManager requests={accessRequests} />
        </section>
      )}

      <section>
        {accessRequests.length > 0 && (
          <h2 className="mb-3 text-sm font-semibold text-foreground">Pending Account Sign-ups</h2>
        )}
        <RegistrationManager pending={pending} clients={clients} />
      </section>
    </>
  );
}
