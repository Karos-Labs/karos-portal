import { getClient, listClientIntegrations, listClients } from "@/lib/data";
import { getOAuthEnabledPlatforms } from "@/lib/integrations/oauth";
import { sanitizeIntegrations, sanitizeLinkedinSeats } from "@/lib/integrations/sanitize";
import { CREDIT_COSTS, DEFAULT_LINKEDIN_SEAT_LIMIT } from "@/lib/credits";
import { getCurrentUser } from "@/lib/auth";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { OnboardingPreviewPicker } from "@/components/onboarding-preview-picker";
import type { AppUser, Client, ClientIntegration, EmployeeSeat } from "@/lib/types";

export const metadata = { title: "Onboarding simulation · Karos CMO" };

/**
 * Admin dry run of the client onboarding wizard (account menu → "Simulate
 * onboarding"). The layout has already refused everyone but a real admin.
 *
 *   ?clientId=  absent → a blank new company and a blank new user;
 *               present → that client's stored profile and channels, the way
 *               an invited user of an existing client would meet them.
 *
 * Read-only by construction: the wizard's `simulation` prop skips every
 * server action and makes the uploaders and channel cards inert.
 */
export default async function OnboardingPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  const { clientId } = await searchParams;
  const admin = (await getCurrentUser())!;
  const clients = await listClients();

  const existing = clientId ? await getClient(clientId) : null;
  const rawIntegrations = existing ? await listClientIntegrations(existing.id) : [];
  const client: Client = existing ?? {
    id: "onboarding-simulation",
    name: "",
    assignedEmployeeIds: [],
    status: "active",
    // Never shown and never written; a fixed stamp keeps the render pure.
    createdAt: 0,
    createdBy: admin.uid,
  };
  // A fresh invitee: the email is the only thing a real invitation carries.
  const user: AppUser = {
    uid: "onboarding-simulation",
    email: "new.user@example.com",
    name: "",
    role: "CLIENT_USER",
    clientId: client.id,
    hasCompletedOnboarding: false,
    createdAt: 0,
  };

  const linkedIntegration = rawIntegrations.find((i) => i.platform === "linkedin") as ClientIntegration | undefined;

  return (
    <>
      <OnboardingPreviewPicker
        clients={clients.filter((c) => c.status !== "archived").map((c) => ({ id: c.id, name: c.name }))}
        selectedClientId={existing?.id ?? null}
      />
      <OnboardingWizard
        // Remount on a switch, so a new pick starts again from step 1.
        key={existing?.id ?? "new"}
        user={user}
        client={client}
        integrations={sanitizeIntegrations(rawIntegrations)}
        oauthEnabledPlatforms={getOAuthEnabledPlatforms()}
        linkedinSeats={sanitizeLinkedinSeats(linkedIntegration?.employeeSeats as EmployeeSeat[] | undefined)}
        seatLimit={client.linkedinSeatLimit ?? DEFAULT_LINKEDIN_SEAT_LIMIT}
        seatCost={CREDIT_COSTS.employeeSeat}
        simulation={{ exitHref: "/dashboard", mode: existing ? "existing" : "new" }}
      />
    </>
  );
}
