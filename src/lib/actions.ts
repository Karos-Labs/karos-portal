"use server";

import { randomBytes } from "crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser, startImpersonation, stopImpersonation } from "@/lib/auth";
import { adminAuth } from "@/lib/firebase/admin";
import {
  createClient,
  updateClient,
  getClient,
  listClients,
  createAgent,
  updateAgent,
  deleteAgent,
  getAgent,
  listAgents,
  getSystemAgent,
  updateAsset,
  getAsset,
  updateTranscript,
  getTranscript,
  upsertUser,
  getUser,
  deleteUser,
  listAccessTokens,
  updateAccessToken,
  getContextItem,
  updateContextItem,
  deleteContextItem,
  upsertClientReport,
  createClientCompetitor,
  deleteClientCompetitor,
  replaceReportCompetitors,
  listClientCompetitors,
  listClientContextDocs,
  replaceClientContextDocs,
  upsertSystemAgent,
  upsertClientContextDoc,
  getClientContextDoc,
  getClientByKeyId,
  getTranscriptByExternalId,
  createActivityLog,
  upsertClientIntegration,
  deleteClientIntegration,
  clearAssetSchedule,
  createClientRequest,
  updateClientRequest,
} from "@/lib/data";
import { parseMarkdownReport, buildClientReport } from "@/lib/report-parser";
import type {
  ActivityLog,
  Agent,
  AppUser,
  BrandingGuidelines,
  Client,
  ClientCompetitor,
  ClientRequest,
  Role,
  Transcript,
} from "@/lib/types";
import {
  applyBrandingForClient,
  brandingToContextDocContent,
  buildBrandVoiceSection,
  injectBrandVoiceSection,
  type BrandingGenResult,
} from "@/lib/branding";
import { issueAccessToken } from "@/lib/tokens";
import { deleteObject, uploadBytes } from "@/lib/storage";
import { startAgentRun, testRunAgent, type TestRunResult } from "@/lib/agents/run";
import {
  type DraftFields,
  createDraftAgent,
  saveAgentDraft,
  publishAgent,
  unpublishAgent,
  buildTestAgent,
} from "@/lib/agents/authoring";
import { ingestTranscript, appendMeetingSignalToContextDoc, buildActionItemsByOwner } from "@/lib/transcripts/ingest";
import { listFirefliesTranscripts, fetchFirefliesTranscript } from "@/lib/transcripts/fireflies";
import { logger } from "@/services/logger";

async function requireStaff(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") throw new Error("Forbidden");
  return user;
}

async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.role !== "KAROS_ADMIN") throw new Error("Forbidden");
  return user;
}

/* ------------------------------ clients ------------------------------ */

export async function createClientAction(input: {
  name: string;
  website?: string;
  industry?: string;
  contactEmail?: string;
  domains?: string;
  description?: string;
  brandVoice?: string;
  assignedEmployeeIds?: string[];
}) {
  const user = await requireStaff();
  // Generate a cryptographically secure, unguessable join token for the new client.
  const clientKeyId = `ck_${randomBytes(16).toString("base64url")}`;
  const id = await createClient({
    name: input.name.trim(),
    website: input.website?.trim() || "",
    industry: input.industry?.trim() || "",
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
    createdAt: Date.now(),
    createdBy: user.uid,
  });

  // Kick off the full onboarding pipeline after the HTTP response is sent so the
  // creation form returns instantly. Both branding (Haiku, ~5 s) and the Intel
  // Report (Sonnet 5-agent pipeline, ~60 s) run concurrently in the background.
  after(async () => {
    const [{ applyBrandingForClient }, { runIntelReportPipeline }] = await Promise.all([
      import("@/lib/branding"),
      import("@/lib/intel-report"),
    ]);
    await Promise.all([
      applyBrandingForClient(id).catch((err: unknown) => {
        console.error("[onboard] Branding generation failed (non-fatal):", err);
      }),
      runIntelReportPipeline(id).catch((err: unknown) => {
        console.error("[onboard] Intel Report generation failed (non-fatal):", err);
      }),
    ]);
  });

  revalidatePath("/clients");
  return { id };
}

/** Regenerate the clientKeyId for a client. Invalidates any previous join links. */
export async function regenerateClientKeyAction(clientId: string): Promise<{ clientKeyId: string }> {
  await requireStaff();
  const clientKeyId = `ck_${randomBytes(16).toString("base64url")}`;
  await updateClient(clientId, { clientKeyId });
  revalidatePath(`/clients/${clientId}`);
  return { clientKeyId };
}

export async function updateClientAction(id: string, input: Partial<Client> & { domainsCsv?: string }) {
  await requireStaff();
  const patch: Partial<Client> = { ...input };
  if (input.domainsCsv !== undefined) {
    patch.domains = input.domainsCsv.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    delete (patch as { domainsCsv?: string }).domainsCsv;
  }
  if (patch.contactEmail) patch.contactEmail = patch.contactEmail.toLowerCase();
  await updateClient(id, patch);
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
}

/* ------------------------------- agents ------------------------------ */

/** Create an in-development draft. Used for lazy creation on the builder's first edit. */
export async function createDraftAgentAction(initial: Partial<DraftFields>) {
  const user = await requireStaff();
  const id = await createDraftAgent(user.uid, initial);
  revalidatePath("/agents");
  return { id };
}

/** Autosave a draft's working state. Intentionally does not revalidate (avoids typing churn). */
export async function saveAgentDraftAction(id: string, patch: Partial<DraftFields>) {
  await requireStaff();
  await saveAgentDraft(id, patch);
}

/** Publish a draft into a live, runnable agent (validates required fields). */
export async function publishAgentAction(id: string, fields: DraftFields) {
  await requireStaff();
  await publishAgent(id, fields);
  revalidatePath(`/agents/${id}`);
  revalidatePath("/agents");
  return { id };
}

/** Send a live agent back to in-development. */
export async function unpublishAgentAction(id: string) {
  await requireStaff();
  await unpublishAgent(id);
  revalidatePath(`/agents/${id}`);
  revalidatePath("/agents");
}

/** Sandboxed test run from the builder's live config — no email, no assets, no job. */
export async function testRunAgentAction(input: {
  config: DraftFields;
  clientId: string;
  values: Record<string, string>;
  withImages: boolean;
}): Promise<TestRunResult> {
  const user = await requireStaff();
  const client = await getClient(input.clientId);
  if (!client) throw new Error("Pick a client to test against.");
  const agent = buildTestAgent(user.uid, input.config);
  return testRunAgent({ agent, client, input: input.values, withImages: input.withImages });
}

export async function deleteAgentAction(id: string) {
  await requireStaff();
  await deleteAgent(id);
  revalidatePath("/agents");
}

export async function toggleAgentAction(id: string) {
  await requireStaff();
  const agent = await getAgent(id);
  if (!agent) throw new Error("Agent not found");
  await updateAgent(id, { isActive: !agent.isActive, updatedAt: Date.now() });
  revalidatePath("/agents");
}

/* -------------------------------- runs ------------------------------- */

export async function runAgentAction(input: {
  agentId: string;
  clientId: string;
  input: Record<string, string>;
}) {
  const user = await requireStaff();
  // Returns as soon as the job row exists; generation continues in the
  // background so the user can keep navigating the app.
  const result = await startAgentRun({
    agentId: input.agentId,
    clientId: input.clientId,
    input: input.input,
    actor: user,
  });
  revalidatePath("/jobs");
  revalidatePath(`/clients/${input.clientId}`);
  revalidatePath("/assets");
  return result;
}

/* ------------------------------- assets ------------------------------ */

export async function updateAssetAction(id: string, patch: { content?: string; title?: string; status?: "draft" | "approved" | "delivered" | "published" }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  // CLIENT_USER may only act on their own assets.
  if (user.role === "CLIENT_USER" && asset.clientId !== user.clientId) throw new Error("Forbidden");
  await updateAsset(id, { ...patch, updatedAt: Date.now() });
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
}

/* ----------------------------- transcripts --------------------------- */

/** Assign a transcript to a client, Karos Labs internal, or unassociated.
 *  Pass clientId as a client Firestore id, "__karos__" for Karos Labs internal, or null to unassign. */
export async function assignTranscriptAction(id: string, clientId: string | null) {
  await requireStaff();
  const isKarosInternal = clientId === "__karos__";
  const patch: Partial<Transcript> = isKarosInternal
    ? { clientId: null, isKarosInternal: true, assignment: "manual" }
    : { clientId, isKarosInternal: false, assignment: clientId ? "manual" : "unassigned" };
  await updateTranscript(id, patch);
  const prev = await getTranscript(id);
  revalidatePath("/transcripts");
  if (prev?.clientId) revalidatePath(`/clients/${prev.clientId}`);
}

/** Toggle the "hidden from client" visibility flag. Admin-only. */
export async function setTranscriptHiddenFromClientAction(id: string, hidden: boolean): Promise<void> {
  await requireAdmin();
  await updateTranscript(id, { hiddenFromClient: hidden });
  revalidatePath("/transcripts");
  revalidatePath(`/transcripts/${id}`);
}

export async function ingestManualTranscriptAction(input: {
  title: string;
  participants: string;
  rawText: string;
}) {
  await requireStaff();
  const result = await ingestTranscript(
    {
      externalId: `manual-${Date.now()}`,
      title: input.title.trim() || "Pasted meeting",
      participants: input.participants.split(",").map((p) => p.trim()).filter(Boolean),
      text: input.rawText,
      date: Date.now(),
    },
    "manual",
  );
  revalidatePath("/transcripts");
  return result;
}

/**
 * Bulk-sync recent Fireflies transcripts. The @karoslabs.com invariant is applied inside
 * listFirefliesTranscripts — only agency-attended meetings are ever processed.
 * Deduplicates by externalId; transcripts already in Firestore are skipped.
 */
export async function syncFirefliesAction(): Promise<{ synced: number; skipped: number }> {
  await requireStaff();
  const headers = await listFirefliesTranscripts();
  let synced = 0;
  let skipped = 0;

  for (const h of headers) {
    const existing = await getTranscriptByExternalId(h.externalId);
    if (existing) {
      skipped++;
      continue;
    }
    // Fetch full transcript (including sentences) only for new records
    const t = await fetchFirefliesTranscript(h.externalId);
    if (!t) { skipped++; continue; }
    const result = await ingestTranscript(t, "fireflies");
    if (result.clientId) {
      const stored = await getTranscript(result.id);
      if (stored) {
        try {
          await appendMeetingSignalToContextDoc(result.clientId, { ...stored, id: result.id });
          await updateTranscript(result.id, { contextDocSignalAt: Date.now() });
        } catch { /* Non-fatal */ }
      }
    }
    synced++;
  }

  revalidatePath("/transcripts");
  return { synced, skipped };
}

/**
 * Manually push a transcript as a meeting signal into the client's intel context docs.
 * Staff-only; shows as "Send to Intel" in the transcript detail UI.
 */
export async function updateTranscriptContextSignalAction(
  transcriptId: string,
  clientId: string,
): Promise<void> {
  await requireStaff();
  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  await appendMeetingSignalToContextDoc(clientId, { ...t, id: transcriptId });
  await updateTranscript(transcriptId, { clientId, assignment: "manual", contextDocSignalAt: Date.now() });
  revalidatePath("/transcripts");
  revalidatePath(`/transcripts/${transcriptId}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function archiveTranscriptAction(id: string): Promise<void> {
  await requireStaff();
  await updateTranscript(id, { archived: true });
  revalidatePath("/transcripts");
  revalidatePath(`/transcripts/${id}`);
}

export async function unarchiveTranscriptAction(id: string): Promise<void> {
  await requireStaff();
  await updateTranscript(id, { archived: false });
  revalidatePath("/transcripts");
  revalidatePath(`/transcripts/${id}`);
}

/**
 * Persist a completion toggle for a single action item.
 * When all items are complete, automatically archives the meeting.
 */
export async function toggleActionItemCompletionAction(
  transcriptId: string,
  itemIndex: number,
  completed: boolean,
): Promise<{ allDone: boolean }> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");

  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  // CLIENT_USER may toggle items on their own client's transcripts; staff can toggle any
  if (user.role === "CLIENT_USER") {
    if (!user.clientId || t.clientId !== user.clientId) throw new Error("Forbidden");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    throw new Error("Forbidden");
  }

  const completedSet = new Set(t.completedItems ?? []);
  if (completed) completedSet.add(itemIndex);
  else completedSet.delete(itemIndex);
  const completedItems = Array.from(completedSet);

  const total = t.actionItems?.length ?? 0;
  // Guard against out-of-range indices when computing allDone
  const validDone = completedItems.filter((i) => i >= 0 && i < total).length;
  const allDone = total > 0 && validDone >= total;
  const patch: Partial<Transcript> = { completedItems };
  if (allDone) patch.archived = true;

  await updateTranscript(transcriptId, patch);
  revalidatePath(`/transcripts/${transcriptId}`);
  if (allDone) revalidatePath("/transcripts");
  return { allDone };
}

/**
 * Reassign a single action item to a new owner name.
 * Rebuilds actionItemsByOwner snapshot from the updated owners array.
 */
export async function setActionItemOwnerAction(
  transcriptId: string,
  itemIndex: number,
  ownerName: string | null,
): Promise<void> {
  await requireStaff();
  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  const total = t.actionItems?.length ?? 0;
  const owners: (string | null)[] = t.actionItemOwners?.length === total
    ? [...t.actionItemOwners]
    : Array.from({ length: total }, (_, i) => {
        if (!t.actionItemsByOwner) return null;
        for (const [name, tasks] of Object.entries(t.actionItemsByOwner)) {
          if (tasks.includes(t.actionItems?.[i] ?? "")) return name === "Unassigned" ? null : name;
        }
        return null;
      });

  if (itemIndex >= 0 && itemIndex < owners.length) owners[itemIndex] = ownerName;
  const actionItemsByOwner = buildActionItemsByOwner(t.actionItems ?? [], owners);

  await updateTranscript(transcriptId, { actionItemOwners: owners, actionItemsByOwner });
  revalidatePath(`/transcripts/${transcriptId}`);
}

/* ------------------------- starter agents ---------------------------- */

const STARTER_AGENTS: Omit<Agent, "id" | "createdAt" | "updatedAt" | "createdBy" | "runCount">[] = [
  {
    name: "Instagram + Email Agent",
    description:
      "Generates on-brand Instagram posts (caption, hashtags & visual brief) and emails the drafts straight to the client for review.",
    icon: "Camera",
    color: "#2dff9e",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are a senior social media strategist at a marketing agency. You write scroll-stopping, on-brand Instagram captions that drive engagement. Match the client's brand voice exactly. Each post must have a strong hook in the first line, a clear value or story in the body, a natural call-to-action, a tight set of relevant hashtags (mix of broad and niche, no banned/spammy tags), and a concrete art-direction brief for the accompanying visual. Never use clichés or generic filler.",
    outputKind: "instagram_posts",
    fields: [
      { key: "topic", label: "Topic / campaign", type: "text", placeholder: "Summer launch, product highlight…", required: true },
      { key: "count", label: "How many posts", type: "select", options: ["1", "2", "3", "4", "5"], defaultValue: "3" },
      { key: "goal", label: "Goal (optional)", type: "text", placeholder: "Drive sign-ups, build awareness…" },
      { key: "notes", label: "Extra notes (optional)", type: "textarea", placeholder: "Anything specific to include or avoid" },
    ],
    capabilities: ["generate", "generate_images", "create_assets", "email_client", "use_brand_voice", "use_transcripts"],
    status: "published",
    isActive: true,
    shared: true,
  },
  {
    name: "Writer Agent",
    description: "Drafts long-form articles, blog posts and copy tailored to the client's brand voice.",
    icon: "PenLine",
    color: "#a78bfa",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are an expert long-form content writer for a marketing agency. Write clear, engaging, well-structured articles in the client's brand voice. Use compelling headlines, scannable subheads, and a strong intro and conclusion. Avoid fluff and AI clichés.",
    outputKind: "article",
    fields: [
      { key: "topic", label: "Topic", type: "text", placeholder: "Article subject", required: true },
      { key: "wordCount", label: "Target length", type: "select", options: ["500", "800", "1200", "2000"], defaultValue: "800" },
      { key: "keywords", label: "Keywords (optional)", type: "text", placeholder: "comma separated" },
    ],
    capabilities: ["generate", "create_assets", "use_brand_voice"],
    status: "published",
    isActive: true,
    shared: true,
  },
  {
    name: "Email Campaign Agent",
    description: "Writes a complete marketing email (subject + body) and delivers it to the client to review.",
    icon: "Mail",
    color: "#5db4ff",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are an email marketing specialist. Write a high-converting marketing email in the client's brand voice. Start with the subject line on its own first line prefixed with 'Subject:'. Then write a compelling, concise body with one clear call-to-action.",
    outputKind: "email",
    fields: [
      { key: "topic", label: "Campaign / offer", type: "text", placeholder: "What is this email about?", required: true },
      { key: "audience", label: "Audience (optional)", type: "text", placeholder: "New leads, existing customers…" },
    ],
    capabilities: ["generate", "create_assets", "email_client", "use_brand_voice"],
    status: "published",
    isActive: true,
    shared: true,
  },
  {
    name: "Social Posts Agent",
    description: "Generates a batch of short posts for X/LinkedIn from a single idea, on brand.",
    icon: "Share2",
    color: "#ffcf5d",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are a social media copywriter. Produce a numbered batch of short, punchy social posts (suitable for X and LinkedIn) from the brief, in the client's brand voice. Vary the angle of each post.",
    outputKind: "social_posts",
    fields: [
      { key: "topic", label: "Idea / theme", type: "text", placeholder: "What should the posts be about?", required: true },
      { key: "count", label: "How many", type: "select", options: ["3", "5", "8"], defaultValue: "5" },
    ],
    capabilities: ["generate", "create_assets", "use_brand_voice"],
    status: "published",
    isActive: true,
    shared: true,
  },
];

export async function seedAgentsAction() {
  const user = await requireStaff();
  const now = Date.now();
  const ids: string[] = [];
  for (const a of STARTER_AGENTS) {
    ids.push(await createAgent({ ...a, createdBy: user.uid, createdAt: now, updatedAt: now, runCount: 0 }));
  }
  revalidatePath("/agents");
  return { count: ids.length };
}

/**
 * Import the karos-labs skill library (the `karos/*` library + the XO Digital client skills)
 * as runnable agents, mapping each SKILL.md onto an Agent system prompt (see labs-import.ts).
 *
 * Idempotent: keyed by `labsSkillId`, a re-run UPDATES each skill's agent in place (refreshing
 * name/description/prompt/config) rather than creating duplicates, and never overwrites the
 * agent's lifecycle (status/isActive) — so an admin who unpublished one keeps that choice.
 * Admin only: it bulk-creates dozens of live agents.
 */
export async function importLabsSkillsAction() {
  const user = await requireAdmin();
  const { buildLabsAgentSpecs } = await import("@/lib/agents/labs-import");
  const specs = buildLabsAgentSpecs();

  const existing = await listAgents();
  const byLabsId = new Map(
    existing.filter((a) => a.labsSkillId).map((a) => [a.labsSkillId as string, a] as const),
  );

  const now = Date.now();
  const result = { created: 0, updated: 0, failed: 0, total: specs.length };
  const CHUNK = 12; // bound Firestore write concurrency

  for (let i = 0; i < specs.length; i += CHUNK) {
    // allSettled so one transient Firestore error doesn't abort the whole import; a re-click is
    // idempotent, so the admin can retry just the failures.
    const settled = await Promise.allSettled(
      specs.slice(i, i + CHUNK).map(async (s) => {
        const config = {
          name: s.name,
          description: s.description,
          icon: s.icon,
          color: s.color,
          model: s.model,
          systemPrompt: s.systemPrompt,
          outputKind: s.outputKind,
          fields: s.fields,
          capabilities: s.capabilities,
          shared: s.shared,
        };
        const prior = byLabsId.get(s.labsSkillId);
        if (prior) {
          await updateAgent(prior.id, { ...config, updatedAt: now });
          return "updated" as const;
        }
        await createAgent({
          ...config,
          status: "published",
          isActive: true,
          labsSkillId: s.labsSkillId,
          createdBy: user.uid,
          createdAt: now,
          updatedAt: now,
          runCount: 0,
        });
        return "created" as const;
      }),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") result[r.value]++;
      else result.failed++;
    }
  }

  revalidatePath("/agents");
  return result;
}

/* -------------------------------- team ------------------------------- */

export async function createTeamMemberAction(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
  clientId?: string;
  assignedClientIds?: string[];
}) {
  await requireAdmin();
  const email = input.email.trim().toLowerCase();
  const userRecord = await adminAuth().createUser({
    email,
    password: input.password,
    displayName: input.name,
  });
  const user: AppUser = {
    uid: userRecord.uid,
    email,
    name: input.name.trim(),
    role: input.role,
    clientId: input.role === "CLIENT_USER" ? input.clientId ?? null : null,
    assignedClientIds: input.role === "KAROS_EMPLOYEE" ? input.assignedClientIds ?? [] : [],
    disabled: false,
    // Admin-created logins are approved on the spot — they never hit the Registrations queue.
    approvedAt: Date.now(),
    createdAt: Date.now(),
  };
  await upsertUser(user);
  revalidatePath("/team");
  return { uid: userRecord.uid };
}

/* --------------------------- registrations --------------------------- */

/**
 * Approve a pending self-signup: set the final role, link/create a client (for clients) or
 * assign clients (for employees), and flip the account live.
 */
export async function approveRegistrationAction(
  uid: string,
  input: {
    role: Role;
    /** role=client: link to this existing client. */
    clientId?: string | null;
    /** role=client: create a brand-new client with this name instead of linking. */
    newClientName?: string;
    /** role=employee: clients to assign. */
    assignedClientIds?: string[];
  },
) {
  const admin = await requireAdmin();
  const existing = await getUser(uid);
  if (!existing) throw new Error("User not found");

  const patch: Partial<AppUser> = {
    role: input.role,
    disabled: false,
    approvedAt: Date.now(),
    clientId: null,
    assignedClientIds: [],
  };

  if (input.role === "CLIENT_USER") {
    let clientId = input.clientId ?? null;
    const newName = input.newClientName?.trim();
    if (newName) {
      const clientKeyId = `ck_${randomBytes(16).toString("base64url")}`;
      clientId = await createClient({
        name: newName,
        website: "",
        industry: "",
        // Seed the contact with the client's own login email so meetings/assets auto-route.
        contactEmail: existing.email,
        domains: [],
        description: "",
        brandVoice: "",
        assignedEmployeeIds: [admin.uid],
        status: "active",
        clientKeyId,
        createdAt: Date.now(),
        createdBy: admin.uid,
      });
    }
    if (!clientId) throw new Error("Pick a client or create a new one for this person.");
    patch.clientId = clientId;
  } else if (input.role === "KAROS_EMPLOYEE") {
    patch.assignedClientIds = input.assignedClientIds ?? [];
  }

  await upsertUser({ ...existing, ...patch });
  await adminAuth().updateUser(uid, { disabled: false }).catch(() => {});
  revalidatePath("/registrations");
  revalidatePath("/team");
}

/** Reject a pending registration: remove the Firestore doc and the auth account. */
export async function rejectRegistrationAction(uid: string) {
  await requireAdmin();
  await deleteUser(uid);
  await adminAuth().deleteUser(uid).catch(() => {});
  revalidatePath("/registrations");
  revalidatePath("/team");
}

export async function updateTeamMemberAction(uid: string, patch: Partial<AppUser>) {
  await requireAdmin();
  const existing = await getUser(uid);
  if (!existing) throw new Error("User not found");
  await upsertUser({ ...existing, ...patch });
  if (patch.disabled !== undefined) {
    await adminAuth().updateUser(uid, { disabled: patch.disabled }).catch(() => {});
  }
  revalidatePath("/team");
}

/**
 * Toggle the isGroupAdmin flag on a client user.
 * Admins can toggle anyone; client group-admins can toggle others within their own group.
 */
export async function toggleGroupAdminAction(uid: string, isGroupAdmin: boolean) {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");

  const target = await getUser(uid);
  if (!target) throw new Error("User not found");

  if (user.role === "KAROS_ADMIN") {
    await upsertUser({ ...target, isGroupAdmin });
  } else if (user.role === "CLIENT_USER" && user.isGroupAdmin) {
    if (target.clientId !== user.clientId) throw new Error("Forbidden — different group");
    if (target.uid === user.uid) throw new Error("Cannot change your own group admin status");
    await upsertUser({ ...target, isGroupAdmin });
  } else {
    throw new Error("Forbidden");
  }

  revalidatePath("/team");
}

/** Begin impersonating a client user. Redirects to /dashboard as that user on success. */
export async function startImpersonationAction(targetUid: string) {
  await startImpersonation(targetUid);
  redirect("/dashboard");
}

/** End impersonation and return to the admin's real session. Redirects to /team. */
export async function stopImpersonationAction() {
  await stopImpersonation();
  redirect("/team");
}

/* ─────────────────── Intelligence Report Actions ─────────────────── */

/**
 * Parse a raw Markdown report, persist it, and bulk-create competitor rows.
 * Admin/employee only. Overwrites any existing report for this client.
 */
export async function importReportAction(
  clientId: string,
  markdown: string,
  pdfUrl?: string,
): Promise<void> {
  const user = await requireStaff();

  const client = await getClient(clientId);
  if (!client) throw new Error("Client not found");

  const parsed = parseMarkdownReport(markdown);
  const report = buildClientReport(clientId, parsed, markdown, pdfUrl);
  await upsertClientReport(report);

  // Atomically replace competitors: delete old + create new in one Firestore batch
  const now = Date.now();
  await replaceReportCompetitors(
    clientId,
    parsed.competitorRows.map((row) => ({
      ...row,
      clientId,
      source: "report" as const,
      createdAt: now,
      updatedAt: now,
    })),
  );

  await _logActivity({
    clientId,
    timestamp: now,
    type: "INTEL_GENERATION",
    title: "Intel Report imported",
    description: `Markdown report parsed — score ${report.overallScore}/100 (${report.overallGrade}), ${parsed.competitorRows.length} competitors`,
    actor: user.name,
    actorRole: "staff",
  });

  revalidatePath(`/clients/${clientId}`);
}

/** Manually add a competitor to a client's tracker. */
export async function addCompetitorAction(
  clientId: string,
  input: {
    company: string;
    url?: string;
    founded?: string;
    marketTier: ClientCompetitor["marketTier"];
    minInvestment?: string;
    overlap: ClientCompetitor["overlap"];
    positioning?: string;
    scale?: string;
    keyStrengths?: string[];
    keyWeaknesses?: string[];
    threatLevel?: ClientCompetitor["threatLevel"];
  },
): Promise<void> {
  await requireStaff();

  const now = Date.now();
  await createClientCompetitor({
    clientId,
    company: input.company,
    url: input.url,
    founded: input.founded,
    marketTier: input.marketTier,
    minInvestment: input.minInvestment,
    overlap: input.overlap,
    deepDive: false,
    positioning: input.positioning,
    scale: input.scale,
    keyStrengths: input.keyStrengths ?? [],
    keyWeaknesses: input.keyWeaknesses ?? [],
    threatLevel: input.threatLevel,
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });

  // Dual-write: append this competitor as a dated signal to the competitor-analysis context doc
  // so the next pipeline regeneration can read it and include it in the AI synthesis.
  try {
    const existingDoc = await getClientContextDoc(clientId, "competitor-analysis");
    if (existingDoc) {
      const today = new Date().toISOString().slice(0, 10);
      const signal = [
        "",
        "---",
        "",
        `## Manually Added Competitor — ${today}`,
        `- **Company:** ${input.company}`,
        ...(input.url ? [`- **Website:** ${input.url}`] : []),
        `- **Market Tier:** ${input.marketTier}`,
        ...(input.threatLevel ? [`- **Threat Level:** ${input.threatLevel}`] : []),
        `- **Overlap:** ${input.overlap}`,
        ...(input.positioning ? [`- **Positioning:** ${input.positioning}`] : []),
        ...(input.keyStrengths?.length
          ? [`- **Key Strengths:** ${input.keyStrengths.join(", ")}`]
          : []),
        ...(input.keyWeaknesses?.length
          ? [`- **Key Weaknesses:** ${input.keyWeaknesses.join(", ")}`]
          : []),
      ].join("\n");

      await upsertClientContextDoc({
        clientId,
        docType: "competitor-analysis",
        tier: existingDoc.tier,
        content: existingDoc.content + signal,
        version: existingDoc.version,
        sources: existingDoc.sources,
        createdAt: existingDoc.createdAt,
        updatedAt: now,
      });
    }
  } catch {
    // Non-fatal: competitor creation already succeeded; context doc update is best-effort
  }

  revalidatePath(`/clients/${clientId}`);
}

/** Remove a competitor from the tracker. */
export async function deleteCompetitorAction(id: string): Promise<void> {
  await requireStaff();
  await deleteClientCompetitor(id);
  revalidatePath("/clients");
}

/* ── Core AI analysis helper (not exported — server-only) ──────────────── */

async function _analyzeCompetitors(clientId: string): Promise<void> {
  const [client, competitors] = await Promise.all([
    getClient(clientId),
    listClientCompetitors(clientId),
  ]);
  if (!client || competitors.length === 0) return;

  const { generateObject } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { z } = await import("zod");

  const schema = z.object({
    competitors: z.array(
      z.object({
        company: z.string().describe(
          "Exact competitor name as provided.",
        ),
        url: z.string().optional().describe(
          "Primary website URL. Omit if unknown.",
        ),
        positioning: z.string().optional().describe(
          "STRICT: 3–5 words max. Noun phrase only — NO verbs, NO sentences, NO punctuation. " +
          "Good: 'Enterprise marketing automation' | 'AI-driven B2B outreach' | 'SMB payroll platform'. " +
          "Bad: 'They offer a high-end automated marketing solution for enterprise clients.'",
        ),
        keyStrengths: z.array(z.string()).describe(
          "STRICT: 2–3 items, each 2–4 words max. Keywords only — NO sentences, NO fluff. " +
          "Good: ['Global brand authority', 'Massive capital runway', 'G2 Leader badge']. " +
          "Bad: ['Having a massive budget and a very recognizable global brand presence.']",
        ),
        keyWeaknesses: z.array(z.string()).describe(
          "STRICT: 2–3 items, each 2–4 words max. Keywords only — NO sentences, NO fluff. " +
          "Good: ['Complex onboarding', 'Legacy UI/UX', 'Enterprise-only pricing']. " +
          "Bad: ['Their software is very outdated and difficult for small teams to onboard.']",
        ),
        threatLevel: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
        marketTier: z.enum(["Leader", "Challenger", "Niche", "Other"]),
        overlap: z.enum(["High", "Medium", "Low-Med", "Low"]),
      }),
    ),
  });

  const names = competitors.map((c) => c.company).join(", ");
  const clientCtx = [
    client.name,
    client.website ? `(${client.website})` : "",
    client.description ? `— ${client.description}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-6"),
    schema,
    system:
      "You are a competitive intelligence analyst producing data for a compact UI dashboard table. " +
      "Every text field you output is rendered directly in a table cell — long text BREAKS the layout. " +
      "\n\nABSOLUTE FORMATTING RULES (violating these corrupts the UI):\n" +
      "• positioning — max 5 words, noun phrase, no verbs. e.g. 'Enterprise marketing automation'\n" +
      "• keyStrengths items — max 4 words each. e.g. 'Global brand authority'\n" +
      "• keyWeaknesses items — max 4 words each. e.g. 'Complex onboarding'\n" +
      "• NEVER write complete sentences, introductory phrases ('They focus on...', 'Their main strength is...'), or trailing punctuation.\n" +
      "• NEVER use filler words: 'very', 'highly', 'extremely', 'robust', 'comprehensive', 'cutting-edge'.\n" +
      "• Data must be specific and scannable in under 2 seconds.",
    prompt: `Analyze these competitors for ${clientCtx}.

COMPETITORS: ${names}

Return one object per competitor. Field rules:
- company: exact name as listed
- url: primary website (omit if unknown)
- positioning: ≤5 words, noun phrase — e.g. "AI-driven B2B outreach"
- keyStrengths: 2–3 items, ≤4 words each — e.g. ["G2 Leader badge", "ISO enterprise compliance"]
- keyWeaknesses: 2–3 items, ≤4 words each — e.g. ["Legacy UI/UX", "SMB pricing gap"]
- threatLevel: HIGH (same ICP + budget) | MEDIUM (partial overlap) | LOW (adjacent only)
- marketTier: Leader | Challenger | Niche | Other
- overlap: High | Medium | Low-Med | Low`,
    maxOutputTokens: 3500,
  });

  if (object.competitors.length === 0) return;

  const now = Date.now();
  await replaceReportCompetitors(
    clientId,
    object.competitors.map((c) => ({
      ...c,
      clientId,
      deepDive: false,
      source: "report" as const,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

/** Fire-and-forget activity log writer. Never throws — never blocks the caller. */
async function _logActivity(data: Omit<ActivityLog, "id">): Promise<void> {
  try {
    await createActivityLog(data);
  } catch {
    // Non-fatal
  }
}

/** Add a competitor by name and trigger AI analysis for the full tracked list. */
export async function addCompetitorAndAnalyzeAction(
  clientId: string,
  name: string,
): Promise<void> {
  const user = await requireStaff();
  if (!name.trim()) throw new Error("Competitor name required");

  // Persist the stub first so the name is immediately visible
  await createClientCompetitor({
    clientId,
    company: name.trim(),
    marketTier: "Challenger",
    overlap: "Medium",
    deepDive: false,
    keyStrengths: [],
    keyWeaknesses: [],
    source: "manual",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  await _logActivity({
    clientId,
    timestamp: Date.now(),
    type: "COMPETITOR_ADDED",
    title: `Competitor added: ${name.trim()}`,
    actor: user.name,
    actorRole: "staff",
  });

  // Best-effort — if AI fails, stub is still saved for the next report generation
  try {
    await _analyzeCompetitors(clientId);
    await _logActivity({
      clientId,
      timestamp: Date.now(),
      type: "COMPETITOR_ANALYZED",
      title: "Competitor intelligence updated",
      description: "AI analyzed all tracked competitors and refreshed profiles",
      actor: "System AI",
      actorRole: "system",
    });
  } catch {
    // Analysis failed; competitor name is saved, profiles will populate on next report run
  }

  revalidatePath(`/clients/${clientId}`);
}

/** Discover and fully analyze top competitors from scratch (for clients with no existing data). */
export async function backfillCompetitorsAction(clientId: string): Promise<void> {
  await requireStaff();
  const client = await getClient(clientId);
  if (!client) throw new Error("Client not found");

  const { generateObject } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { z } = await import("zod");

  const schema = z.object({
    competitors: z.array(
      z.object({
        company: z.string().describe(
          "Exact competitor company name.",
        ),
        url: z.string().optional().describe(
          "Primary website URL. Omit if unknown.",
        ),
        positioning: z.string().optional().describe(
          "STRICT: 3–5 words max. Noun phrase only — NO verbs, NO sentences, NO punctuation. " +
          "Good: 'Enterprise marketing automation' | 'AI-driven B2B outreach' | 'SMB payroll platform'. " +
          "Bad: 'They offer a high-end automated marketing solution for enterprise clients.'",
        ),
        keyStrengths: z.array(z.string()).describe(
          "STRICT: 2–3 items, each 2–4 words max. Keywords only — NO sentences, NO fluff. " +
          "Good: ['Global brand authority', 'Massive capital runway', 'G2 Leader badge']. " +
          "Bad: ['Having a massive budget and a very recognizable global brand presence.']",
        ),
        keyWeaknesses: z.array(z.string()).describe(
          "STRICT: 2–3 items, each 2–4 words max. Keywords only — NO sentences, NO fluff. " +
          "Good: ['Complex onboarding', 'Legacy UI/UX', 'Enterprise-only pricing']. " +
          "Bad: ['Their software is very outdated and difficult for small teams to onboard.']",
        ),
        threatLevel: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
        marketTier: z.enum(["Leader", "Challenger", "Niche", "Other"]),
        overlap: z.enum(["High", "Medium", "Low-Med", "Low"]),
      }),
    ),
  });

  const clientCtx = [
    `Company: ${client.name}`,
    client.website ? `Website: ${client.website}` : "",
    client.description ? `Description: ${client.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-6"),
    schema,
    system:
      "You are a market intelligence analyst producing data for a compact UI dashboard table. " +
      "Every text field you output is rendered directly in a table cell — long text BREAKS the layout. " +
      "\n\nABSOLUTE FORMATTING RULES (violating these corrupts the UI):\n" +
      "• positioning — max 5 words, noun phrase, no verbs. e.g. 'Enterprise marketing automation'\n" +
      "• keyStrengths items — max 4 words each. e.g. 'Global brand authority'\n" +
      "• keyWeaknesses items — max 4 words each. e.g. 'Complex onboarding'\n" +
      "• NEVER write complete sentences, introductory phrases ('They focus on...', 'Their main strength is...'), or trailing punctuation.\n" +
      "• NEVER use filler words: 'very', 'highly', 'extremely', 'robust', 'comprehensive', 'cutting-edge'.\n" +
      "• Data must be specific and scannable in under 2 seconds.",
    prompt: `${clientCtx}

Identify the top 5–7 direct competitors. Discovery criteria:
- Same or heavily overlapping target market / ICP
- Comparable product or service category
- Competing for the same customer budget or attention

Return one object per competitor. Field rules:
- company: exact company name
- url: primary website (omit if unknown)
- positioning: ≤5 words, noun phrase — e.g. "AI-driven B2B outreach"
- keyStrengths: 2–3 items, ≤4 words each — e.g. ["G2 Leader badge", "ISO enterprise compliance"]
- keyWeaknesses: 2–3 items, ≤4 words each — e.g. ["Legacy UI/UX", "SMB pricing gap"]
- threatLevel: HIGH (same ICP + budget) | MEDIUM (partial overlap) | LOW (adjacent only)
- marketTier: Leader | Challenger | Niche | Other
- overlap: High | Medium | Low-Med | Low`,
    maxOutputTokens: 4500,
  });

  if (object.competitors.length === 0) throw new Error("No competitors discovered — try adding names manually.");

  const now = Date.now();
  await replaceReportCompetitors(
    clientId,
    object.competitors.map((c) => ({
      ...c,
      clientId,
      deepDive: false,
      source: "report" as const,
      createdAt: now,
      updatedAt: now,
    })),
  );

  await _logActivity({
    clientId,
    timestamp: now,
    type: "COMPETITOR_ANALYZED",
    title: "Competitors discovered & analyzed",
    description: `AI identified and profiled ${object.competitors.length} competitors`,
    actor: "System AI",
    actorRole: "system",
  });

  revalidatePath(`/clients/${clientId}`);
}

/** Save or update branding guidelines for a client. Single source of truth:
 *  writes the structured client field AND keeps both context docs in sync so
 *  AI agents never see stale or conflicting branding data.
 */
export async function saveBrandingGuidelinesAction(
  clientId: string,
  guidelines: Omit<BrandingGuidelines, "updatedAt">,
): Promise<void> {
  const user = await requireStaff();

  const fullGuidelines: BrandingGuidelines = { ...guidelines, updatedAt: Date.now() };
  const now = Date.now();

  // Update client record + fetch all docs that need syncing in parallel
  const [, client, brandingDoc, voiceDoc] = await Promise.all([
    updateClient(clientId, { brandingGuidelines: fullGuidelines }),
    getClient(clientId),
    getClientContextDoc(clientId, "branding-guidelines"),
    getClientContextDoc(clientId, "brand-voice"),
  ]);

  const clientName = client?.name ?? clientId;

  // Sync both context docs — failures are non-fatal (client record is already updated)
  await Promise.allSettled([
    // 1. Replace branding-guidelines doc entirely (it IS the structured data in markdown form)
    upsertClientContextDoc({
      clientId,
      docType: "branding-guidelines",
      tier: brandingDoc?.tier ?? "internal",
      content: brandingToContextDocContent(fullGuidelines, clientName),
      version: (brandingDoc?.version ?? 0) + 1,
      sources: brandingDoc?.sources,
      createdAt: brandingDoc?.createdAt ?? now,
      updatedAt: now,
    }),
    // 2. Inject / refresh the BRAND_SYNC block inside the brand-voice doc so tone
    //    keywords and visual tokens are visible to agents that only read that doc.
    voiceDoc
      ? upsertClientContextDoc({
          clientId,
          docType: "brand-voice",
          tier: voiceDoc.tier,
          content: injectBrandVoiceSection(voiceDoc.content, buildBrandVoiceSection(fullGuidelines)),
          version: voiceDoc.version + 1,
          sources: voiceDoc.sources,
          createdAt: voiceDoc.createdAt,
          updatedAt: now,
        })
      : Promise.resolve(),
  ]);

  await _logActivity({
    clientId,
    timestamp: now,
    type: "BRANDING_UPDATED",
    title: "Brand guidelines updated",
    description: "Colors, fonts and tone keywords manually saved",
    actor: user.name,
    actorRole: "staff",
  });

  revalidatePath(`/clients/${clientId}`);
}

/**
 * Auto-generate branding guidelines for a client.
 * Scrapes the client's website for colors/fonts/visual style; falls back to a
 * preset archetype if scraping yields nothing or no website is set.
 * Syncs both context docs so agents immediately see the new values.
 *
 * Returns scrape result metadata for UI feedback.
 */
export async function generateBrandingAction(clientId: string): Promise<BrandingGenResult> {
  const user = await requireStaff();

  const result = await applyBrandingForClient(clientId);

  await _logActivity({
    clientId,
    timestamp: Date.now(),
    type: "BRANDING_UPDATED",
    title: "Brand guidelines generated via AI",
    description: `AI generated brand profile from domain knowledge${result.primaryColor ? ` · ${result.primaryColor}` : ""}${result.visualStyle ? ` · ${result.visualStyle}` : ""}`,
    actor: user.name,
    actorRole: "staff",
    metadata: { source: result.source, primaryColor: result.primaryColor },
  });

  revalidatePath(`/clients/${clientId}`);
  return result;
}

/**
 * One-time retroactive backfill: scrape every client's website and sync branding
 * data + context docs for the full client list. Admin-only.
 */
export async function backfillBrandingForAllClientsAction(): Promise<{
  total: number;
  generated: number;
  failed: number;
  results: Array<{ clientId: string; name: string; status: "ai_generated" | "failed"; primaryColor?: string }>;
}> {
  await requireAdmin();

  const clients = await listClients();
  const results: Array<{
    clientId: string;
    name: string;
    status: "ai_generated" | "failed";
    primaryColor?: string;
  }> = [];

  for (const client of clients) {
    try {
      const r = await applyBrandingForClient(client.id, client);
      results.push({ clientId: client.id, name: client.name, status: r.source, primaryColor: r.primaryColor });
    } catch (err) {
      console.error(`[backfill] Failed for ${client.name} (${client.id}):`, err);
      results.push({ clientId: client.id, name: client.name, status: "failed" });
    }
  }

  revalidatePath("/clients");

  return {
    total: clients.length,
    generated: results.filter((r) => r.status === "ai_generated").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}

/* ------------------------ client context ----------------------------- */

export async function deleteContextItemAction(id: string) {
  await requireStaff();
  const item = await getContextItem(id);
  if (!item) return;
  await deleteObject(item.storagePath);
  await deleteContextItem(id);
  revalidatePath(`/clients/${item.clientId}`);
}

export async function updateContextItemNoteAction(id: string, note: string) {
  await requireStaff();
  const item = await getContextItem(id);
  if (!item) throw new Error("Context item not found");
  await updateContextItem(id, { note: note.trim() });
  revalidatePath(`/clients/${item.clientId}`);
}

/* ------------------------- access tokens ----------------------------- */

/** Mint a personal access token for MCP clients. Returns the plaintext ONCE. */
export async function createAccessTokenAction(name: string) {
  const user = await requireStaff();
  const { id, token } = await issueAccessToken(user.uid, name);
  revalidatePath("/connect");
  return { id, token };
}

/** Revoke one of the caller's own tokens. */
export async function revokeAccessTokenAction(id: string) {
  const user = await requireStaff();
  const owned = await listAccessTokens(user.uid);
  if (!owned.some((t) => t.id === id)) throw new Error("Token not found");
  await updateAccessToken(id, { revoked: true });
  revalidatePath("/connect");
}

/* ─────────────────── PDF Report Upload ─────────────────── */

/**
 * Upload a PDF report file to Firebase Storage and return its durable download URL.
 * Accepts raw bytes as a number[] (JSON-serializable) from the browser.
 * Path: clients/{clientId}/reports/{timestamp}_intel.pdf
 */
export async function uploadReportPdfAction(
  clientId: string,
  bytes: number[],
): Promise<string> {
  await requireStaff();

  const buffer = Buffer.from(bytes);
  const path = `clients/${clientId}/reports/${Date.now()}_intel.pdf`;
  const { url } = await uploadBytes({ bytes: buffer, path, contentType: "application/pdf" });
  return url;
}

/* ────────────────── Intel Report Agent Actions ──────────────────── */

/**
 * Seed the Intel Report system agent into Firestore (idempotent).
 * Creates the document with the default prompt if it doesn't exist yet.
 * Admin-only: call once from the admin UI or on first deploy.
 */
export async function seedIntelAgentAction(): Promise<void> {
  await requireAdmin();
  const { INTEL_AGENT_ID, DEFAULT_INTEL_PROMPT } = await import("@/lib/intel-report");
  const existing = await getAgent(INTEL_AGENT_ID);
  if (existing) return; // already seeded — do not overwrite customised prompt
  const now = Date.now();
  await upsertSystemAgent(INTEL_AGENT_ID, {
    name: "Intel Report Agent",
    description:
      "Automated Digital Intelligence & Competitive Report generator. Runs via Claude API — never shown to clients.",
    icon: "BarChart2",
    color: "#C8FF00",
    model: "claude-opus-4-8",
    systemPrompt: DEFAULT_INTEL_PROMPT,
    outputKind: "freeform",
    fields: [],
    capabilities: ["generate"],
    status: "published",
    isActive: true,
    shared: false,
    isSystem: true,
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  });
}

/**
 * Update the Intel Report Agent's system prompt template.
 * Changes take effect on the next pipeline run.
 * Admin-only.
 */
export async function updateIntelPromptAction(template: string): Promise<void> {
  await requireAdmin();
  const { INTEL_AGENT_ID } = await import("@/lib/intel-report");
  await updateAgent(INTEL_AGENT_ID, { systemPrompt: template, updatedAt: Date.now() });
}

/**
 * Run the Intel Report pipeline for a client.
 * Calls Claude API, parses the output, stores competitors + report in Firestore,
 * and uploads a styled HTML report to Firebase Storage.
 * Admins and employees only.
 */
export async function generateIntelReportAction(clientId: string): Promise<void> {
  await requireStaff();
  // Auto-seed the agent if it hasn't been seeded yet (first-time setup)
  const { INTEL_AGENT_ID, runIntelReportPipeline } = await import("@/lib/intel-report");
  const existing = await getAgent(INTEL_AGENT_ID);
  if (!existing) await seedIntelAgentAction();
  await runIntelReportPipeline(clientId);
  await _logActivity({
    clientId,
    timestamp: Date.now(),
    type: "INTEL_GENERATION",
    title: "Intel Report generated",
    description: "Full 5-agent competitive intelligence pipeline completed",
    actor: "System AI",
    actorRole: "system",
  });
  revalidatePath(`/clients/${clientId}`);
}

/* ── Activity log ──────────────────────────────────────────────────────── */

/** Add an internal staff note to the client's activity timeline. */
export async function addActivityNoteAction(clientId: string, text: string): Promise<void> {
  const user = await requireStaff();
  if (!text.trim()) throw new Error("Note text is required");
  await createActivityLog({
    clientId,
    timestamp: Date.now(),
    type: "MANUAL_NOTE",
    title: "Note",
    description: text.trim(),
    actor: user.name,
    actorRole: "staff",
  });
  revalidatePath(`/clients/${clientId}`);
}

/**
 * Re-condense the existing internal context docs for a client into fresh client-tier docs.
 * Does NOT re-run the full 5-agent research pipeline — only the condensation pass.
 * Use for the monthly refresh or when branding/strategy changes warrant a client doc update.
 * Admins and employees only.
 */
export async function refreshClientContextDocsAction(clientId: string): Promise<void> {
  await requireStaff();
  const { INTEL_AGENT_ID } = await import("@/lib/intel-report");

  const [client, agent, internalDocs] = await Promise.all([
    getClient(clientId),
    getSystemAgent(INTEL_AGENT_ID),
    listClientContextDocs(clientId, "internal"),
  ]);
  if (!client) throw new Error("Client not found");

  const { RESEARCH_ENGINE_RULES, METRICS_RULES } = await import("@/lib/onboard-templates");
  const isLegacyPrompt = agent?.systemPrompt?.startsWith("You are the Karos Intel AI");
  const additionalInstructions = (!isLegacyPrompt && agent?.systemPrompt) ? agent.systemPrompt : "";
  const rules = [RESEARCH_ENGINE_RULES, "", METRICS_RULES, additionalInstructions.trim()]
    .filter(Boolean)
    .join("\n");

  const internalMap: Record<string, string> = {};
  for (const doc of internalDocs) internalMap[doc.docType] = doc.content;

  const { refreshClientCondensedDocs } = await import("@/lib/condense-pipeline");
  const condensed = await refreshClientCondensedDocs(client, internalMap, rules);

  // Replace only client-tier docs (leave internal and internal-only untouched)
  const existing = await listClientContextDocs(clientId);
  const nonClientDocs = existing.filter((d) => d.tier !== "client");
  const now = Date.now();

  await replaceClientContextDocs(clientId, [
    ...nonClientDocs.map(({ id: _id, ...rest }) => ({ ...rest, updatedAt: now })),
    ...condensed.map((doc) => ({
      clientId,
      docType: doc.docType,
      tier: "client" as const,
      content: doc.content,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
  ]);

  revalidatePath(`/clients/${clientId}`);
}

/**
 * Generate a 4-5 bullet executive summary for a context document using Claude Haiku.
 * Results are ephemeral — cached in client component state per session, not persisted.
 * Accessible to all non-disabled authenticated users who have access to the client.
 */
export async function generateDocSummaryAction(
  clientId: string,
  docType: string,
  tier: string,
): Promise<string[]> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) throw new Error("Forbidden");

  const docs = await listClientContextDocs(clientId);
  const doc =
    docs.find((d) => d.docType === docType && d.tier === tier) ??
    docs.find((d) => d.docType === docType);
  if (!doc) return [];

  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const MODEL = "claude-haiku-4-5-20251001";
  const { text, usage } = await generateText({
    model: anthropic(MODEL),
    system:
      "You are a strategic analyst. Distill the document into exactly 4-5 high-impact executive insights. " +
      "Return ONLY a valid JSON array of strings — no markdown, no preamble, no trailing text. " +
      "Each string: max 20 words, starts with an action verb or key noun, concrete and specific.",
    messages: [
      {
        role: "user",
        content: doc.content.replace(/^---[\s\S]*?---\n?/, "").slice(0, 4000),
      },
    ],
    maxOutputTokens: 450,
  });

  // Non-blocking token logging — deferred past the response via after()
  after(() =>
    logger.logUsage({
      clientId,
      agentId: null,
      agentName: "Executive Summary",
      modelName: MODEL,
      operation: "doc_summary",
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }),
  );

  try {
    const cleaned = text.trim().replace(/^```(?:json)?\n?|\n?```$/g, "");
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr))
      return arr.filter((s): s is string => typeof s === "string" && s.length > 4).slice(0, 5);
  } catch {
    // Fallback: parse line-by-line
  }
  return text
    .split("\n")
    .map((l) => l.replace(/^[-*\d."'\[\]]+\s*/, "").trim())
    .filter((l) => l.length > 8)
    .slice(0, 5);
}

/* ----------------------- client integrations ------------------------- */

/**
 * Save (create or overwrite) a social platform integration for a client.
 * Empty-string values are stripped before saving to avoid persisting blank fields.
 */
export async function saveIntegrationAction(
  clientId: string,
  platform: string,
  credentials: Record<string, string>,
  accountName?: string,
): Promise<void> {
  const user = await requireStaff();

  // Strip keys with empty values — they may represent unchanged password fields
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) {
    if (v.trim()) cleaned[k] = v.trim();
  }

  await upsertClientIntegration({
    clientId,
    platform,
    credentials: cleaned,
    accountName: accountName?.trim() || undefined,
    method: "manual",
    connectedBy: user.uid,
    connectedAt: Date.now(),
    updatedAt: Date.now(),
  });

  revalidatePath(`/clients/${clientId}`);
}

/** Set an asset's status to "scheduled" with a future publish time and optional target platform. */
export async function scheduleAssetAction(
  id: string,
  scheduledAt: number,
  platform?: string,
): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  if (user.role === "CLIENT_USER" && asset.clientId !== user.clientId) throw new Error("Forbidden");
  await updateAsset(id, {
    status: "scheduled",
    scheduledAt,
    ...(platform ? { scheduledPlatform: platform } : {}),
    updatedAt: Date.now(),
  });
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
}

/** Revert a scheduled asset back to draft and clear its schedule. */
export async function unscheduleAssetAction(id: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  if (user.role === "CLIENT_USER" && asset.clientId !== user.clientId) throw new Error("Forbidden");
  await clearAssetSchedule(id);
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
}

/** Remove a platform integration and all stored credentials for a client. */
export async function deleteIntegrationAction(
  clientId: string,
  platform: string,
): Promise<void> {
  await requireStaff();
  await deleteClientIntegration(clientId, platform);
  revalidatePath(`/clients/${clientId}`);
}

/* ─────────────────── Client Access Requests ────────────────────────── */

/**
 * Submit a "Request New Client Setup" form from a prospective customer who
 * doesn't have a clientKeyId. Saves to `clientRequests` and fires a
 * notification email to the internal Karos admin mailbox (KAROS_EMAIL env var).
 * Public — no auth required.
 */
export async function submitClientRequestAction(input: {
  companyName: string;
  website?: string;
  adminEmail: string;
  useCase: string;
}): Promise<{ ok: boolean; error?: string }> {
  const companyName = input.companyName.trim();
  const adminEmail = input.adminEmail.trim().toLowerCase();
  const useCase = input.useCase.trim();

  if (!companyName || !adminEmail || !useCase) {
    return { ok: false, error: "Company name, admin email, and use case are required." };
  }

  const data: Omit<ClientRequest, "id"> = {
    companyName,
    website: input.website?.trim() || undefined,
    adminEmail,
    useCase,
    status: "PENDING_APPROVAL",
    submittedAt: Date.now(),
  };

  await createClientRequest(data);

  // Fire-and-forget notification email to internal staff.
  try {
    const { sendEmail } = await import("@/lib/email");
    const to = process.env.KAROS_EMAIL || "hello@karoslabs.com";
    await sendEmail({
      to,
      subject: `[KarosCMO] New client access request — ${companyName}`,
      html: `
        <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;background:#07090b;padding:32px;color:#e8f0ec;">
          <h2 style="color:#2dff9e;margin:0 0 16px;">New Client Access Request</h2>
          <table style="border-collapse:collapse;width:100%;max-width:560px;">
            <tr><td style="padding:6px 12px 6px 0;color:#8aa2a8;white-space:nowrap;">Company</td><td style="padding:6px 0;"><strong>${companyName}</strong></td></tr>
            <tr><td style="padding:6px 12px 6px 0;color:#8aa2a8;">Website</td><td style="padding:6px 0;">${input.website?.trim() || "—"}</td></tr>
            <tr><td style="padding:6px 12px 6px 0;color:#8aa2a8;">Admin Email</td><td style="padding:6px 0;">${adminEmail}</td></tr>
            <tr><td style="padding:6px 12px 6px 0;color:#8aa2a8;vertical-align:top;">Use Case</td><td style="padding:6px 0;">${useCase}</td></tr>
          </table>
          <p style="margin:20px 0 0;color:#5f7177;font-size:13px;">Review this request in the KarosCMO Registrations dashboard.</p>
        </div>`,
    });
  } catch {
    // Email failure is non-fatal — the request is already saved to Firestore.
  }

  return { ok: true };
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

/**
 * Approve or reject a client access request. Staff-only.
 * On approval, the staff will then create the client manually and issue a clientKeyId.
 */
export async function reviewClientRequestAction(
  id: string,
  status: "APPROVED" | "REJECTED",
  reviewNotes?: string,
): Promise<void> {
  const admin = await requireStaff();
  await updateClientRequest(id, {
    status,
    reviewedAt: Date.now(),
    reviewedBy: admin.uid,
    reviewNotes: reviewNotes?.trim() || undefined,
  });
  revalidatePath("/registrations");
}

/* ------------------------------ settings ------------------------------ */

/** Update the current user's display name in both Firestore and Firebase Auth. */
export async function updateUserProfileAction(name: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name cannot be empty.");
  if (trimmed.length > 100) throw new Error("Name is too long (max 100 characters).");
  await upsertUser({ ...user, name: trimmed });
  await adminAuth().updateUser(user.uid, { displayName: trimmed });
  revalidatePath("/settings");
}

/**
 * Change the current user's password.
 * Verifies the current password via the Firebase Auth REST API (the only server-side
 * way to re-authenticate without a client-side credential), then updates via Admin SDK.
 */
export async function updatePasswordAction(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (newPassword.length < 6) throw new Error("New password must be at least 6 characters.");

  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) throw new Error("Firebase API key is not configured.");

  const verifyRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: currentPassword,
        returnSecureToken: false,
      }),
    },
  );
  if (!verifyRes.ok) throw new Error("Current password is incorrect.");

  await adminAuth().updateUser(user.uid, { password: newPassword });
}

/* ── Action Item Assignment & Notifications ───────────────────────────── */

/**
 * Explicitly assign (or un-assign) a meeting action item to a user by their UID.
 * Updates both the display-name `actionItemOwners` array and the UID-keyed
 * `actionItemAssignedUserIds` array, plus the denormalised `assignedUserIds`
 * set used by the notification bell query.
 *
 * Access rules:
 *   - Staff (admin / employee): can assign to any user in the meeting's context.
 *   - CLIENT_USER: can only assign the item to themselves or unassign it,
 *     and only within their own client's meetings.
 */
export async function assignActionItemToUserAction(
  transcriptId: string,
  itemIndex: number,
  assignedUserId: string | null,
): Promise<void> {
  const viewer = await getCurrentUser();
  if (!viewer || viewer.disabled) throw new Error("Unauthorized");

  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  if (viewer.role === "CLIENT_USER") {
    if (t.clientId !== viewer.clientId) throw new Error("Forbidden");
    if (assignedUserId !== null && assignedUserId !== viewer.uid) throw new Error("Forbidden");
  }

  const items = t.actionItems ?? [];
  const len = items.length;

  const newOwners = [...(t.actionItemOwners ?? Array<null>(len).fill(null))];
  while (newOwners.length < len) newOwners.push(null);

  const newAssignedIds = [...(t.actionItemAssignedUserIds ?? Array<null>(len).fill(null))];
  while (newAssignedIds.length < len) newAssignedIds.push(null);

  if (assignedUserId === null) {
    newOwners[itemIndex] = null;
    newAssignedIds[itemIndex] = null;
  } else {
    const target = await getUser(assignedUserId);
    newOwners[itemIndex] = target?.name ?? target?.email ?? null;
    newAssignedIds[itemIndex] = assignedUserId;
  }

  const assignedUserIds = [...new Set(newAssignedIds.filter((id): id is string => id !== null))];

  await updateTranscript(transcriptId, {
    actionItemOwners: newOwners,
    actionItemAssignedUserIds: newAssignedIds,
    assignedUserIds,
  });

  revalidatePath(`/transcripts/${transcriptId}`);
}

/**
 * Dismiss a notification item from the bell by marking the action item as complete.
 * Only the user the item is assigned to may call this.
 */
export async function dismissAssignedActionItemAction(
  transcriptId: string,
  itemIndex: number,
): Promise<void> {
  const viewer = await getCurrentUser();
  if (!viewer || viewer.disabled) throw new Error("Unauthorized");

  const t = await getTranscript(transcriptId);
  if (!t) throw new Error("Transcript not found");

  if (t.actionItemAssignedUserIds?.[itemIndex] !== viewer.uid) {
    throw new Error("Not assigned to this item");
  }

  const completed = new Set(t.completedItems ?? []);
  completed.add(itemIndex);
  await updateTranscript(transcriptId, { completedItems: [...completed] });
}
