import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getClient, listClientCompetitors, listClientIntegrations } from "@/lib/data";
import { getOAuthEnabledPlatforms } from "@/lib/integrations/oauth";
import { sanitizeIntegrations, sanitizeLinkedinSeats } from "@/lib/integrations/sanitize";
import { CREDIT_COSTS, DEFAULT_LINKEDIN_SEAT_LIMIT } from "@/lib/credits";
import { sanitizeChatDraft, seedFromClient } from "@/lib/onboarding-chat";
import { OnboardingChatWizard } from "@/components/onboarding-chat/onboarding-chat-wizard";
import type { ClientIntegration, EmployeeSeat } from "@/lib/types";

export const metadata = { title: "Welcome · Karos CMO" };

const NOTICE_COPY: Record<string, string> = {
  denied: "LinkedIn connection was cancelled. You can try again anytime.",
  not_configured: "LinkedIn connection isn't configured yet. You can finish setup and connect it later.",
  invalid_state: "That LinkedIn link expired. Please try connecting again.",
  error: "Something went wrong connecting LinkedIn. You can try again or finish setup without it.",
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ linkedin_seat?: string }>;
}) {
  const { linkedin_seat: linkedinSeatStatus } = await searchParams;

  const user = await getCurrentUser();
  if (!user || !user.clientId) redirect("/dashboard");

  const [client, rawIntegrations, competitors] = await Promise.all([
    getClient(user.clientId),
    listClientIntegrations(user.clientId),
    listClientCompetitors(user.clientId).catch(() => []),
  ]);
  if (!client) redirect("/dashboard");

  const notice =
    linkedinSeatStatus && linkedinSeatStatus !== "connected" ? NOTICE_COPY[linkedinSeatStatus] ?? null : null;

  // Same rule as the Settings page: an existing workspace's LinkedIn Company
  // Employee Roster must show its real seats here too, not an always-empty one.
  const linkedIntegration = rawIntegrations.find((i) => i.platform === "linkedin") as ClientIntegration | undefined;
  const linkedinSeats = sanitizeLinkedinSeats(linkedIntegration?.employeeSeats as EmployeeSeat[] | undefined);

  return (
    <OnboardingChatWizard
      user={user}
      clientId={client.id}
      // A workspace set up before (an invited user of an existing client) is
      // confirmed from its record - accounts, logo, competitors - with no
      // website scan; a blank one is scanned and asked.
      seed={seedFromClient(client, competitors.map((c) => c.company))}
      initialDraft={sanitizeChatDraft(user.onboardingChatDraft)}
      notice={notice}
      integrations={sanitizeIntegrations(rawIntegrations)}
      oauthEnabledPlatforms={getOAuthEnabledPlatforms()}
      linkedinSeats={linkedinSeats}
      seatLimit={client.linkedinSeatLimit ?? DEFAULT_LINKEDIN_SEAT_LIMIT}
      seatCost={CREDIT_COSTS.employeeSeat}
    />
  );
}
