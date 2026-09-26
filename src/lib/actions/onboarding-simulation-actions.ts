"use server";

import { requireAdmin } from "./_shared";
import { discoverOnboardingProfile, findSiteLogo } from "@/lib/onboarding-discovery";
import type { ChatLang, Discovery } from "@/lib/onboarding-chat";
import { isChatLang } from "@/lib/onboarding-i18n";

/**
 * The admin onboarding simulation's website scan: the REAL scan, so the admin
 * sees exactly what a client would be shown, and read-only like the rest of
 * the simulation. Agency overhead, never billed to a client.
 */
export async function simulateOnboardingDiscoveryAction(input: {
  website: string;
  companyName: string;
  language: ChatLang;
}): Promise<Discovery> {
  await requireAdmin();
  return discoverOnboardingProfile({
    website: String(input.website ?? "").slice(0, 500),
    companyName: String(input.companyName ?? "").slice(0, 200),
    language: isChatLang(input.language) ? input.language : "en",
    clientId: null,
  });
}

/** The simulation's "find our logo on the site": the real finder, read-only. */
export async function simulateOnboardingLogoAction(input: { website: string; companyName: string }): Promise<string | null> {
  await requireAdmin();
  return findSiteLogo({
    website: String(input.website ?? "").slice(0, 500),
    companyName: String(input.companyName ?? "").slice(0, 200),
  });
}
