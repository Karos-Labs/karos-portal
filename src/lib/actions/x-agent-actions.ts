"use server";

/**
 * X agent (e13) intake actions: the company-page form, per-person seat forms,
 * the two ongoing drop boxes (what's new, takes and topics), and per-draft
 * feedback. ASK-only fields per the input contract — voice, pillars, cadence,
 * language and launch-vs-ongoing are built by the agent, never asked here.
 */

import { revalidatePath } from "next/cache";
import {
  addXDraftFeedback,
  addXNewsUpdate,
  addXTake,
  createClientSeat,
  getClient,
  getClientSeat,
  listClientSeats,
  upsertAgentIntake,
} from "@/lib/data";
import { requireClientAccess } from "./_shared";

const MAX_TEXT = 2_000;
const MAX_NAME = 120;
const MAX_ROSTER = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function kebab(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** "@a, b @c" → ["@a", "@b", "@c"]; drops empties, dedupes, caps the list. */
function parseRoster(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const handle = part.trim().replace(/^@+/, "");
    if (!handle) continue;
    const normalized = `@${handle}`;
    if (seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    out.push(normalized);
    if (out.length >= MAX_ROSTER) break;
  }
  return out;
}

/** Normalizes an @handle; empty/none stays null (company "none yet", seat "pending"). */
function parseHandle(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@+/, "");
  if (!trimmed || /^(none|none yet|pending)$/i.test(trimmed)) return null;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(trimmed)) return null;
  return `@${trimmed}`;
}

/* ─────────────────────────── the forms ─────────────────────────── */

export async function saveXCompanyIntakeAction(input: {
  clientId: string;
  handle: string;
  comeAcross: string;
  offLimits: string;
  roster: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  if (!input.comeAcross.trim()) return { error: "Tell us how you want to come across on X." };
  if (!input.offLimits.trim()) return { error: "Tell us what we must never post (or write \"nothing\")." };
  if (input.comeAcross.length > MAX_TEXT || input.offLimits.length > MAX_TEXT) {
    return { error: "Please keep each answer under 2,000 characters." };
  }
  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "x",
    seatId: null,
    handle: parseHandle(input.handle),
    comeAcross: input.comeAcross.trim(),
    offLimits: input.offLimits.trim(),
    roster: parseRoster(input.roster),
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  return {};
}

export async function addXSeatAction(input: {
  clientId: string;
  name: string;
  handle: string;
  offLimits: string;
  roster: string;
}): Promise<{ seatId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  const name = input.name.trim();
  if (!name) return { error: "Name is required." };
  if (name.length > MAX_NAME) return { error: `Name is too long (max ${MAX_NAME} characters).` };
  if (!input.offLimits.trim()) return { error: "Tell us what we must never post (or write \"nothing\")." };
  const slug = kebab(name);
  if (!slug) return { error: "Name must contain letters or numbers." };
  const existing = await listClientSeats(input.clientId);
  if (existing.some((s) => s.slug === slug)) {
    return { error: `A seat for "${name}" already exists — edit it instead.` };
  }
  const now = Date.now();
  const seatId = await createClientSeat({
    clientId: input.clientId,
    name,
    slug,
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
  });
  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "x",
    seatId,
    handle: parseHandle(input.handle),
    offLimits: input.offLimits.trim(),
    roster: parseRoster(input.roster),
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  return { seatId };
}

export async function saveXSeatIntakeAction(input: {
  clientId: string;
  seatId: string;
  handle: string;
  offLimits: string;
  roster: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const seat = await getClientSeat(input.seatId);
  if (!seat || seat.clientId !== input.clientId) return { error: "Seat not found." };
  if (!input.offLimits.trim()) return { error: "Tell us what we must never post (or write \"nothing\")." };
  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "x",
    seatId: input.seatId,
    handle: parseHandle(input.handle),
    offLimits: input.offLimits.trim(),
    roster: parseRoster(input.roster),
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  return {};
}

/* ─────────────────────── the ongoing boxes ─────────────────────── */

export async function addXNewsUpdateAction(input: {
  clientId: string;
  title: string;
  date: string;
  detail?: string;
  url?: string;
  type?: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!input.title.trim()) return { error: "Tell us what happened, in a line or two." };
  if (!DATE_RE.test(input.date)) return { error: "Pick the date this happened." };
  if (input.title.length > MAX_TEXT || (input.detail?.length ?? 0) > MAX_TEXT) {
    return { error: "Please keep each answer under 2,000 characters." };
  }
  await addXNewsUpdate({
    clientId: input.clientId,
    title: input.title.trim(),
    date: input.date,
    ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
    ...(input.url?.trim() ? { url: input.url.trim() } : {}),
    ...(input.type?.trim() ? { type: input.type.trim() } : {}),
    createdBy: user.uid,
    createdAt: Date.now(),
  });
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  return {};
}

export async function addXTakeAction(input: {
  clientId: string;
  seatId: string;
  take: string;
  date: string;
  topic?: string;
  url?: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const seat = await getClientSeat(input.seatId);
  if (!seat || seat.clientId !== input.clientId) return { error: "Seat not found." };
  if (!input.take.trim()) return { error: "Write the take — one honest sentence is enough." };
  if (!DATE_RE.test(input.date)) return { error: "Pick a date for this take." };
  if (input.take.length > MAX_TEXT) return { error: "Please keep the take under 2,000 characters." };
  await addXTake({
    clientId: input.clientId,
    seatId: input.seatId,
    take: input.take.trim(),
    date: input.date,
    ...(input.topic?.trim() ? { topic: input.topic.trim() } : {}),
    ...(input.url?.trim() ? { url: input.url.trim() } : {}),
    createdBy: user.uid,
    createdAt: Date.now(),
  });
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  return {};
}

/* ──────────────────── per-draft feedback (the loop) ───────────────── */

export async function addXDraftFeedbackAction(input: {
  clientId: string;
  /** "company" or a seat id. */
  account: string;
  jobId?: string;
  assetId?: string;
  draftRef?: string;
  action: "posted" | "posted_with_edits" | "not_posted";
  finalText?: string;
  reason?: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (input.account !== "company") {
    const seat = await getClientSeat(input.account);
    if (!seat || seat.clientId !== input.clientId) return { error: "Account not found." };
  }
  if (input.action === "posted_with_edits" && !input.finalText?.trim()) {
    return { error: "Paste the final text you actually posted." };
  }
  if (input.action === "not_posted" && !input.reason?.trim()) {
    return { error: "Tell us why this one did not run — that is what teaches the agent." };
  }
  if ((input.finalText?.length ?? 0) > MAX_TEXT || (input.reason?.length ?? 0) > MAX_TEXT) {
    return { error: "Please keep each answer under 2,000 characters." };
  }
  await addXDraftFeedback({
    clientId: input.clientId,
    account: input.account,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.draftRef?.trim() ? { draftRef: input.draftRef.trim() } : {}),
    action: input.action,
    ...(input.finalText?.trim() ? { finalText: input.finalText.trim() } : {}),
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    createdBy: user.uid,
    createdAt: Date.now(),
  });
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  return {};
}
