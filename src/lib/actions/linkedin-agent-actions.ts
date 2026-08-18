"use server";

/**
 * LinkedIn agent (e10) intake actions: the company-page form, per-person seat
 * forms (the lab seat-intake-template's 6 fields, incl. the private CV upload
 * and the inactive-on-LinkedIn fallback), and per-draft feedback. ASK-only
 * fields per the input contract — voice, pillars, cadence, language and
 * launch-vs-ongoing are built by the agent, never asked here.
 *
 * The "what happened this week" news drop is SHARED with the X agent
 * (SCRUM-51): both pages write through addXNewsUpdateAction into the one
 * xNewsUpdates collection — there is deliberately no LinkedIn news action.
 *
 * Seats are platform-agnostic (ClientSeat): adding a LinkedIn seat for a
 * person who already has an X seat attaches LinkedIn intake to the SAME seat.
 */

import { revalidatePath } from "next/cache";
import {
  addLiDirectionRequest,
  addLiDraftFeedback,
  clearAgentIntakeFields,
  createAsset,
  createClientSeat,
  deleteLiDirectionRequest,
  getAgentIntake,
  getAsset,
  getClient,
  getClientSeat,
  getCustomAgentByKey,
  listClientSeats,
  listLiDraftFeedback,
  patchAgentIntake,
  upsertAgentIntake,
  upsertClientActionState,
} from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import { resolveAccountTitleToSeat } from "@/lib/client-seats";
import { laneLabel } from "@/lib/draft-lane-label";
import { parseLiDrafts } from "@/lib/li-drafts";
import {
  LI_IDENTITY_FIELD_KEY,
  LINKEDIN_SETUP_V2_KEY,
} from "@/lib/agent-service/linkedin-agent-context";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { clientSafeRunError } from "@/lib/custom-agent-launch";
import { isBillableClientActor } from "@/lib/credits";
import { requireClientAccess } from "./_shared";

const MAX_TEXT = 2_000;
/** LinkedIn's post cap — finalText of a picked-with-edits post may run to it. */
const MAX_POST_TEXT = 3_000;
const MAX_NAME = 120;
const MAX_CV_BYTES = 10 * 1024 * 1024;
const CV_EXTENSIONS = [".pdf", ".docx", ".txt"] as const;

function kebab(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Normalizes a LinkedIn profile/page URL; empty/none stays null (company
 * "none yet", seat "pending"). Accepts linkedin.com paths with or without
 * protocol, case-insensitively, and truncates to the identity root (the
 * first two path segments) so drafts never route to a mistyped identity.
 * `kind` pins person URLs to seats and page URLs to the company form.
 */
function parseLinkedInUrl(raw: string, kind: "person" | "page"): string | null | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed || /^(none|none yet|pending)$/i.test(trimmed)) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: "That does not look like a LinkedIn URL." };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) {
    return { error: "Use a linkedin.com profile or page URL." };
  }
  const match = url.pathname.match(/^\/(in|company|school|showcase)\/([^/]+)/i);
  if (!match) {
    return { error: "Use the full URL, like linkedin.com/in/your-name or linkedin.com/company/your-company." };
  }
  const section = match[1].toLowerCase();
  if (kind === "person" && section !== "in") {
    return { error: "A seat needs the person's own profile URL (linkedin.com/in/...)." };
  }
  if (kind === "page" && section === "in") {
    return { error: "This is the company page's URL (linkedin.com/company/...), not a personal profile." };
  }
  return `https://www.linkedin.com/${section}/${match[2]}`;
}

/* ─────────────────────────── the forms ─────────────────────────── */

/**
 * Both text answers are OPTIONAL by contract (ASK vs BUILD: the page's voice
 * comes from the onboarding brand-voice doc; this only adds a LinkedIn
 * register note, and house rules apply without an off-limits answer). Saving
 * the form — even empty — is what satisfies the run gate.
 */
export async function saveLinkedInCompanyIntakeAction(input: {
  clientId: string;
  /** The company page URL (linkedin.com/company/...). Empty = none yet. */
  pageUrl: string;
  comeAcross: string;
  offLimits: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  if (input.comeAcross.length > MAX_TEXT || input.offLimits.length > MAX_TEXT) {
    return { error: "Please keep each answer under 2,000 characters." };
  }
  const pageUrl = parseLinkedInUrl(input.pageUrl, "page");
  if (pageUrl !== null && typeof pageUrl === "object") return pageUrl;
  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "linkedin",
    seatId: null,
    handle: pageUrl,
    comeAcross: input.comeAcross.trim(),
    offLimits: input.offLimits.trim(),
    roster: [],
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  // The AI Agents page renders these forms inline in the agent's run dialog and
  // derives the run gate from the same docs, so it goes stale on every write here.
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

export async function addLinkedInSeatAction(input: {
  clientId: string;
  name: string;
  role: string;
  profileUrl: string;
  /** 2-4 topics to be known for. */
  focus?: string;
  offLimits: string;
  /** Inactive-on-LinkedIn fallback: "writing" | "about" | "" (active poster). */
  fallbackKind?: string;
  fallbackText?: string;
}): Promise<{ seatId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  const name = input.name.trim();
  if (!name) return { error: "Name is required." };
  if (name.length > MAX_NAME) return { error: `Name is too long (max ${MAX_NAME} characters).` };
  if (!input.role.trim()) return { error: "Role is required. In their own words is fine." };
  if (!input.offLimits.trim()) return { error: "Tell us what we must never post (or write \"nothing\")." };
  const profileUrl = parseLinkedInUrl(input.profileUrl, "person");
  if (profileUrl !== null && typeof profileUrl === "object") return profileUrl;
  const fallback = parseFallback(input.fallbackKind, input.fallbackText);
  if ("error" in fallback) return fallback;
  const slug = kebab(name);
  if (!slug) return { error: "Name must contain letters or numbers." };

  // Seats are shared across agents: reuse the person's existing seat (e.g.
  // from the X agent) and only refuse when LinkedIn intake already exists.
  const existing = (await listClientSeats(input.clientId)).find((s) => s.slug === slug);
  let seatId = existing?.id;
  if (seatId && (await getAgentIntake(input.clientId, "linkedin", seatId))) {
    return { error: `A LinkedIn seat for "${name}" already exists. Edit it instead.` };
  }
  const now = Date.now();
  if (!seatId) {
    seatId = await createClientSeat({
      clientId: input.clientId,
      name,
      slug,
      createdBy: user.uid,
      createdAt: now,
      updatedAt: now,
    });
  }
  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "linkedin",
    seatId,
    handle: profileUrl,
    role: input.role.trim(),
    ...(input.focus?.trim() ? { focus: input.focus.trim().slice(0, MAX_TEXT) } : {}),
    offLimits: input.offLimits.trim(),
    roster: [],
    ...fallback.fields,
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { seatId };
}

/**
 * A form that blanks its focus or switches the voice fallback off must
 * actually DELETE the stored values — the upsert merges, so omitted keys
 * would otherwise survive forever and keep steering the voice.
 */
async function clearDroppedSeatFields(
  clientId: string,
  seatId: string,
  focus: string | undefined,
  fallback: { fields: Partial<{ fallbackKind: "writing" | "about"; fallbackText: string }> },
): Promise<void> {
  const intake = await getAgentIntake(clientId, "linkedin", seatId);
  if (!intake) return;
  const drop: Array<"focus" | "fallbackKind" | "fallbackText"> = [];
  if (!focus?.trim() && intake.focus) drop.push("focus");
  if (!fallback.fields.fallbackKind && (intake.fallbackKind || intake.fallbackText)) {
    drop.push("fallbackKind", "fallbackText");
  }
  await clearAgentIntakeFields(intake.id, drop);
}

export async function saveLinkedInSeatIntakeAction(input: {
  clientId: string;
  seatId: string;
  role: string;
  profileUrl: string;
  focus?: string;
  offLimits: string;
  fallbackKind?: string;
  fallbackText?: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const seat = await getClientSeat(input.seatId);
  if (!seat || seat.clientId !== input.clientId) return { error: "Seat not found." };
  if (!input.role.trim()) return { error: "Role is required. In their own words is fine." };
  if (!input.offLimits.trim()) return { error: "Tell us what we must never post (or write \"nothing\")." };
  const profileUrl = parseLinkedInUrl(input.profileUrl, "person");
  if (profileUrl !== null && typeof profileUrl === "object") return profileUrl;
  const fallback = parseFallback(input.fallbackKind, input.fallbackText);
  if ("error" in fallback) return fallback;
  await clearDroppedSeatFields(input.clientId, input.seatId, input.focus, fallback);
  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "linkedin",
    seatId: input.seatId,
    handle: profileUrl,
    role: input.role.trim(),
    ...(input.focus?.trim() ? { focus: input.focus.trim().slice(0, MAX_TEXT) } : {}),
    offLimits: input.offLimits.trim(),
    roster: [],
    ...fallback.fields,
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

function parseFallback(
  kind: string | undefined,
  text: string | undefined,
): { fields: Partial<{ fallbackKind: "writing" | "about"; fallbackText: string }> } | { error: string } {
  if (!kind) return { fields: {} };
  if (kind !== "writing" && kind !== "about") return { fields: {} };
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return {
      // Client copy: both are returned to `addLinkedInSeatAction` /
      // `updateLinkedInSeatAction` — two ungated actions — and rendered verbatim
      // in the intake form's error banner. Being a module-private helper hides
      // them from a reader following the export list, not from the client.
      error:
        kind === "writing"
          ? "Paste the piece of writing. It is how we learn a real voice for someone who does not post."
          : "Write (or transcribe) the who-you-are notes. It is how we learn a real voice for someone who does not post.",
    };
  }
  if (trimmed.length > 10_000) return { error: "Please keep the voice sample under 10,000 characters." };
  return { fields: { fallbackKind: kind, fallbackText: trimmed } };
}

/* ───────────────── the private CV upload (substance, not voice) ───────────────── */

export async function uploadLinkedInSeatCvAction(
  formData: FormData,
): Promise<{ cvName?: string; error?: string }> {
  const clientId = String(formData.get("clientId") ?? "");
  const seatId = String(formData.get("seatId") ?? "");
  const file = formData.get("file");
  await requireClientAccess(clientId);
  const seat = await getClientSeat(seatId);
  if (!seat || seat.clientId !== clientId) return { error: "Seat not found." };
  const intake = await getAgentIntake(clientId, "linkedin", seatId);
  if (!intake) return { error: "Save the seat details first, then attach the CV." };
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file to upload." };
  if (file.size > MAX_CV_BYTES) return { error: "Please keep the CV under 10 MB." };
  const ext = `.${(file.name.split(".").pop() ?? "").toLowerCase()}`;
  if (!CV_EXTENSIONS.includes(ext as (typeof CV_EXTENSIONS)[number])) {
    return { error: "Upload a pdf, docx, or txt file." };
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const { path, url } = await uploadBytes({
    bytes,
    path: `clients/${clientId}/linkedin-agent/cv/${seat.slug}-${Date.now()}${ext}`,
    contentType: file.type || "application/octet-stream",
  });
  await patchAgentIntake(intake.id, {
    cvPath: path,
    cvUrl: url,
    cvName: file.name.slice(0, MAX_NAME),
    cvUploadedAt: Date.now(),
  });
  revalidatePath(`/clients/${clientId}/linkedin-agent`);
  revalidatePath(`/clients/${clientId}/agents`);
  return { cvName: file.name.slice(0, MAX_NAME) };
}

/* ──────────────────── per-draft feedback (the loop) ───────────────── */

export async function addLiDraftFeedbackAction(input: {
  clientId: string;
  /** "company", "program" (applies to every account), or a seat id. */
  account?: string;
  /** Alternative to `account`: the batch section title ("... Company page" / a seat's name) — resolved server-side. */
  accountTitle?: string;
  jobId?: string;
  assetId?: string;
  draftRef?: string;
  action: "posted" | "posted_with_edits" | "not_posted" | "note" | "edit_request";
  finalText?: string;
  reason?: string;
}): Promise<{ error?: string; assetId?: string }> {
  const user = await requireClientAccess(input.clientId);
  let account = input.account;
  if (!account && input.accountTitle) {
    account = await resolveAccountTitleToSeat(input.clientId, input.accountTitle);
  }
  if (!account) return { error: "Account is required." };
  if (account !== "company" && account !== "program") {
    const seat = await getClientSeat(account);
    if (!seat || seat.clientId !== input.clientId) return { error: "Account not found." };
  }
  if (input.action === "posted_with_edits" && !input.finalText?.trim()) {
    return { error: "Paste the final text you actually posted." };
  }
  if (input.action === "not_posted" && !input.reason?.trim()) {
    return { error: "Tell us why this one did not run. That is what teaches the agent." };
  }
  if (input.action === "note" && !input.reason?.trim()) {
    return { error: "Write the feedback. As much detail as you like." };
  }
  if (input.action === "edit_request" && !input.reason?.trim()) {
    return { error: "Tell us what to change about this draft." };
  }
  if ((input.finalText?.trim().length ?? 0) > MAX_POST_TEXT) {
    return { error: "Please keep the final text under 3,000 characters (LinkedIn's post cap)." };
  }
  if ((input.reason?.length ?? 0) > MAX_TEXT) {
    return { error: "Please keep the answer under 2,000 characters." };
  }
  // A reload-and-reclick or a second tab must not mint a second published
  // post for the same draft — LinkedIn has no CAS-guarded slot claim the way
  // X's pickAgentSlotOptionAction does, so this is the best a log-only model
  // can check: refuse a repeat "posted" for a draftRef this client already
  // marked posted, before writing feedback OR materializing again. Not
  // airtight against a true simultaneous double-submit (read-then-write, no
  // transaction), but it closes the common case.
  if (
    (input.action === "posted" || input.action === "posted_with_edits") &&
    input.draftRef
  ) {
    const priorFeedback = await listLiDraftFeedback(input.clientId, account);
    const alreadyPosted = priorFeedback.some(
      (f) =>
        f.draftRef === input.draftRef &&
        (f.action === "posted" || f.action === "posted_with_edits"),
    );
    if (alreadyPosted) return { error: "Already recorded as posted." };
  }
  const now = Date.now();
  await addLiDraftFeedback({
    clientId: input.clientId,
    account,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.draftRef?.trim() ? { draftRef: input.draftRef.trim() } : {}),
    action: input.action,
    ...(input.finalText?.trim() ? { finalText: input.finalText.trim() } : {}),
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    createdBy: user.uid,
    createdAt: now,
  });

  // MATERIALIZATION — parity with X's pickAgentSlotOptionAction. A pick here
  // IS the client's posting confirmation (there is no later "mark as posted"
  // step for LinkedIn, unlike X), so the real Asset is created already
  // published, in this same step — otherwise the calendar/dashboard would
  // have nothing to show for it and nothing to gate personalSeatId on.
  // Best-effort and never surfaced as an error: the feedback write above is
  // the primary record and already succeeded, so a stale/unparseable batch
  // must not turn into a client-facing failure on top of a post they
  // already made.
  let assetId: string | undefined;
  if (
    (input.action === "posted" || input.action === "posted_with_edits") &&
    input.assetId &&
    input.accountTitle &&
    input.draftRef
  ) {
    try {
      const batchAsset = await getAsset(input.assetId);
      const batch = batchAsset ? parseLiDrafts(batchAsset.content ?? "") : null;
      const acc = batch?.accounts.find((a) => a.title === input.accountTitle);
      const draft = acc?.drafts.find((d) => `${acc.title} · ${d.lane}` === input.draftRef);
      if (draft) {
        const edited = input.action === "posted_with_edits";
        const content = (edited ? (input.finalText as string) : draft.text)
          .trim()
          .slice(0, MAX_POST_TEXT);
        if (content) {
          assetId = await createAsset({
            clientId: input.clientId,
            type: "social_post",
            title: `${laneLabel(draft.lane)} · ${input.accountTitle}`,
            content,
            status: "published",
            publishMode: "manual",
            scheduledAt: now,
            publishedAt: now,
            channels: ["linkedin"],
            personalSeatId: account !== "company" && account !== "program" ? account : null,
            meta: {
              accountTitle: input.accountTitle,
              pickedFromAssetId: input.assetId,
              edited,
            },
            createdBy: user.uid,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    } catch {
      // See comment above — never surfaced.
    }
  }

  // Action 14 ("give us your feedback on a post") — event-tracked, no live
  // signal answers it (lib/action-list.ts). Only the client's own feedback
  // counts, not a staff member logging it on their behalf.
  if (user.role === "CLIENT_USER") {
    const feedbackClientId = input.clientId;
    await upsertClientActionState(feedbackClientId, "14", "done");
  }
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return assetId ? { assetId } : {};
}

/* ─────────── direction requests: "what should we cover next?" ─────────── */

/**
 * A standing steer for one identity — the v2 live section's Section A0, which
 * the writer treats as the brief for its batch.
 *
 * Deliberately NOT the news box. A drop says what happened; this says what to
 * write about, it is per identity, and a run that covers it closes it.
 */
export async function addLiDirectionRequestAction(input: {
  clientId: string;
  /** "company" or a seat id. */
  account: string;
  request: string;
}): Promise<{ id?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const request = input.request.trim();
  if (!request) return { error: "Write what you want covered. A sentence is plenty." };
  if (request.length > MAX_TEXT) {
    return { error: "Please keep it under 2,000 characters." };
  }
  const account = input.account.trim() || "company";
  if (account !== "company") {
    const seat = await getClientSeat(account);
    if (!seat || seat.clientId !== input.clientId) return { error: "That person was not found." };
  }
  const now = Date.now();
  const id = await addLiDirectionRequest({
    clientId: input.clientId,
    account,
    request,
    date: new Date(now).toISOString().slice(0, 10),
    status: "open",
    createdBy: user.uid,
    createdAt: now,
  });
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { id };
}

export async function deleteLiDirectionRequestAction(input: {
  clientId: string;
  id: string;
}): Promise<{ error?: string }> {
  await requireClientAccess(input.clientId);
  if (!(await deleteLiDirectionRequest(input.clientId, input.id))) {
    return { error: "That request was not found." };
  }
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/* ────────────────────────── the setup run ────────────────────────── */

/**
 * The setup brief. Written here rather than composed from the launch profile
 * because the identity has to be unambiguous in the prose as well as in
 * `briefValues`: this is the run that decides a client's lanes and voice, and a
 * run that misreads which identity it is standing up writes the wrong person's
 * voice card into the shared file.
 */
function setupPrompt(args: { clientName: string; seatName?: string }): string {
  if (args.seatName) {
    return [
      `Set up the LinkedIn seat for ${args.seatName} at ${args.clientName}.`,
      "",
      "This is a SEAT setup, not the company page — the company page is already stood",
      "up and you must not rewrite its foundation, its lanes or its topic catalog.",
      "",
      "Build this person's voice card and their empty learning record, then add them",
      "to the client's identities. Read their real LinkedIn posts for voice when their",
      "profile URL is on file; fall back to their voice sample, and use their CV for",
      "substance only, never for voice.",
      "",
      "Deliver the voice card as a client-facing artifact named",
      `voice-profile--<their identity slug>.md — the portal stores it as this seat's`,
      "voice card, and a seat with no voice card cannot be drafted for.",
    ].join("\n");
  }
  return [
    `Set up LinkedIn for ${args.clientName} (the company page).`,
    "",
    "Run the setup skill end to end: derive the settings from their onboarding",
    "documents, distil the company voice card, pick the lanes and name the signature",
    "series, write the foundation, seed the topic catalog, and stand up the empty",
    "records the posting runs write to. Decide and record why — do not wait for a",
    "sign-off and do not ask the client anything.",
    "",
    "Do not draft or deliver any posts in this run. This is the setup.",
  ].join("\n");
}

/**
 * Fire the v2 setup for a client — the company page, or one seat.
 *
 * WHY THIS IS ITS OWN ACTION rather than the client-agent launch flow. That flow
 * (`submitClientAgentLaunchAction`) allows ONE launch per umbrella and refuses a
 * second with "already live", which is right for an agent that is set up once and
 * wrong for one where adding a person is a normal, repeatable act. It also fires
 * the SAME agent doc with a different prompt, and v2's setup is a different skill
 * in a different directory.
 *
 * Staff-and-client reachable, like the run dialog: a client adding their own
 * colleague is the flow Ben asked for. Billing follows the same rule as any
 * custom run — `isBillableClientActor` decides inside the submit core.
 */
export async function runLinkedInSetupAction(input: {
  clientId: string;
  /** "company", or a seat id to stand that person up. */
  identity: string;
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };

  const agent = await getCustomAgentByKey(LINKEDIN_SETUP_V2_KEY);
  if (!agent || !agent.enabled) {
    return { error: "The LinkedIn setup agent is not available. Your Karos team can enable it." };
  }

  const identity = input.identity.trim() || "company";
  let seatName: string | undefined;
  if (identity !== "company") {
    const seat = await getClientSeat(identity);
    if (!seat || seat.clientId !== input.clientId) return { error: "That person was not found." };
    seatName = seat.name;
    // A seat with no LinkedIn intake has no profile URL, no CV and no voice
    // sample, so the run would have nothing to build a voice from and would
    // produce a generic card that then blocks nothing. The form is the fix.
    if (!(await getAgentIntake(input.clientId, "linkedin", identity))) {
      return { error: `Fill in ${seat.name}'s LinkedIn details first. That is what their voice is built from.` };
    }
  }

  const result = await submitCustomAgentJob(user, {
    agentId: agent.id,
    clientId: input.clientId,
    prompt: setupPrompt({ clientName: client.name, seatName }),
    runType: "launch",
    briefValues: {
      [LI_IDENTITY_FIELD_KEY]: identity === "company" ? "company" : `seat:${identity}`,
    },
  });

  if (result.jobId && !result.error) {
    revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
    revalidatePath(`/clients/${input.clientId}/agents`);
    revalidatePath("/jobs");
    return result;
  }
  // Same rule as the run dialog: a billable client actor never reads the submit
  // core's internal strings (service URLs, env var names).
  if (result.error && isBillableClientActor(user)) {
    return { error: clientSafeRunError(result.error) };
  }
  return result;
}
