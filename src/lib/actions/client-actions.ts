"use server";

import { randomBytes } from "crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import {
  createClient,
  updateClient,
  deleteClientCascade,
  getClientByKeyId,
  getClientOwnerEmail,
  tryAcquireAiProcessingLock,
  releaseAiProcessingLock,
} from "@/lib/data";
import { applyBrandingForClient } from "@/lib/branding";
import { requireUser } from "@/lib/auth";
import type { Client, SocialLinks } from "@/lib/types";
import { clampClientCategoryValue } from "@/lib/utils";
import { toStoredPace } from "@/lib/daily-pace";
import { isValidTimeZone } from "@/lib/run-cadence";
import { normalizeLabSlug } from "@/lib/lab-outputs-shared";
import { parseForbiddenTopics, validateForbiddenTopics } from "@/lib/dynamic-agent-guardrails";
import { requireStaff, logGenerationFailure } from "./_shared";

export async function createClientAction(input: {
  name: string;
  website?: string;
  /** The client's category. `industry` is its legacy spelling and is never written. */
  category?: string;
  contactEmail?: string;
  domains?: string;
  description?: string;
  brandVoice?: string;
  assignedEmployeeIds?: string[];
}): Promise<{ id: string }> {
  const user = await requireStaff();
  // Generate a cryptographically secure, unguessable join token for the new client.
  const clientKeyId = `ck_${randomBytes(16).toString("base64url")}`;
  const id = await createClient({
    name: input.name.trim(),
    website: input.website?.trim() || "",
    // The same ceiling every other category editor is held to — a new client's
    // category renders in the same chip as everybody else's on day one.
    category: clampClientCategoryValue(input.category),
    contactEmail: input.contactEmail?.trim().toLowerCase() || "",
    domains: (input.domains ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    description: input.description?.trim() || "",
    brandVoice: input.brandVoice?.trim() || "",
    assignedEmployeeIds: input.assignedEmployeeIds ?? [user.uid],
    status: "active",
    clientKeyId,
    onboardingStatus: "pending",
    createdAt: Date.now(),
    createdBy: user.uid,
  });

  // Onboarding trigger: fires immediately after the client record (with its
  // initial details/parameters) is persisted. runIntelReportPipeline re-fetches
  // the client from Firestore at execution time, so the Intel Report Agent
  // always operates on the live, current client state — never a captured copy.
  after(async () => {
    // Guards against overlapping this pipeline with a manual Regenerate /
    // Refresh Task Map click (or the client's own onboarding-completion run) —
    // released in the finally below regardless of outcome.
    if (!(await tryAcquireAiProcessingLock(id))) return;
    let failure: string | undefined;
    try {
      await updateClient(id, { onboardingStatus: "running", onboardingError: "" });
      const { runIntelReportPipeline } = await import("@/lib/intel");
      const [brandingResult, intelResult] = await Promise.allSettled([
        applyBrandingForClient(id),
        runIntelReportPipeline(id),
      ]);
      if (brandingResult.status === "rejected") {
        console.error("[onboard] Branding generation failed (non-fatal):", brandingResult.reason);
      }
      if (intelResult.status === "rejected") {
        console.error("[onboard] Intel Report generation failed:", intelResult.reason);
      }
      const anyFailed = brandingResult.status === "rejected" || intelResult.status === "rejected";
      // Persist WHY the run failed so the UI can surface it — a silent "failed"
      // badge with the reason buried in server logs is exactly what we're avoiding.
      const failureReasons = [
        brandingResult.status === "rejected" ? `branding: ${String((brandingResult.reason as Error)?.message ?? brandingResult.reason)}` : "",
        intelResult.status === "rejected" ? `intel: ${String((intelResult.reason as Error)?.message ?? intelResult.reason)}` : "",
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 500);
      if (anyFailed) failure = failureReasons;
      await updateClient(id, {
        onboardingStatus: anyFailed ? "failed" : "done",
        onboardingError: anyFailed ? failureReasons : "",
        ...(intelResult.status === "fulfilled" ? { lastIntelReportAt: Date.now() } : {}),
      });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      console.error("[onboard] Pipeline crashed unexpectedly:", e);
    } finally {
      await releaseAiProcessingLock(id, failure);
      await logGenerationFailure(id, failure);
    }
  });

  revalidatePath("/clients");
  return { id };
}

/**
 * Regenerate the clientKeyId for a client. Invalidates any previous join links.
 *
 * Staff, plus the workspace's OWN group admin: a valid client key auto-approves
 * any signup straight into that workspace, so the person who can hand it out
 * must also be able to rotate it after a leak (QA F56 — there was no
 * remediation path on screen at all). Ordinary client users may do neither.
 */
export async function regenerateClientKeyAction(clientId: string): Promise<{ clientKeyId: string }> {
  // Guard the id first: without it a group admin whose clientId is null would
  // satisfy `null === null` against an empty argument.
  if (!clientId) throw new Error("clientId required");
  const user = await requireUser();
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const isOwnGroupAdmin =
    user.role === "CLIENT_USER" && user.isGroupAdmin === true && user.clientId === clientId;
  if (!isStaff && !isOwnGroupAdmin) throw new Error("Forbidden");
  const clientKeyId = `ck_${randomBytes(16).toString("base64url")}`;
  await updateClient(clientId, { clientKeyId });
  revalidatePath(`/clients/${clientId}`);
  return { clientKeyId };
}

/**
 * The client's own address book, and the whole of it.
 *
 * Same authorization as `updateClientProfileAction` below, because it answers a
 * question about the same record: staff, or a member of this client's own
 * workspace. Anyone else gets an empty string rather than a refusal — the caller
 * is a prefill, and a modal that opens with an error banner because a stale tab
 * asked about the wrong workspace is worse than one that opens with an empty
 * field.
 *
 * No prose in either branch on purpose: this crosses to a client's browser, and
 * the only thing it can say is an address the caller already has a right to.
 */
export async function clientOwnerEmailAction(clientId: string): Promise<{ email: string }> {
  const user = await requireUser();
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff && !(user.role === "CLIENT_USER" && user.clientId === clientId)) {
    return { email: "" };
  }
  return { email: await getClientOwnerEmail(clientId) };
}

/**
 * Client-editable profile fields (self-service). A CLIENT_USER may update their
 * own client's category / team size / social links / contact email / website /
 * short description; staff may update any client. Deliberately narrow — no
 * access to keys, employees, status, etc.
 *
 * THREE FIELDS LEFT THIS ACTION WITH THE UI THAT SENT THEM (CD-L P1/P2), and
 * dropping them from the signature is the point rather than housekeeping — an
 * input this action still accepts is an input a crafted request can still write,
 * whatever the form on screen offers:
 *
 *  • `domainsCsv` decided which Fireflies transcripts auto-assign to a client.
 *    A client user could set it, which is a routing control with somebody else's
 *    meetings on the other end of it. It is staff-only now, through
 *    `updateClientAction`, which is where the Edit dialog already wrote it.
 *  • `brandVoice` duplicated the Brand Voice DOCUMENT. The field and the doc are
 *    untouched; nothing writes to the field from the portal any more.
 *  • `industry` was the second editor for the tag chip's idea. `category` is the
 *    one that stays, and it is the one the chip renders.
 */
export async function updateClientProfileAction(
  id: string,
  input: {
    category?: string;
    teamSize?: string;
    description?: string;
    socialLinks?: SocialLinks;
    // Brand profile fields — editable by the client's own users as well as staff.
    contactEmail?: string;
    website?: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff && !(user.role === "CLIENT_USER" && user.clientId === id)) {
    return { ok: false, error: "Not authorized to edit this profile." };
  }

  const clean = (v?: string) => (typeof v === "string" ? v.trim() : undefined);
  const patch: Partial<Client> = {};
  // The cap the input already enforces, enforced again where it counts: the
  // chip's one-line contract is a property of the STORED value, so a request
  // that did not come from that input cannot re-open the wrapping this closed.
  if (input.category !== undefined) patch.category = clampClientCategoryValue(input.category);
  if (input.teamSize !== undefined) patch.teamSize = clean(input.teamSize);
  if (input.description !== undefined) patch.description = clean(input.description);
  if (input.contactEmail !== undefined) patch.contactEmail = clean(input.contactEmail)?.toLowerCase();
  if (input.website !== undefined) patch.website = clean(input.website);
  if (input.socialLinks !== undefined) {
    const links: SocialLinks = {};
    for (const [k, val] of Object.entries(input.socialLinks)) {
      const c = clean(val);
      if (c) (links as Record<string, string>)[k] = c;
    }
    patch.socialLinks = links;
  }

  await updateClient(id, patch);
  revalidatePath(`/clients/${id}`);
  return { ok: true };
}

export async function updateClientAction(
  id: string,
  input: Partial<Client> & {
    domainsCsv?: string;
    /** As typed in the Edit dialog. Blank/unusable ⇒ that lane has no ceiling set. */
    clipsPerDay?: string;
    postsPerDay?: string;
    /** The forbidden-topics box, one topic per line. See dynamic-agent-guardrails.ts. */
    forbiddenTopicsText?: string;
  },
) {
  await requireStaff();
  const patch: Partial<Client> = { ...input };
  // Topic guardrails (docs/dynamic-agent-guardrails.md). Parsed here rather
  // than in the browser for the same reason the pace boxes are: this action
  // takes a whole Partial<Client>, so the parse has to happen on the write side
  // to be true of the API and not just of the one form that calls it.
  //
  // An empty box stores `[]`, not a dropped key — updateClient merges, so an
  // absent key would leave the previous list in force and clearing the box
  // would silently do nothing.
  if (input.forbiddenTopicsText !== undefined) {
    const topics = parseForbiddenTopics(input.forbiddenTopicsText);
    const error = validateForbiddenTopics(topics);
    if (error) return { ok: false as const, error };
    patch.forbiddenTopics = topics;
  } else if (patch.forbiddenTopics !== undefined) {
    // A caller that sent the array directly is held to the same limits.
    const topics = parseForbiddenTopics(patch.forbiddenTopics.join("\n"));
    const error = validateForbiddenTopics(topics);
    if (error) return { ok: false as const, error };
    patch.forbiddenTopics = topics;
  }
  delete (patch as Partial<Client> & { forbiddenTopicsText?: string }).forbiddenTopicsText;
  if (input.domainsCsv !== undefined) {
    patch.domains = input.domainsCsv.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    delete (patch as { domainsCsv?: string }).domainsCsv;
  }
  // THE PACE, from the two typed boxes. Sent as strings and resolved here, not
  // in the browser: these are ceilings a day planner walks, and a 0 or a NaN
  // reaching storage is a cursor that never finds a free day (see clampPerDay).
  // Both blank ⇒ `undefined`, which CLEARS the field and puts the client back on
  // the single item a day.
  if (input.clipsPerDay !== undefined || input.postsPerDay !== undefined) {
    // `null` rather than a dropped key when both boxes are blank: updateClient
    // merges, so an absent key would leave the previous pace in place and
    // clearing the boxes would appear to do nothing. Both spellings resolve to
    // the one-item-a-day default on the read side.
    patch.dailyPace =
      toStoredPace({
        clipsPerDay: Number(input.clipsPerDay),
        postsPerDay: Number(input.postsPerDay),
      }) ?? null;
  }
  delete (patch as Partial<Client> & { clipsPerDay?: string }).clipsPerDay;
  delete (patch as Partial<Client> & { postsPerDay?: string }).postsPerDay;
  // An unresolvable zone is stored as empty rather than kept: `clientTimeZone`
  // would fall back to the runtime's anyway, and a box that keeps showing a
  // typo the product is ignoring is worse than one that clears.
  if (patch.timeZone !== undefined) {
    const zone = patch.timeZone.trim();
    patch.timeZone = isValidTimeZone(zone) ? zone : "";
  }
  if (patch.dailyDigestEnabled !== undefined) {
    patch.dailyDigestEnabled = patch.dailyDigestEnabled === true;
  }
  if (patch.contactEmail) patch.contactEmail = patch.contactEmail.toLowerCase();
  // The same ceiling the client's own form is held to. A category typed by staff
  // renders in the same chip, in the same rail, at the same width.
  if (patch.category !== undefined) patch.category = clampClientCategoryValue(patch.category);
  // `industry` IS `category`, and this action no longer writes the old name
  // (CD-L). The Edit dialog's box used to send it, which is how the same fact
  // ended up in two fields with two ceilings and two editors — the client typed
  // a category into their profile chip while staff typed an industry here, and
  // the copilot and the intel pipeline read only the staff one. Stripped rather
  // than mapped: this takes a whole `Partial<Client>`, so silently redirecting
  // the key would let a stale caller overwrite a category it never named.
  // Stored values stay put; `clientCategoryValue` is what still reads them.
  delete (patch as Partial<Client> & { industry?: string }).industry;
  // Store just the client folder slug even if a full repo URL/path was pasted.
  if (patch.agentsRepoSlug !== undefined) patch.agentsRepoSlug = normalizeLabSlug(patch.agentsRepoSlug);
  // Immutable / security-sensitive fields — only dedicated actions may change these.
  delete (patch as Partial<Client> & { clientKeyId?: string }).clientKeyId;
  delete (patch as Partial<Client> & { createdAt?: number }).createdAt;
  delete (patch as Partial<Client> & { createdBy?: string }).createdBy;
  // The digest cron's own bookkeeping. It is a record of what was SENT, so a
  // staff edit that set it would suppress a client's mail for that day (or, set
  // backwards, send it twice). Nothing in the UI offers it; this action takes a
  // whole Partial<Client>, so the strip is what makes that true of the API too.
  delete (patch as Partial<Client> & { lastDigestSentDay?: number }).lastDigestSentDay;
  // `assignedEmployeeIds` is now a PERMISSION (canViewClient), and this action
  // is gated on requireStaff() alone while taking a whole Partial<Client> — so
  // an employee the fence excludes could post their own uid into the array and
  // lift it, which is the one field a fenced actor must not be able to write.
  // Nothing loses a capability: no surface in this app sends the field through
  // here (grep — the only writers are client creation and registration
  // approval), so this strips a hole rather than a feature. Reassignment needs
  // an admin-only action once the two-field split above is resolved.
  delete (patch as Partial<Client> & { assignedEmployeeIds?: string[] }).assignedEmployeeIds;
  await updateClient(id, patch);
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
  return { ok: true as const };
}

/**
 * Permanently delete a client and every scoped sub-document (tasks, assets,
 * jobs, docs, competitors, activity, …) via deleteClientCascade — orphaned
 * rows used to linger and resurface in cross-client staff views (task board,
 * assets, calendar) as phantom "spillage" from deleted clients.
 * Staff-only — admin or employee access required.
 */
export async function deleteClientAction(clientId: string): Promise<void> {
  await requireStaff();
  await deleteClientCascade(clientId);
  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`);
}

/**
 * Validate an invitation key before the user completes signup.
 * Public — no auth required. Returns the resolved role and a display label.
 * The key is re-validated server-side in ensureUserDoc when the session is created.
 */
export async function validateInvitationKeyAction(key: string): Promise<
  | { ok: true; role: "KAROS_EMPLOYEE"; label: string }
  | { ok: true; role: "CLIENT_USER"; clientId: string; label: string }
  | { ok: false; error: string }
> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "Enter your invitation key." };

  const staffKey = process.env.KAROS_STAFF_KEY;
  if (staffKey && trimmed === staffKey) {
    return { ok: true, role: "KAROS_EMPLOYEE", label: "Karos Labs Staff" };
  }

  const client = await getClientByKeyId(trimmed);
  if (client) {
    return { ok: true, role: "CLIENT_USER", clientId: client.id, label: client.name };
  }

  return { ok: false, error: "Invalid invitation key. Contact your Karos account manager." };
}
