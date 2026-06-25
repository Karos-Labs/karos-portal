import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listClients, listAssets, listJobs } from "@/lib/data";
import { Card, Badge, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CreateClientButton } from "@/components/create-client";
import { initials } from "@/lib/utils";

export default async function ClientsPage() {
  const user = await requireUser(["admin", "employee"]);
  const clients = await listClients(user.role === "employee" ? { employeeId: user.uid } : undefined);
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clients.map((c) => {
            const assetCount = assets.filter((a) => a.clientId === c.id).length;
            const jobCount = jobs.filter((j) => j.clientId === c.id).length;
            return (
              <Link key={c.id} href={`/clients/${c.id}`}>
                <Card className="h-full hover:border-border-strong">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="flex h-11 w-11 items-center justify-center rounded-[12px] text-sm font-semibold"
                        style={{ background: (c.accentColor ?? "#2dff9e") + "1f", color: c.accentColor ?? "#2dff9e" }}
                      >
                        {initials(c.name)}
                      </div>
                      <div>
                        <p className="font-semibold">{c.name}</p>
                        <p className="text-xs text-muted-2">{c.industry || c.website || "—"}</p>
                      </div>
                    </div>
                    <Badge tone={c.status === "active" ? "neon" : "neutral"}>{c.status}</Badge>
                  </div>
                  <div className="mt-4 flex gap-4 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <Icon name="FolderOpen" className="h-3.5 w-3.5" /> {assetCount} assets
                    </span>
                    <span className="flex items-center gap-1">
                      <Icon name="ListChecks" className="h-3.5 w-3.5" /> {jobCount} jobs
                    </span>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
