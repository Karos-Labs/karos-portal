import { requireUser } from "@/lib/auth";
import { listClients, listAssets, listJobs, getClientCredits } from "@/lib/data";
import { availableCredits } from "@/lib/credits";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CreateClientButton } from "@/components/create-client";
import { ClientsGrid, type ClientCardCounts } from "@/components/clients-grid";

export default async function ClientsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const clients = await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined);
  const [assets, jobs, creditsByClient] = await Promise.all([
    listAssets(),
    listJobs(),
    // Every credit denial tells the client to "ask your Karos team", but no
    // staff surface showed a balance - the only credits control in the product
    // was buried in one client's Settings page (QA F117). SPENDABLE, not raw
    // balance: it is the number the charge transaction actually honours.
    Promise.all(
      clients.map(async (c) => [c.id, availableCredits(await getClientCredits(c.id))] as const),
    ).then((entries) => Object.fromEntries(entries) as Record<string, number>),
  ]);

  // Reduced HERE, not in the browser: the grid used to receive every asset and
  // every job in the database, serialized into the RSC payload, to print two
  // numbers per card. lastRunAt backs the "most recent run" sort.
  //
  // Fenced to the VISIBLE clients, the same skip /jobs does (QA F37). `clients`
  // is scoped to an employee's assignments and `credits` is built from it, but
  // `counts` was keyed off the unfiltered listAssets()/listJobs() - so the map
  // handed to ClientsGrid carried the ids, volumes and last-run times of every
  // client in the database, including ones outside the employee's assignment
  // and orphans of deleted clients. Replacing the two full scans with a
  // server-side count() stays a handover item; the fence is what lands now.
  const visibleClientIds = new Set(clients.map((c) => c.id));
  const counts: Record<string, ClientCardCounts> = {};
  const bump = (clientId: string): ClientCardCounts =>
    (counts[clientId] ??= { assets: 0, jobs: 0, lastRunAt: 0 });
  for (const asset of assets) {
    if (!visibleClientIds.has(asset.clientId)) continue;
    bump(asset.clientId).assets++;
  }
  for (const job of jobs) {
    if (!visibleClientIds.has(job.clientId)) continue;
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
        <ClientsGrid clients={clients} counts={counts} credits={creditsByClient} />
      )}
    </>
  );
}
