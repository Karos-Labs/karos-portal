import { requireUser } from "@/lib/auth";
import { listClients, listAssets, listJobs } from "@/lib/data";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CreateClientButton } from "@/components/create-client";
import { ClientsGrid } from "@/components/clients-grid";

export default async function ClientsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const clients = await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined);
  const [assets, jobs] = await Promise.all([listAssets(), listJobs()]);

  return (
    <>
      <PageHeader title="Clients" description="The brands your agency runs." action={<CreateClientButton />} />

      {clients.length === 0 ? (
        <EmptyState
          icon={<Icon name="Building2" className="h-7 w-7" />}
          title="No clients yet"
          description="Add your first client to start running agents and storing their assets."
          action={<CreateClientButton />}
        />
      ) : (
        <ClientsGrid clients={clients} assets={assets} jobs={jobs} />
      )}
    </>
  );
}
