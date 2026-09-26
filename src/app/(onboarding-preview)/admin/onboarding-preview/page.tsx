import { getClient, listClientCompetitors, listClientIntegrations, listClients } from "@/lib/data";
import { getOAuthEnabledPlatforms } from "@/lib/integrations/oauth";
import { sanitizeIntegrations, sanitizeLinkedinSeats } from "@/lib/integrations/sanitize";
import { CREDIT_COSTS, DEFAULT_LINKEDIN_SEAT_LIMIT } from "@/lib/credits";
import { seedFromClient } from "@/lib/onboarding-chat";
import { OnboardingChatWizard } from "@/components/onboarding-chat/onboarding-chat-wizard";
import { OnboardingPreviewPicker } from "@/components/onboarding-preview-picker";
import type { ClientIntegration, EmployeeSeat } from "@/lib/types";

export const metadata = { title: "Onboarding simulation · Karos CMO" };

/**
 * Admin dry run of client onboarding (account menu → "Simulate onboarding").
 * The layout has already refused everyone but a real admin.
 *
 *   ?clientId=  absent → a blank new company and a blank new user;
 *               present → that client's stored profile and channels, the way
 *               an invited user of an existing client would meet them.
 *
 * Read-only by construction: with `simulation` set the wizard saves no draft,
 * never calls Finish, and renders the uploaders and channel cards inert. The
 * website scan is the real one (through an admin-only action) so what the
 * admin sees is what a client would be shown.
 */
export default async function OnboardingPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  const { clientId } = await searchParams;
  const clients = await listClients();

  const existing = clientId ? await getClient(clientId) : null;
  const [rawIntegrations, competitors] = existing
    ? await Promise.all([listClientIntegrations(existing.id), listClientCompetitors(existing.id).catch(() => [])])
    : [[], []];
  const linkedIntegration = rawIntegrations.find((i) => i.platform === "linkedin") as ClientIntegration | undefined;

  return (
    <>
      <OnboardingPreviewPicker
        clients={clients.filter((c) => c.status !== "archived").map((c) => ({ id: c.id, name: c.name }))}
        selectedClientId={existing?.id ?? null}
      />
      <OnboardingChatWizard
        // Remount on a switch, so a new pick starts again from the top.
        key={existing?.id ?? "new"}
        // A fresh invitee: no name, photo or CV yet.
        user={{ name: "", role: "CLIENT_USER" }}
        clientId={existing?.id ?? "onboarding-simulation"}
        seed={existing ? seedFromClient(existing, competitors.map((c) => c.company)) : {}}
        integrations={sanitizeIntegrations(rawIntegrations)}
        oauthEnabledPlatforms={getOAuthEnabledPlatforms()}
        linkedinSeats={sanitizeLinkedinSeats(linkedIntegration?.employeeSeats as EmployeeSeat[] | undefined)}
        seatLimit={existing?.linkedinSeatLimit ?? DEFAULT_LINKEDIN_SEAT_LIMIT}
        seatCost={CREDIT_COSTS.employeeSeat}
        simulation={{ exitHref: "/dashboard", mode: existing ? "existing" : "new" }}
      />
    </>
  );
}
