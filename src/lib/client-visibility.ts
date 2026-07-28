import type { BrandingGuidelines, Client } from "@/lib/types";

/**
 * BrandColor.usagePct is the agency's internal mix guidance (CD-E2). Clients
 * get swatches only, so it is removed HERE — at the boundary — not hidden
 * behind a render conditional: the rail is a "use client" component, so a
 * field that reaches it is readable from view-source whether or not it is
 * painted. Same rule as the rest of this projection: build by construction.
 */
function toClientBrandingView(g: BrandingGuidelines): BrandingGuidelines {
  if (!g.dominantColors?.length) return g;
  return {
    ...g,
    dominantColors: g.dominantColors.map(({ hex, dominanceRank, role }) => ({
      hex,
      dominanceRank,
      ...(role ? { role } : {}),
    })),
  };
}

/**
 * Whether the last workspace-generation run failed, asked the one way that
 * works on BOTH sides of the boundary (F69).
 *
 * Staff hold the raw reason; a client viewer holds only the flag. Every surface
 * that renders for both — the banner, the documents rail — asks this instead of
 * testing the string, so neither one has to know which projection it is looking
 * at, and neither one can start painting a reason a client should not receive.
 */
export function hasAiProcessingFailure(
  c: Pick<Client, "aiProcessingError" | "aiProcessingFailed">,
): boolean {
  return c.aiProcessingFailed === true || Boolean(c.aiProcessingError);
}

/**
 * The Client projection a CLIENT_USER's browser may receive.
 *
 * The client shell hands the whole client document to ClientRail, which is a
 * "use client" component — so every field on it is serialized into the RSC
 * payload of every client-portal page and is readable from view-source. That
 * shipped `clientKeyId`, the join token that auto-approves any signup straight
 * into the workspace, to ordinary client users regardless of the settings-card
 * gate (QA F56 verifier bounce).
 *
 * Built by CONSTRUCTION, never spread-and-delete — same rule as
 * redactLockedAsset — so any field added to Client later is excluded by
 * default and has to be opted in here.
 *
 * Deliberately excluded: clientKeyId (the join token), assignedEmployeeIds and
 * agentsRepoSlug (internal routing), logoStoragePath (storage internals),
 * onboardingStatus / onboardingError (internal pipeline state), customAgentIds
 * and linkedinSeatLimit (entitlement config the rail never reads), createdBy.
 */
export function toClientPortalView(c: Client): Client {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    // Profile fields the rail's own panels render and let the client edit.
    ...(c.website ? { website: c.website } : {}),
    ...(c.industry ? { industry: c.industry } : {}),
    ...(c.category ? { category: c.category } : {}),
    ...(c.teamSize ? { teamSize: c.teamSize } : {}),
    ...(c.brief ? { brief: c.brief } : {}),
    ...(c.socialLinks ? { socialLinks: c.socialLinks } : {}),
    ...(c.contactEmail ? { contactEmail: c.contactEmail } : {}),
    ...(c.domains ? { domains: c.domains } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.brandVoice ? { brandVoice: c.brandVoice } : {}),
    ...(c.logoUrl ? { logoUrl: c.logoUrl } : {}),
    ...(c.accentColor ? { accentColor: c.accentColor } : {}),
    ...(c.brandingGuidelines
      ? { brandingGuidelines: toClientBrandingView(c.brandingGuidelines) }
      : {}),
    // Workspace-generation state the rail reads for the banner + empty states.
    ...(c.isAiProcessing != null ? { isAiProcessing: c.isAiProcessing } : {}),
    ...(c.aiProcessingStartedAt != null
      ? { aiProcessingStartedAt: c.aiProcessingStartedAt }
      : {}),
    // THAT the run failed, never WHY (F69). aiProcessingError is a raw provider
    // error — truncated at 500 chars, so a stack-ish fragment fits comfortably —
    // and both client-side readers of it only ever asked whether it was set. A
    // string that crosses this boundary is readable from view-source whether or
    // not anything paints it, so the boolean is what crosses and the reason
    // stays staff-side. hasAiProcessingFailure is how every reader asks.
    ...(c.aiProcessingError ? { aiProcessingFailed: true } : {}),
    // assignedEmployeeIds is required on the type; the client's own view is empty.
    assignedEmployeeIds: [],
    createdAt: c.createdAt,
    createdBy: "",
  };
}
