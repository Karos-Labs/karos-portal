import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  getClientCredits,
  listClientIntegrations,
  listCreditLedger,
  listTranscripts,
} from "@/lib/data";
import { getOAuthEnabledPlatforms } from "@/lib/integrations/oauth";
import { Card, CardTitle, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { IntegrationsTab } from "@/components/integrations-tab";
import { ClientKeyInline } from "@/components/client-key-inline";
import { CreditsPanel } from "@/components/credits-panel";
import { LogoutButton } from "@/components/logout-button";
import { relativeTime } from "@/lib/utils";

export default async function ClientSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const [integrations, transcripts, credits, creditLedger] = await Promise.all([
    listClientIntegrations(id),
    listTranscripts({ clientId: id }),
    getClientCredits(id),
    listCreditLedger(id, 15),
  ]);
  const oauthEnabledPlatforms = getOAuthEnabledPlatforms();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Connect channels, review meetings, and invite teammates."
        action={
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            <Icon name="User" className="h-3.5 w-3.5" />
            Account settings
          </Link>
        }
      />

      {/* Credits & usage */}
      <div className="mb-8">
        <CreditsPanel clientId={client.id} credits={credits} ledger={creditLedger} role={user.role} />
      </div>

      {/* Integrations */}
      <IntegrationsTab
        clientId={client.id}
        integrations={integrations}
        oauthEnabledPlatforms={oauthEnabledPlatforms}
        currentUserRole={user.role}
      />

      {/* Meetings */}
      <div className="mt-8">
        <Card>
          <CardTitle className="mb-3">Meetings</CardTitle>
          {transcripts.length === 0 ? (
            <p className="text-sm text-muted-2">
              No meetings linked yet. Calls synced from Fireflies appear here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {transcripts.slice(0, 12).map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/transcripts/${t.id}`}
                    className="flex items-center justify-between gap-3 py-2.5 transition-colors hover:bg-surface-2/40 -mx-2 rounded-lg px-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{t.title}</p>
                      <p className="text-xs text-muted-2">{relativeTime(t.meetingDate ?? t.createdAt)}</p>
                    </div>
                    <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Invite teammates */}
      {client.clientKeyId && (
        <div className="mt-8">
          <Card>
            <CardTitle className="mb-1">Invite your team</CardTitle>
            <p className="mb-3 text-sm text-muted-2">
              Share this key with a teammate so they can join your workspace.
            </p>
            <ClientKeyInline clientKeyId={client.clientKeyId} />
          </Card>
        </div>
      )}

      {/* Account */}
      <div className="mt-8">
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Account</CardTitle>
            <p className="mt-0.5 text-sm text-muted-2">Sign out of your Karos workspace.</p>
          </div>
          <LogoutButton />
        </Card>
      </div>
    </>
  );
}
