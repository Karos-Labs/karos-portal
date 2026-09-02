import type { AppUser, BrandingGuidelines, Client } from "@/lib/types";
import { clientCategoryValue } from "@/lib/utils";

/**
 * WHICH CLIENTS A USER MAY OPEN — the rule, once.
 *
 * Three surfaces already stated it and a fourth did not. `listClients({
 * employeeId })` fences the eight staff LIST pages to an employee's assignments
 * (clients, jobs, assets, agents, dashboard, calendar, tasks, and the app
 * layout's bell feeds); `canStaffAccessClient` restates it for the MCP server;
 * `authorizeClient` in planned-run-actions enforces it on a write, refusing
 * with "You are not assigned to this client." So the fence is a PERMISSION, not
 * a cosmetic sort — but no `/clients/[id]` route asked it, and those routes are
 * where the data is actually served. Ten pages plus the nested layout each did
 * `getClient(id); if (!client) notFound()`, which answers "does this client
 * exist", so an unassigned employee who typed the URL got the full client
 * dashboard, settings (join token included), agents, and calendar.
 *
 * Pure and viewer-shaped so the server guard (`requireVisibleClient` in
 * auth.ts) and the MCP actor check ask the same function.
 *
 * A CLIENT_USER's own client is in the same answer deliberately: the pages
 * already redirect a client viewer who names someone else's id, and a rule that
 * covered only staff would leave the guard silently allowing any CLIENT_USER
 * through if a page ever forgot its redirect.
 *
 * TWO FIELDS EXPRESS ONE RELATIONSHIP, and this reads BOTH.
 * `Client.assignedEmployeeIds` holds the client's side of it;
 * `AppUser.assignedClientIds` holds the user's. They are different fields on
 * different documents and nothing keeps them in step. Only two code paths ever
 * write the client side — `createClientAction` (defaulting to the creating
 * user) and the client `approveRegistrationAction` mints for a new client user
 * (defaulting to the approving admin) — while BOTH of the admin's actual
 * assignment UIs (`createTeamMemberAction`, `approveRegistrationAction` for an
 * employee) write only the user side. So reading the client side alone fences
 * out every employee an admin has ever assigned through the team page, and no
 * screen in this app can grant the permission that reading demands. Either
 * field alone is therefore a lockout, and a guard whose permission cannot be
 * granted in-app is an outage.
 *
 * Unifying the two into one field is a DATA task — a Firestore migration plus a
 * decision about which side owns the relationship — and it is Daniel's, not
 * something to paper over here. Until then the OR is the honest reading: the
 * relationship exists if either document records it.
 *
 * THE DISCOVERABILITY HALF is now the same answer, not a second one.
 * `listClients({ employeeId })` used to query `assignedEmployeeIds` alone, so an
 * employee assigned through the team page could open their client's pages from a
 * link and saw nothing in any list. It now unions both sources and applies THIS
 * predicate as its final gate, so the list can never be wider than the fence.
 * What the gate cannot do is guarantee the union is COMPLETE — a new way to be
 * assigned added here needs a matching source there, or the list silently
 * under-shows. `listClients`' own note states that residual, and a test in
 * `client-list-visibility.test.ts` derives the expected list from this function so
 * the two are compared rather than trusted.
 *
 * Absent `assignedEmployeeIds` (legacy docs) reads as "assigned to nobody", and
 * so does an absent `assignedClientIds` — the OR FAILS CLOSED when neither
 * document records anything. Admins are unaffected.
 */
export function canViewClient(
  user: Pick<AppUser, "role" | "uid" | "clientId" | "assignedClientIds">,
  client: Pick<Client, "id" | "assignedEmployeeIds">,
): boolean {
  if (user.role === "KAROS_ADMIN") return true;
  if (user.role === "KAROS_EMPLOYEE") {
    return (
      (client.assignedEmployeeIds ?? []).includes(user.uid) ||
      // `!!client.id` for the same reason the CLIENT_USER branch guards
      // `user.clientId`: a nullish id must not match a stray nullish entry.
      (!!client.id && (user.assignedClientIds ?? []).includes(client.id))
    );
  }
  if (user.role === "CLIENT_USER") return !!user.clientId && user.clientId === client.id;
  return false;
}

/**
 * BrandColor.usagePct is the agency's internal mix guidance (CD-E2). Clients
 * get swatches only, so it is removed HERE — at the boundary — not hidden
 * behind a render conditional: the rail is a "use client" component, so a
 * field that reaches it is readable from view-source whether or not it is
 * painted.
 *
 * Built by CONSTRUCTION, which is the rule this module states two functions
 * down and this one was breaking: it spread `...g` and rebuilt one field, so
 * every OTHER field of BrandingGuidelines was opted in by default — including
 * `logoStoragePath`, the Firebase Storage path, which the Client-level
 * projection below is careful to exclude by name and which arrived anyway
 * nested one level in. And the early `return g` for a client with no palette
 * handed the stored object back whole.
 *
 * Everything the client's own surfaces read is listed. The eight legacy scalar
 * color fields stay because BrandingModal falls back to them for a client
 * whose record predates `dominantColors` — dropping them would show that
 * client an empty palette and let a save blank it.
 */
function toClientBrandingView(g: BrandingGuidelines): BrandingGuidelines {
  return {
    ...(g.dominantColors
      ? {
          dominantColors: g.dominantColors.map(({ hex, dominanceRank, role }) => ({
            hex,
            dominanceRank,
            ...(role ? { role } : {}),
          })),
        }
      : {}),
    // Legacy scalars — plain hexes, and the modal's fallback for old records.
    ...(g.primaryAccent ? { primaryAccent: g.primaryAccent } : {}),
    ...(g.secondaryAccent ? { secondaryAccent: g.secondaryAccent } : {}),
    ...(g.brandNeutralDark ? { brandNeutralDark: g.brandNeutralDark } : {}),
    ...(g.brandNeutralLight ? { brandNeutralLight: g.brandNeutralLight } : {}),
    ...(g.primaryColor ? { primaryColor: g.primaryColor } : {}),
    ...(g.secondaryColor ? { secondaryColor: g.secondaryColor } : {}),
    ...(g.uiBackground ? { uiBackground: g.uiBackground } : {}),
    ...(g.uiText ? { uiText: g.uiText } : {}),
    ...(g.fontHeading ? { fontHeading: g.fontHeading } : {}),
    ...(g.fontBody ? { fontBody: g.fontBody } : {}),
    ...(g.toneKeywords ? { toneKeywords: g.toneKeywords } : {}),
    ...(g.logoUrl ? { logoUrl: g.logoUrl } : {}),
    ...(g.guidelines ? { guidelines: g.guidelines } : {}),
    ...(g.visualStyle ? { visualStyle: g.visualStyle } : {}),
    updatedAt: g.updatedAt,
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
  // THE FALLBACK IS RESOLVED HERE, so `industry` does not cross at all. Both
  // names carried the same fact and both used to be shipped, while the panel
  // painted only the second — so a client whose value predated the rename saw an
  // empty chip in their own sidebar. The browser now receives one field, under
  // the name the panel's pencil writes back to.
  const category = clientCategoryValue(c);
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    // Profile fields the rail's own panels render and let the client edit.
    ...(c.website ? { website: c.website } : {}),
    ...(category ? { category } : {}),
    ...(c.teamSize ? { teamSize: c.teamSize } : {}),
    ...(c.brief ? { brief: c.brief } : {}),
    ...(c.socialLinks ? { socialLinks: c.socialLinks } : {}),
    ...(c.contactEmail ? { contactEmail: c.contactEmail } : {}),
    ...(c.starredAgentIds ? { starredAgentIds: c.starredAgentIds } : {}),
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

/**
 * The Client fields the STAFF shell's own client components read — the whole
 * list of them, and nothing else.
 *
 * The staff shell serialises a client into "use client" components from two
 * places: the `/clients/[id]` nested layout (ClientContextSync → the sidebar's
 * client rail, the context bar, the staff copilot dock) and the app layout's
 * client-context picker, which renders on EVERY staff page. Both handed over
 * whole `Client` documents, so `clientKeyId` — the join token that
 * auto-approves any signup straight into that client's workspace — sat in the
 * RSC payload of every staff page, alongside `logoStoragePath` (a Storage
 * path), `agentsRepoSlug` (the private lab repo's folder for this client),
 * `onboardingStatus` / `onboardingError`, `customAgentIds`,
 * `linkedinSeatLimit`, `assignedEmployeeIds`, `status`, `createdBy` and
 * `aiProcessingError` (a raw provider string). Nothing paints any of them; the
 * payload is readable from view-source anyway, which is the whole reason this
 * module's other projection exists. Those are the fields the list below
 * excludes — everything present is rendered or edited by a component this
 * shell mounts.
 *
 * Staff are ALLOWED to see all of that — this is not a permission fix, it is
 * the same "absent beats unrendered" rule applied to the shell that ships it.
 * The narrowing is what makes it stay narrow: `ActiveClientData["client"]` is
 * typed as this view, so a component that wants another field has to add it
 * here, in the open.
 *
 * Built by CONSTRUCTION, same as the two projections above. Declared as a Pick
 * of Client rather than a fresh interface so a full document still satisfies
 * every consumer's own field contract (`ClientProfileFields`,
 * `ClientIntelScheduleFields`) and the two shells stay interchangeable.
 *
 * `brandingGuidelines` crosses WHOLE, unlike the client portal's copy: the rail
 * mounts BrandColorsSection with `isStaff`, whose entire job is editing the
 * internal usagePct mix. `aiProcessingFailed` rather than the raw
 * `aiProcessingError` for the same reason F69 gave — the rail's only reader is
 * `hasAiProcessingFailure`, which wants a boolean, and the staff page that does
 * print the reason (AiProcessingBanner) is handed the full client by the PAGE,
 * not by this shell.
 */
export type StaffShellClientView = Pick<
  Client,
  // Identity + brand chrome: the picker rows, the rail header, the context bar.
  | "id"
  | "name"
  | "logoUrl"
  | "accentColor"
  | "brandingGuidelines"
  // Company profile: the narrow-width Company sheet mounts ClientProfilePanel,
  // which renders AND edits this set. `industry` is NOT here: it and `category`
  // are one field now, resolved to `category` by the projection below.
  | "website"
  | "category"
  | "teamSize"
  | "brief"
  | "description"
  | "brandVoice"
  | "contactEmail"
  | "domains"
  | "socialLinks"
  // The client's own pinned agents, for the rail's "AI agents" dropdown. Added
  // by the parity pass 2026-09 (ruling D3): the staff shell's client-context
  // arm mounts the client's real ClientRailAgentsNav now, and that component
  // sorts pinned agents to the front and paints their stars from this array.
  // A list of agent DOC IDS and nothing else — no secret, and the star toggle
  // it drives is authorized server-side by `toggleStarredAgentAction`.
  | "starredAgentIds"
  // Workspace-generation state: greys out Regenerate, badges the failure.
  | "isAiProcessing"
  | "aiProcessingStartedAt"
  | "aiProcessingFailed"
  // The Documents rail's Schedule modal, via clientIntelSchedule().
  | "intelScheduleEnabled"
  | "intelScheduleIntervalMonths"
  | "intelScheduleDayOfMonth"
  | "intelScheduleNextRunAt"
  | "lastIntelReportAt"
>;

export function toStaffShellView(c: Client): StaffShellClientView {
  // Same resolution as the client's own view: this shell mounts the same panel,
  // so it has to hand it the same one field.
  const category = clientCategoryValue(c);
  return {
    id: c.id,
    name: c.name,
    ...(c.website ? { website: c.website } : {}),
    ...(category ? { category } : {}),
    ...(c.teamSize ? { teamSize: c.teamSize } : {}),
    ...(c.brief ? { brief: c.brief } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.brandVoice ? { brandVoice: c.brandVoice } : {}),
    ...(c.contactEmail ? { contactEmail: c.contactEmail } : {}),
    ...(c.domains ? { domains: c.domains } : {}),
    ...(c.socialLinks ? { socialLinks: c.socialLinks } : {}),
    ...(c.starredAgentIds ? { starredAgentIds: c.starredAgentIds } : {}),
    ...(c.logoUrl ? { logoUrl: c.logoUrl } : {}),
    ...(c.accentColor ? { accentColor: c.accentColor } : {}),
    ...(c.brandingGuidelines ? { brandingGuidelines: c.brandingGuidelines } : {}),
    ...(c.isAiProcessing != null ? { isAiProcessing: c.isAiProcessing } : {}),
    ...(c.aiProcessingStartedAt != null
      ? { aiProcessingStartedAt: c.aiProcessingStartedAt }
      : {}),
    ...(hasAiProcessingFailure(c) ? { aiProcessingFailed: true } : {}),
    // The Documents rail's Schedule modal reads all five through
    // clientIntelSchedule(), which defaults every one of them.
    ...(c.intelScheduleEnabled != null ? { intelScheduleEnabled: c.intelScheduleEnabled } : {}),
    ...(c.intelScheduleIntervalMonths != null
      ? { intelScheduleIntervalMonths: c.intelScheduleIntervalMonths }
      : {}),
    ...(c.intelScheduleDayOfMonth != null
      ? { intelScheduleDayOfMonth: c.intelScheduleDayOfMonth }
      : {}),
    ...(c.intelScheduleNextRunAt !== undefined
      ? { intelScheduleNextRunAt: c.intelScheduleNextRunAt }
      : {}),
    ...(c.lastIntelReportAt != null ? { lastIntelReportAt: c.lastIntelReportAt } : {}),
  };
}
