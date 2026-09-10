import { requireUser } from "@/lib/auth";
import { listClients, countAssetsForClients, listJobs, getClientCredits } from "@/lib/data";
import { availableCredits } from "@/lib/credits";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CreateClientButton } from "@/components/create-client";
import { ClientsGrid, type ClientCardCounts } from "@/components/clients-grid";

export default async function ClientsPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const clients = await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined);
  const visibleClientIds = new Set(clients.map((c) => c.id));
  const [assetCounts, jobs, creditsByClient] = await Promise.all([
    // ONE aggregation per visible client, not every asset document in the
    // database (review, 2026-09). Assets are the largest collection in the
    // store and this page printed one number per card from a full scan of it.
    countAssetsForClients([...visibleClientIds]),
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
  // Fenced to the VISIBLE clients, the same skip /jobs does (QA F37). The asset
  // half is now a per-client count() (above); the job half still walks the jobs
  // collection because `lastRunAt` needs each client's newest `createdAt`, and
  // an ordered per-client query would need a composite index this project does
  // not manage in code. Jobs are the smaller collection by an order of
  // magnitude, so that is the scan worth keeping.
  const counts: Record<string, ClientCardCounts> = {};
  const bump = (clientId: string): ClientCardCounts =>
    (counts[clientId] ??= { assets: 0, jobs: 0, lastRunAt: 0 });
  for (const [clientId, assets] of Object.entries(assetCounts)) {
    if (assets > 0) bump(clientId).assets = assets;
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
