"use server";

/**
 * X agent (e13) intake actions: the company-page form, per-person seat forms,
 * the two ongoing drop boxes (what's new, takes and topics), and per-draft
 * feedback. ASK-only fields per the input contract — voice, pillars, cadence,
 * language and launch-vs-ongoing are built by the agent, never asked here.
 */

import { revalidatePath } from "next/cache";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "@/lib/constants";
import {
  addXDraftFeedback,
  addXNewsUpdate,
  addXTake,
  createClientSeat,
  getClient,
  getClientContextDoc,
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


/** "auto" omits the field (agent auto-detects); "yes"/"no" pin it. */
function parsePremium(raw: string | undefined): { premium?: boolean } {
  if (raw === "yes") return { premium: true };
  if (raw === "no") return { premium: false };
  return {};
}

/* ─────────────────────────── the forms ─────────────────────────── */

/** Multiline box → clean rows, one per non-empty line, capped. */
function parseLines(raw: string | undefined, cap: number): string[] {
  return (raw ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, cap);
}

export async function saveXCompanyIntakeAction(input: {
  clientId: string;
  handle: string;
  comeAcross: string;
  offLimits: string;
  roster: string;
  /** "auto" | "yes" | "no" — X Premium (long-form) for this account. */
  premium?: string;
  /** First-time setup only: "anything worth announcing right now", one per line. */
  announcements?: string;
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
    ...parsePremium(input.premium),
    createdBy: user.uid,
  });
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  for (const title of parseLines(input.announcements, 10)) {
    if (title.length > MAX_TEXT) continue;
    await addXNewsUpdate({ clientId: input.clientId, title, date, createdBy: user.uid, createdAt: now });
  }
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  return {};
}

export async function addXSeatAction(input: {
  clientId: string;
  name: string;
  handle: string;
  offLimits: string;
  roster: string;
  /** "auto" | "yes" | "no" — X Premium (long-form) for this account. */
  premium?: string;
  /** Setup: "your first 3-5 takes", one rough one-liner per line. */
  firstTakes?: string;
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
    return { error: `A seat for "${name}" already exists - edit it instead.` };
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
    ...parsePremium(input.premium),
    createdBy: user.uid,
  });
  const date = new Date(now).toISOString().slice(0, 10);
  for (const take of parseLines(input.firstTakes, 10)) {
    if (take.length > MAX_TEXT) continue;
    await addXTake({ clientId: input.clientId, seatId, take, date, createdBy: user.uid, createdAt: now });
  }
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  return { seatId };
}

/* ───────────────── roster proposal (propose, they approve) ───────────────── */

/**
 * Proposes 10-15 real X accounts for the engagement roster from what we
 * already know about the client (onboarding docs + profile), grounded with
 * live web search. The client approves or edits — nothing is engaged off an
 * unapproved list, and the engine re-verifies every handle live at run time.
 */
export async function proposeXRosterAction(input: {
  clientId: string;
  /** When proposing for a person's seat rather than the company page. */
  seatName?: string;
}): Promise<{ handles?: Array<{ handle: string; why: string }>; error?: string }> {
  await requireClientAccess(input.clientId);
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };

  const [audience, strategy] = await Promise.all([
    getClientContextDoc(input.clientId, "target-audience"),
    getClientContextDoc(input.clientId, "market-strategy"),
  ]);
  const context = [
    `Company: ${client.name}${client.industry ? ` (${client.industry})` : ""}${client.website ? ` — ${client.website}` : ""}`,
    client.brief ? `About: ${client.brief}` : "",
    audience?.content ? `TARGET AUDIENCE (excerpt):\n${audience.content.slice(0, 4_000)}` : "",
    strategy?.content ? `MARKET STRATEGY (excerpt):\n${strategy.content.slice(0, 4_000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!audience?.content && !strategy?.content && !client.brief) {
    return { error: "Not enough client context yet - finish onboarding first, or type accounts manually." };
  }

  const forWhom = input.seatName
    ? `a personal X account belonging to ${input.seatName}, a person at ${client.name}. Favor respected operators, founders, and voices this person would credibly reply to — people a notch or two bigger than them in the same space.`
    : `the company X page of ${client.name}. Favor the loudest credible voices their buyers already follow in this niche.`;

  try {
    const { text } = await generateText({
      model: anthropic(MODELS.SONNET),
      tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 4 }) },
      system:
        "You propose X (Twitter) engagement rosters. Only ever name accounts you are confident exist and are active — well-known people and companies. Use web search to confirm anyone you are less than certain about. Output STRICT JSON only: an array of {\"handle\": \"@...\", \"why\": \"one short line\"} with 10 to 15 entries, no other text.",
      prompt: `Propose the engagement roster for ${forWhom}\n\nWhat we know:\n${context}\n\nRules: real, active, relevant accounts on X; no direct competitors of ${client.name}; no politics-first accounts; mix a few very large voices with mid-size ones in the exact niche.`,
    });
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return { error: "Could not build a proposal - try again or type accounts manually." };
    const parsed = JSON.parse(match[0]) as Array<{ handle?: string; why?: string }>;
    const handles = parsed
      .map((p) => ({
        handle: `@${String(p.handle ?? "").replace(/^@+/, "").trim()}`,
        why: String(p.why ?? "").slice(0, 200),
      }))
      .filter((p) => /^@[A-Za-z0-9_]{1,15}$/.test(p.handle))
      .slice(0, 15);
    if (handles.length < 5) return { error: "Proposal came back too thin - try again or type accounts manually." };
    return { handles };
  } catch {
    return { error: "Could not build a proposal right now - try again or type accounts manually." };
  }
}

export async function saveXSeatIntakeAction(input: {
  clientId: string;
  seatId: string;
  handle: string;
  offLimits: string;
  roster: string;
  /** "auto" | "yes" | "no" — X Premium (long-form) for this account. */
  premium?: string;
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
    ...parsePremium(input.premium),
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
  if (!input.take.trim()) return { error: "Write the take - one honest sentence is enough." };
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
  /** "company", "program" (applies to every account), or a seat id. */
  account?: string;
  /** Alternative to `account`: the batch section title ("Company page @…" / a seat's name) — resolved server-side. */
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
  await addXDraftFeedback({
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
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  return {};
}
