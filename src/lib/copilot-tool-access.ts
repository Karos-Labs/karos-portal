import type { AppUser, ClientIntegration } from "@/lib/types";

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
 * The tools a CLIENT session may be offered. An ALLOWLIST, deliberately.
 *
 * This started as its inverse — a `STAFF_ONLY_COPILOT_TOOLS` denylist naming
 * the one tool that had already leaked. A denylist fails open: the next write
 * tool registered on the route is client-callable from the moment it is added,
 * and stays that way until somebody remembers this file. The list that has to
 * be maintained should be the one whose omission is SAFE, so a new tool is
 * withheld from clients until it is named here on purpose.
 *
 * Why these are safe to expose: `send_support_email` mails the client's own
 * Karos team, `fetch_gmail_context` reads only the caller's OWN mailbox because
 * `integrationBelongsToCaller` gates it to the person who granted the token, and
 * `create_tasks` writes to that client's own board — all client-tier state the
 * portal already lets them change by hand.
 *
 * The gmail clause here used to justify itself on thread membership — that
 * whatever it read, the asker was necessarily part of. (The old wording is not
 * reproduced, so nobody skimming mistakes it for the live rationale; a test pins
 * its absence.) It was false. The `google` integration is stored one-per-WORKSPACE
 * (`${clientId}_google`, data.ts) from one individual's personal OAuth grant, so
 * in any multi-seat workspace — the designed norm: a client key auto-approves
 * signups into a group, and group admins manage others in it — a second user
 * asking the copilot to scan "their" inbox was handed the FIRST user's private
 * email. The premise held only for a single-seat workspace and nobody said so.
 * This entry was carried across when e440f0b inverted the denylist to an
 * allowlist precisely so each inclusion would be a deliberate act; the carry-over
 * is the failure that inversion existed to prevent. The premise is now true
 * because the read site enforces it, not because a comment asserts it.
 *
 * The §3 capability-matrix tools (chat/route.ts) are safe for the same reason:
 * `find_output` only reads this client's own already-prompt-scoped assets,
 * `edit_output` wraps `updateAssetAction`'s existing content-only client path
 * (status stays staff-only there, unchanged), `run_agent_now` wraps the
 * already-client-safe `runCustomAgentAction`, `provide_feedback` wraps the
 * existing `addClientAgentFeedbackAction` (client-authorable by design), and
 * `reschedule_output` branches internally on `isStaffCopilotActor` — a client
 * session can only ever reach its own scoped `clientRescheduleAssetAction`
 * path (own asset, approved/scheduled only, date only), never the staff one.
 * `set_agent_focus` only ever reads this client's own live umbrella names and
 * returns a client-safe confirmation string — it writes nothing.
 *
 * The tool that is NOT here is `update_branding_guidelines`: it rewrites the
 * `branding-guidelines` context doc, which lives at the INTERNAL tier —
 * analyst-grade copy types.ts restricts to admin/employee and every agent
 * prompt reads as ground truth. A client who wants their colors or tone changed
 * has the audited path instead: the brand panel in their rail
 * (BrandColorsSection → BrandingModal → saveBrandingGuidelinesAction), which
 * authorizes, preserves the internal usage mix, and writes a BRANDING_UPDATED
 * activity log. The chat tool did none of those three.
 */
export const CLIENT_SAFE_COPILOT_TOOLS = [
  "send_support_email",
  "fetch_gmail_context",
  "create_tasks",
  "find_output",
  "edit_output",
  "run_agent_now",
  "reschedule_output",
  "provide_feedback",
  "set_agent_focus",
] as const;

export type ClientSafeCopilotTool = (typeof CLIENT_SAFE_COPILOT_TOOLS)[number];

/** Is this tool name on the client allowlist? */
export function isClientSafeCopilotTool(name: string): boolean {
  return (CLIENT_SAFE_COPILOT_TOOLS as readonly string[]).includes(name);
}

/**
 * Whether a real staff account is driving this copilot session.
 *
 * IMPERSONATION IS NOT STAFF HERE. An admin in "View as Client" reaches the
 * route as a CLIENT_USER carrying `impersonatedBy` (auth.ts), and the role test
 * below denies them — deliberately, and the `impersonatedBy` check is written
 * out rather than left implicit in the role so the intent survives a refactor
 * of AppUser. Impersonation exists to see what the client sees; it is not a
 * staff capability escalator.
 *
 * Note this is the OPPOSITE answer to `isBillableClientActor`, which excludes
 * impersonated sessions (`role === "CLIENT_USER" && !impersonatedBy`) so an
 * admin previewing a client's portal spends no real credits. An earlier comment
 * here claimed the two "draw the same line" — they draw opposite ones, and both
 * are correct, because they answer different questions. Credits ask "should
 * this cost the client money?" and an admin's preview should not. Capability
 * asks "may this session write staff-tier state?" and a session rendering the
 * client's own surface must not, whoever is behind it.
 */
export function isStaffCopilotActor(user: Pick<AppUser, "role" | "impersonatedBy">): boolean {
  if (user.impersonatedBy) return false;
  return user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
}

/**
 * Build a client session's registry from the allowlist, so the model is never
 * even offered anything else. This is the primary fence: a tool absent from the
 * registry cannot be called at all.
 *
 * The cast preserves the AI SDK's ToolSet shape — `streamText` wants a concrete
 * record of tools, and a Partial<> would make every value `Tool | undefined`.
 * The runtime key selection is the boundary; the type is only describing it.
 */
export function copilotToolsFor<T extends Record<string, unknown>>(
  user: Pick<AppUser, "role" | "impersonatedBy">,
  tools: T,
): T {
  if (isStaffCopilotActor(user)) return tools;
  const allowed: Record<string, unknown> = {};
  for (const [name, impl] of Object.entries(tools)) {
    if (isClientSafeCopilotTool(name)) allowed[name] = impl;
  }
  return allowed as T;
}

/**
 * What the model is handed back when a client session reaches a staff-only
 * write anyway. Names the surface the client CAN use, so the refusal is
 * actionable rather than a dead end.
 */
export const BRANDING_TOOL_REFUSAL =
  "Branding guidelines can't be changed from chat. You can edit them yourself from the brand panel in the left rail. The pencil beside Brand colors. Or ask your Karos team to make the change.";

/** The line a non-allowlisted tool gives back when no better one is written. */
export const COPILOT_TOOL_REFUSAL =
  "That isn't something I can change from chat. Ask your Karos team and they'll take care of it.";

/** Tool-specific refusals, so the message can name the surface that DOES work. */
const REFUSAL_BY_TOOL: Record<string, string> = {
  update_branding_guidelines: BRANDING_TOOL_REFUSAL,
};

/**
 * Defence in depth behind `copilotToolsFor`, derived from the SAME allowlist.
 *
 * The registry filter already keeps a non-allowlisted tool out of a client
 * session; this refuses inside `execute` too, so the write still cannot happen
 * if a tool is ever wired up by hand or the filter is dropped in a refactor.
 * Deriving it from the list rather than naming a tool means the second fence
 * covers a newly added tool automatically — the whole point of inverting the
 * list. Returns the refusal string, or null to proceed.
 */
export function copilotToolRefusal(
  user: Pick<AppUser, "role" | "impersonatedBy">,
  toolName: string,
): string | null {
  if (isStaffCopilotActor(user)) return null;
  if (isClientSafeCopilotTool(toolName)) return null;
  return REFUSAL_BY_TOOL[toolName] ?? COPILOT_TOOL_REFUSAL;
}

/** The branding tool's own call site — kept so the route reads at its level. */
export function brandingToolRefusal(
  user: Pick<AppUser, "role" | "impersonatedBy">,
): string | null {
  return copilotToolRefusal(user, "update_branding_guidelines");
}

/* ── Gmail: whose mailbox is this? ──────────────────────────────────────── */

/**
 * Whether a client integration was granted by the person now asking to use it.
 *
 * `upsertClientIntegration` keys integration docs `${clientId}_${platform}`, so a
 * workspace holds exactly ONE `google` row — written from one individual's
 * personal OAuth grant, with that person's verified address recorded in
 * `accountName` (task-actions.ts checks it against Google's tokeninfo before
 * storing, so it is trustworthy). Until this gate existed the copilot resolved
 * that row with no reference to who was asking, and read the mailbox behind it.
 *
 * FAILS CLOSED on a blank or missing `accountName`: a grant we cannot attribute
 * to a person is not one we may read on anyone's behalf. Case- and
 * whitespace-insensitive, because an address is the same address either way and
 * the alternative is a gate that leaks on a stray trailing space.
 *
 * Deliberately says nothing about roles. Staff are subject to it too — a token
 * that reads one human's private mail should be usable only by that human, and
 * widening that is a product decision to be taken on purpose, not a default.
 *
 * FOLLOW-UP, not done here: the real model is one integration doc per USER
 * (`${clientId}_${userUid}_${platform}`), which would make a second seat's grant
 * representable at all instead of overwriting the first's. That is a migration of
 * live production Firestore, so this gate is the correct fix for now — it closes
 * the read with the identity the existing schema already records.
 */
export function integrationBelongsToCaller(
  integration: Pick<ClientIntegration, "accountName">,
  callerEmail: string | null | undefined,
): boolean {
  const grantor = (integration.accountName ?? "").trim().toLowerCase();
  const caller = (callerEmail ?? "").trim().toLowerCase();
  if (!grantor || !caller) return false;
  return grantor === caller;
}

/**
 * The ONE thing `fetch_gmail_context` says when it will not read a mailbox.
 *
 * Both reasons share this string, and share it as a constant rather than as two
 * copies of the same prose: there is no Google grant in this workspace, and
 * there is one but it is somebody else's. A distinct message for the second case
 * would itself be the disclosure — it would tell user B that user A connected
 * their mail. So this must never name the grantor, never say "connected by
 * someone else", and never hint that a token exists. The refused path has to be
 * indistinguishable from the unconnected one, which is why the route gates at
 * the lookup and lets one branch serve both.
 *
 * Text is otherwise unchanged from the original unconnected-case copy, on
 * purpose. The one edit is punctuation: the spaced hyphen ledger F71 bans in
 * client copy sat at the END of one concatenated literal with the word that
 * follows it in the next, which is how it survived a sweep looking for `" - "` a
 * literal at a time.
 */
export const GMAIL_UNAVAILABLE_MESSAGE =
  "No Google Workspace integration found for this account. " +
  "To enable Gmail scanning, sign in with Google via the Login page (or Integrations tab)" +
  "you will be prompted to grant Gmail read access. " +
  "In the meantime, I can still build a task map from your meetings and context documents.";
