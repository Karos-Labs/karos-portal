"use server";

/**
 * X agent (e13) intake actions: the company-page form, per-person seat forms,
 * the two ongoing drop boxes (what's new, takes and topics), and per-draft
 * feedback. ASK-only fields per the input contract — voice, pillars, cadence,
 * language and launch-vs-ongoing are built by the agent, never asked here.
 *
 * Seats are platform-agnostic (ClientSeat): adding an X seat for a person who
 * already has a LinkedIn seat attaches X intake to the SAME seat.
 *
 * Every surface renders both on the dedicated /x-agent page and inline in the
 * run dialog on /agents, so both paths revalidate on every write.
 */

import { revalidatePath } from "next/cache";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "@/lib/constants";
import {
  addXDraftFeedback,
  addXNewsUpdate,
  addXTake,
  clearAgentIntakeFields,
  createClientSeat,
  getAgentIntake,
  getClient,
  getClientContextDoc,
  getClientSeat,
  listClientSeats,
  upsertAgentIntake,
} from "@/lib/data";
import { requireClientAccess } from "./_shared";
import { CREDIT_COSTS } from "@/lib/credits";
import { withClientModelCharge } from "@/lib/client-model-charge";

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

/**
 * Normalizes an @handle. Empty/none stays null — a legitimate state (company
 * "none yet", seat "pending": we draft, nothing can post). A handle that was
 * actually typed but cannot exist on X is an error, never a silent null: the
 * form would show it back while every run's context said "none yet".
 *
 * A pasted profile link resolves to the handle inside it — that is the shape
 * people have on their clipboard, and refusing it would be a dead end in a form
 * whose only other option is leaving the field empty. Everything the X rules
 * cannot allow (spaces, dots, hyphens, over 15 characters) still errors.
 */
function parseHandle(raw: string): string | null | { error: string } {
  const typed = raw.trim();
  // Only a real profile link gives up its path — a slash anywhere else is not a
  // handle and has to keep failing the check below rather than being truncated.
  const link = typed.match(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i);
  const trimmed = (link ? link[1] : typed).replace(/^@+/, "");
  if (!trimmed || /^(none|none yet|pending)$/i.test(trimmed)) return null;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(trimmed)) {
    return {
      error:
        "That is not a valid X handle — letters, numbers and underscores only, up to 15 characters. Leave it empty if you do not have one yet.",
    };
  }
  return `@${trimmed}`;
}

/** "auto" omits the field (agent auto-detects); "yes"/"no" pin it. */
function parsePremium(raw: string | undefined): { premium?: boolean } {
  if (raw === "yes") return { premium: true };
  if (raw === "no") return { premium: false };
  return {};
}

/**
 * Going back to "auto-detect" must actually DELETE a stored premium answer —
 * the upsert merges, so an omitted key would keep pinning long-form posts on
 * every future run.
 */
async function clearDroppedPremium(
  clientId: string,
  seatId: string | null,
  premium: { premium?: boolean },
): Promise<void> {
  if (premium.premium !== undefined) return;
  const intake = await getAgentIntake(clientId, "x", seatId);
  if (!intake || intake.premium === undefined) return;
  await clearAgentIntakeFields(intake.id, ["premium"]);
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
  const handle = parseHandle(input.handle);
  if (handle !== null && typeof handle === "object") return handle;
  const premium = parsePremium(input.premium);
  await clearDroppedPremium(input.clientId, null, premium);
  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "x",
    seatId: null,
    handle,
    comeAcross: input.comeAcross.trim(),
    offLimits: input.offLimits.trim(),
    roster: parseRoster(input.roster),
    ...premium,
    createdBy: user.uid,
  });
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  for (const title of parseLines(input.announcements, 10)) {
    if (title.length > MAX_TEXT) continue;
    await addXNewsUpdate({ clientId: input.clientId, title, date, createdBy: user.uid, createdAt: now });
  }
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
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
  const handle = parseHandle(input.handle);
  if (handle !== null && typeof handle === "object") return handle;
  const slug = kebab(name);
  if (!slug) return { error: "Name must contain letters or numbers." };

  // Seats are shared across agents: reuse the person's existing seat (e.g.
  // from the LinkedIn agent) and only refuse when X intake already exists.
  const existing = (await listClientSeats(input.clientId)).find((s) => s.slug === slug);
  let seatId = existing?.id;
  if (seatId && (await getAgentIntake(input.clientId, "x", seatId))) {
    return { error: `An X seat for "${name}" already exists — edit it instead.` };
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
    agent: "x",
    seatId,
    handle,
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
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { seatId };
}

/* ───────────────── roster proposal (propose, they approve) ───────────────── */

/**
 * Proposes 10-15 real X accounts for the engagement roster from what we
 * already know about the client (onboarding docs + profile), grounded with
 * live web search. The client approves or edits — nothing is engaged off an
 * unapproved list, and the engine re-verifies every handle live at run time.
 *
 * PRICED AT `CREDIT_COSTS.chatMessage` (1), which is not a new price but the
 * existing rate for the nearest operation: that constant's own definition is
 * "one copilot chat message (Sonnet, up to 6 tool steps)", and this is one
 * Sonnet call with up to 4 web-search tool uses. Same model, same order of tool
 * budget, one press of a button — so it charges what a copilot turn charges.
 *
 * Booked under `ai_tool`, not `chat_message`, because the client's own spend
 * breakdown groups by operation: an account suggestion filed under "Copilot"
 * would tell them they spent credits on a feature they did not use. The price
 * comes from the nearest operation; the LABEL has to name the real one.
 */
export async function proposeXRosterAction(input: {
  clientId: string;
  /** When proposing for a person's seat rather than the company page. */
  seatName?: string;
}): Promise<{ handles?: Array<{ handle: string; why: string }>; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };

  // Client tier: this suggestion runs for client users too, so it must read the
  // published copy — the one a correction updates and the one that carries no
  // internal analyst notes.
  const [audience, strategy] = await Promise.all([
    getClientContextDoc(input.clientId, "target-audience", "client"),
    getClientContextDoc(input.clientId, "market-strategy", "client"),
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
    return { error: "Not enough client context yet — finish onboarding first, or type accounts manually." };
  }

  const forWhom = input.seatName
    ? `a personal X account belonging to ${input.seatName}, a person at ${client.name}. Favor respected operators, founders, and voices this person would credibly reply to — people a notch or two bigger than them in the same space.`
    : `the company X page of ${client.name}. Favor the loudest credible voices their buyers already follow in this niche.`;

  const outcome = await withClientModelCharge(
    {
      user,
      clientId: input.clientId,
      amount: CREDIT_COSTS.chatMessage,
      operation: "ai_tool",
      // Client copy: the ledger feed renders ungated to a CLIENT_USER.
      reason: input.seatName
        ? `Account suggestions · X agent · ${input.seatName.slice(0, 40)}`
        : "Account suggestions · X agent",
    },
    async ({ refund }) => {
      // Every failure below hands the credit back. The client pressed a button
      // that promised a list of accounts; if they did not get one, they did not
      // get the thing they paid for — whether the model threw, returned
      // unparseable text, or returned too few usable handles.
      try {
        const { text } = await generateText({
          model: anthropic(MODELS.SONNET),
          tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 4 }) },
          system:
            "You propose X (Twitter) engagement rosters. Only ever name accounts you are confident exist and are active — well-known people and companies. Use web search to confirm anyone you are less than certain about. Output STRICT JSON only: an array of {\"handle\": \"@...\", \"why\": \"one short line\"} with 10 to 15 entries, no other text.",
          prompt: `Propose the engagement roster for ${forWhom}\n\nWhat we know:\n${context}\n\nRules: real, active, relevant accounts on X; no direct competitors of ${client.name}; no politics-first accounts; mix a few very large voices with mid-size ones in the exact niche.`,
        });
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) {
          await refund("Refund · account suggestions came back empty");
          return { error: "Could not build a proposal — try again or type accounts manually." };
        }
        const parsed = JSON.parse(match[0]) as Array<{ handle?: string; why?: string }>;
        const handles = parsed
          .map((p) => ({
            handle: `@${String(p.handle ?? "").replace(/^@+/, "").trim()}`,
            why: String(p.why ?? "").slice(0, 200),
          }))
          .filter((p) => /^@[A-Za-z0-9_]{1,15}$/.test(p.handle))
          .slice(0, 15);
        if (handles.length < 5) {
          await refund("Refund · account suggestions came back empty");
          return { error: "Proposal came back too thin — try again or type accounts manually." };
        }
        return { handles };
      } catch {
        // This catch is why the refund is spelled here rather than left to the
        // wrapper: it swallows the throw to keep the client-safe sentence, so
        // the wrapper never sees a failure to pair a refund to.
        await refund("Refund · account suggestions failed");
        return { error: "Could not build a proposal right now — try again or type accounts manually." };
      }
    },
  );
  return outcome.ok ? outcome.result : { error: outcome.denied };
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
  const handle = parseHandle(input.handle);
  if (handle !== null && typeof handle === "object") return handle;
  const premium = parsePremium(input.premium);
  await clearDroppedPremium(input.clientId, input.seatId, premium);
  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "x",
    seatId: input.seatId,
    handle,
    offLimits: input.offLimits.trim(),
    roster: parseRoster(input.roster),
    ...premium,
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
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
  /** Where any number in the update comes from (no source = posted without the number). */
  sourceUrl?: string;
  /** Who is featured + consent confirmed (customer stories/spotlights hold until set). */
  consent?: string;
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
    ...(input.sourceUrl?.trim() ? { sourceUrl: input.sourceUrl.trim() } : {}),
    ...(input.consent?.trim() ? { consent: input.consent.trim().slice(0, MAX_TEXT) } : {}),
    createdBy: user.uid,
    createdAt: Date.now(),
  });
  // The news drop is shared with the LinkedIn agent (SCRUM-51): one input
  // feeds both agents, so both data pages must refresh.
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
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
  revalidatePath(`/clients/${input.clientId}/agents`);
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
      // Longest name first so "Daniel Herbert" wins over a seat named "Dan"
      // when both are substrings of the section title.
      const seats = (await listClientSeats(input.clientId)).sort(
        (a, b) => b.name.length - a.name.length,
      );
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
    return { error: "Tell us why this one did not run — that is what teaches the agent." };
  }
  if (input.action === "note" && !input.reason?.trim()) {
    return { error: "Write the feedback — as much detail as you like." };
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
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}
