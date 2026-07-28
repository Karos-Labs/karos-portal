import { requireUser } from "@/lib/auth";
import { listClients, listAssets, listJobs } from "@/lib/data";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CreateClientButton } from "@/components/create-client";
import { ClientsGrid, type ClientCardCounts } from "@/components/clients-grid";

export default async function ClientsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const clients = await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined);
  const [assets, jobs] = await Promise.all([listAssets(), listJobs()]);

  // Reduced HERE, not in the browser: the grid used to receive every asset and
  // every job in the database, serialized into the RSC payload, to print two
  // numbers per card. lastRunAt backs the "most recent run" sort.
  const counts: Record<string, ClientCardCounts> = {};
  const bump = (clientId: string): ClientCardCounts =>
    (counts[clientId] ??= { assets: 0, jobs: 0, lastRunAt: 0 });
  for (const asset of assets) bump(asset.clientId).assets++;
  for (const job of jobs) {
    const entry = bump(job.clientId);
    entry.jobs++;
    if (job.createdAt > entry.lastRunAt) entry.lastRunAt = job.createdAt;
  }

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
        <ClientsGrid clients={clients} counts={counts} />
      )}
    </>
  );
}
