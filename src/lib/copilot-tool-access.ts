import type { AppUser } from "@/lib/types";

/**
 * Role gate for the copilot's write tools.
 *
 * The chat route at `/api/clients/[id]/chat` is reached by BOTH docks: the
 * client shell mounts CopilotDock for a CLIENT_USER, and the staff shell mounts
 * StaffCopilotDock once an admin picks a client. The route's only authorization
 * is "a CLIENT_USER may only address their own clientId" — which says nothing
 * about what a client may then ask a TOOL to write. This module is that second
 * question, kept out of the route so it can be driven by a test.
 */

/**
 * Tools that write staff-tier state and must never appear in a client
 * session's registry.
 *
 * `update_branding_guidelines` rewrites the `branding-guidelines` context doc,
 * which lives at the INTERNAL tier — analyst-grade copy that types.ts restricts
 * to admin/employee and that every agent prompt reads as ground truth. A client
 * who wants their colors or tone changed has the audited path instead: the
 * brand panel in their rail (BrandColorsSection → BrandingModal →
 * saveBrandingGuidelinesAction), which authorizes, preserves the internal usage
 * mix, and writes a BRANDING_UPDATED activity log. The chat tool did none of
 * those three.
 */
export const STAFF_ONLY_COPILOT_TOOLS = ["update_branding_guidelines"] as const;

export type StaffOnlyCopilotTool = (typeof STAFF_ONLY_COPILOT_TOOLS)[number];

/**
 * Whether a real staff account is driving this copilot session.
 *
 * An admin in "View as Client" impersonation reaches the route as a CLIENT_USER
 * carrying `impersonatedBy` (auth.ts), so the role test alone already denies
 * them — deliberately. Impersonation exists to see what the client sees; it is
 * not a staff capability escalator, and isBillableClientActor draws the same
 * line for credits. Anything that is not admin or employee is a client session.
 */
export function isStaffCopilotActor(user: Pick<AppUser, "role">): boolean {
  return user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
}

/**
 * Strip the staff-only tools out of a client session's registry, so the model
 * is never even offered them. This is the primary fence: a tool absent from the
 * registry cannot be called at all.
 *
 * The cast preserves the AI SDK's ToolSet shape — `streamText` wants a concrete
 * record of tools, and a Partial<> would make every value `Tool | undefined`.
 * The runtime key removal is the boundary; the type is only describing it.
 */
export function copilotToolsFor<T extends Record<string, unknown>>(
  user: Pick<AppUser, "role">,
  tools: T,
): T {
  if (isStaffCopilotActor(user)) return tools;
  const allowed: Record<string, unknown> = { ...tools };
  for (const name of STAFF_ONLY_COPILOT_TOOLS) delete allowed[name];
  return allowed as T;
}

/**
 * What the model is handed back when a client session reaches a staff-only
 * write anyway. Names the surface the client CAN use, so the refusal is
 * actionable rather than a dead end.
 */
export const BRANDING_TOOL_REFUSAL =
  "Branding guidelines can't be changed from chat. You can edit them yourself from the brand panel in the left rail — the pencil beside Brand colors — or ask your Karos team to make the change.";

/**
 * Defence in depth behind `copilotToolsFor`. The registry filter already keeps
 * the tool out of a client session; this refuses inside `execute` too, so the
 * write still cannot happen if the tool is ever wired up by hand or the filter
 * is dropped in a refactor. Returns the refusal string, or null to proceed.
 */
export function brandingToolRefusal(user: Pick<AppUser, "role">): string | null {
  return isStaffCopilotActor(user) ? null : BRANDING_TOOL_REFUSAL;
}
