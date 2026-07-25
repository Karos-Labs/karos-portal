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
  addLiDraftFeedback,
  createClientSeat,
  getAgentIntake,
  getClient,
  getClientSeat,
  listClientSeats,
  patchAgentIntake,
  upsertAgentIntake,
} from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import { requireClientAccess } from "./_shared";

const MAX_TEXT = 2_000;
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
 * "none yet", seat "pending"). Accepts linkedin.com/in|company|school paths
 * with or without protocol; anything else is rejected so drafts never route
 * to a mistyped identity.
 */
function parseLinkedInUrl(raw: string): string | null | { error: string } {
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
  const path = url.pathname.replace(/\/+$/, "");
  if (!/^\/(in|company|school|showcase)\/[^/]+/.test(path)) {
    return { error: "Use the full URL, like linkedin.com/in/your-name or linkedin.com/company/your-company." };
  }
  return `https://www.linkedin.com${path}`;
}

/* ─────────────────────────── the forms ─────────────────────────── */

export async function saveLinkedInCompanyIntakeAction(input: {
  clientId: string;
  /** The company page URL (linkedin.com/company/...). Empty = none yet. */
  pageUrl: string;
  comeAcross: string;
  offLimits: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  if (!input.comeAcross.trim()) {
    return { error: "Tell us how the company should come across on LinkedIn." };
  }
  if (!input.offLimits.trim()) {
    return { error: "Tell us what we must never post (or write \"nothing\")." };
  }
  if (input.comeAcross.length > MAX_TEXT || input.offLimits.length > MAX_TEXT) {
    return { error: "Please keep each answer under 2,000 characters." };
  }
  const pageUrl = parseLinkedInUrl(input.pageUrl);
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
  if (!input.role.trim()) return { error: "Role is required - in their own words is fine." };
  if (!input.offLimits.trim()) return { error: "Tell us what we must never post (or write \"nothing\")." };
  const profileUrl = parseLinkedInUrl(input.profileUrl);
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
    return { error: `A LinkedIn seat for "${name}" already exists - edit it instead.` };
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
  return { seatId };
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
  if (!input.role.trim()) return { error: "Role is required - in their own words is fine." };
  if (!input.offLimits.trim()) return { error: "Tell us what we must never post (or write \"nothing\")." };
  const profileUrl = parseLinkedInUrl(input.profileUrl);
  if (profileUrl !== null && typeof profileUrl === "object") return profileUrl;
  const fallback = parseFallback(input.fallbackKind, input.fallbackText);
  if ("error" in fallback) return fallback;
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
      error:
        kind === "writing"
          ? "Paste the piece of writing - it is how we learn a real voice for someone who does not post."
          : "Write (or transcribe) the who-you-are notes - it is how we learn a real voice for someone who does not post.",
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
  action: "posted" | "posted_with_edits" | "not_posted" | "note";
  finalText?: string;
  reason?: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  let account = input.account;
  if (!account && input.accountTitle) {
    const title = input.accountTitle.toLowerCase();
    if (title.includes("company page")) account = "company";
    else {
      const seats = await listClientSeats(input.clientId);
      account = seats.find((s) => title.includes(s.name.toLowerCase()))?.id ?? "company";
    }
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
    return { error: "Tell us why this one did not run - that is what teaches the agent." };
  }
  if (input.action === "note" && !input.reason?.trim()) {
    return { error: "Write the feedback - as much detail as you like." };
  }
  if ((input.finalText?.length ?? 0) > MAX_TEXT || (input.reason?.length ?? 0) > MAX_TEXT) {
    return { error: "Please keep each answer under 2,000 characters." };
  }
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
    createdAt: Date.now(),
  });
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  return {};
}
