"use server";

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
  upsertSystemAgent,
  upsertClientContextDoc,
  getClientContextDoc,
  getTranscriptByExternalId,
} from "@/lib/data";
import { parseMarkdownReport, buildClientReport } from "@/lib/report-parser";
import type { BrandingGuidelines, ClientCompetitor } from "@/lib/types";
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
import type { Agent, AppUser, Client, Role, Transcript } from "@/lib/types";

async function requireStaff(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "admin" && user.role !== "employee") throw new Error("Forbidden");
  return user;
}

async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") throw new Error("Forbidden");
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
    createdAt: Date.now(),
    createdBy: user.uid,
  });
  revalidatePath("/clients");
  return { id };
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
  // Clients may only act on their own assets.
  if (user.role === "client" && asset.clientId !== user.clientId) throw new Error("Forbidden");
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

  // Clients may toggle items on their own client's transcripts; staff can toggle any
  if (user.role === "client") {
    if (!user.clientId || t.clientId !== user.clientId) throw new Error("Forbidden");
  } else if (user.role !== "admin" && user.role !== "employee") {
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
    clientId: input.role === "client" ? input.clientId ?? null : null,
    assignedClientIds: input.role === "employee" ? input.assignedClientIds ?? [] : [],
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

  if (input.role === "client") {
    let clientId = input.clientId ?? null;
    const newName = input.newClientName?.trim();
    if (newName) {
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
        createdAt: Date.now(),
        createdBy: admin.uid,
      });
    }
    if (!clientId) throw new Error("Pick a client or create a new one for this person.");
    patch.clientId = clientId;
  } else if (input.role === "employee") {
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

  if (user.role === "admin") {
    await upsertUser({ ...target, isGroupAdmin });
  } else if (user.role === "client" && user.isGroupAdmin) {
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
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "admin" && user.role !== "employee") throw new Error("Forbidden");

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

  revalidatePath(`/clients/${clientId}`);
}

/* ── Context-doc helpers ─────────────────────────────────────────────── */

function brandingToContextDocContent(g: BrandingGuidelines, clientName: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Branding Guidelines — ${clientName}`,
    `_Last updated: ${today}_`,
    "",
  ];
  if (g.primaryColor || g.secondaryColor) {
    lines.push("## Color Palette");
    if (g.primaryColor) lines.push(`- **Primary:** ${g.primaryColor}`);
    if (g.secondaryColor) lines.push(`- **Secondary/Accent:** ${g.secondaryColor}`);
    lines.push("");
  }
  if (g.fontHeading || g.fontBody) {
    lines.push("## Typography");
    if (g.fontHeading) lines.push(`- **Heading font:** ${g.fontHeading}`);
    if (g.fontBody) lines.push(`- **Body font:** ${g.fontBody}`);
    lines.push("");
  }
  if (g.toneKeywords?.length) {
    lines.push("## Tone & Voice");
    lines.push(`Keywords: ${g.toneKeywords.join(", ")}`);
    lines.push("");
  }
  if (g.guidelines) {
    lines.push("## Brand Guidelines");
    lines.push(g.guidelines);
    lines.push("");
  }
  return lines.join("\n");
}

/** Build the auto-synced block that gets injected into the brand-voice context doc. */
function buildBrandVoiceSection(g: BrandingGuidelines): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "<!-- BRAND_SYNC_START -->",
    `## Visual & Tone Reference (auto-synced from guidelines · ${today})`,
  ];
  if (g.primaryColor) lines.push(`- **Primary Color:** ${g.primaryColor}`);
  if (g.secondaryColor) lines.push(`- **Secondary Color:** ${g.secondaryColor}`);
  if (g.fontHeading) lines.push(`- **Heading Font:** ${g.fontHeading}`);
  if (g.fontBody) lines.push(`- **Body Font:** ${g.fontBody}`);
  if (g.toneKeywords?.length) lines.push(`- **Tone Keywords:** ${g.toneKeywords.join(", ")}`);
  lines.push(
    "",
    "_This section is auto-synced when branding guidelines are updated. Edit the guidelines UI to change it._",
    "<!-- BRAND_SYNC_END -->",
  );
  return lines.join("\n");
}

/**
 * Insert or replace the BRAND_SYNC block in an existing brand-voice doc.
 * If markers exist, replace the block between them.
 * If not, inject after the YAML frontmatter (or prepend if no frontmatter).
 */
function injectBrandVoiceSection(content: string, section: string): string {
  const START = "<!-- BRAND_SYNC_START -->";
  const END = "<!-- BRAND_SYNC_END -->";
  const startIdx = content.indexOf(START);
  const endIdx = content.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1) {
    return content.slice(0, startIdx) + section + content.slice(endIdx + END.length);
  }
  // No markers yet — inject right after the frontmatter if present
  const fmMatch = content.match(/^---[\s\S]*?---\n/);
  if (fmMatch) {
    const offset = fmMatch[0].length;
    return content.slice(0, offset) + "\n" + section + "\n\n" + content.slice(offset);
  }
  return section + "\n\n" + content;
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
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "admin" && user.role !== "employee") throw new Error("Forbidden");

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
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "admin" && user.role !== "employee") throw new Error("Forbidden");

  await deleteClientCompetitor(id);
  revalidatePath("/clients");
}

/** Save or update branding guidelines for a client. Single source of truth:
 *  writes the structured client field AND keeps both context docs in sync so
 *  AI agents never see stale or conflicting branding data.
 */
export async function saveBrandingGuidelinesAction(
  clientId: string,
  guidelines: Omit<BrandingGuidelines, "updatedAt">,
): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "admin" && user.role !== "employee") throw new Error("Forbidden");

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

  revalidatePath(`/clients/${clientId}`);
}

/* ── Branding presets ─────────────────────────────────────────────────
   Three distinct brand archetypes used as fallback when no website URL
   is available or when scraping yields no usable tokens.              */
const BRANDING_PRESETS: Array<Omit<BrandingGuidelines, "updatedAt">> = [
  {
    primaryColor: "#1E293B",
    secondaryColor: "#6366F1",
    fontHeading: "Inter",
    fontBody: "Inter",
    toneKeywords: ["Innovative", "Precise", "Scalable", "Data-driven"],
    guidelines:
      "## Brand Voice\nDirect and confident. Communicate with precision and remove all fluff.\n\n## Visual Identity\nClean layouts, generous whitespace, and indigo accents to signal interactivity and trust.\n\n## Do's and Don'ts\n- Do: Lead with data and specifics\n- Don't: Use buzzwords or vague claims",
  },
  {
    primaryColor: "#292524",
    secondaryColor: "#D97706",
    fontHeading: "Playfair Display",
    fontBody: "Georgia",
    toneKeywords: ["Authentic", "Sustainable", "Human", "Crafted"],
    guidelines:
      "## Brand Voice\nWarm and personal. Speak to people, not customers. Stories over statistics.\n\n## Visual Identity\nOrganic textures, amber accents, and serif typography that convey warmth and craftsmanship.\n\n## Do's and Don'ts\n- Do: Tell the story behind the product\n- Don't: Use corporate or overly technical jargon",
  },
  {
    primaryColor: "#09090B",
    secondaryColor: "#10B981",
    fontHeading: "Montserrat",
    fontBody: "Open Sans",
    toneKeywords: ["Bold", "Trustworthy", "Challenger", "Performance"],
    guidelines:
      "## Brand Voice\nAssertive and results-oriented. Challenge the status quo with data-backed confidence.\n\n## Visual Identity\nHigh contrast, emerald green for key actions, geometric sans-serif for authority and clarity.\n\n## Do's and Don'ts\n- Do: Use strong, active verbs and concrete metrics\n- Don't: Hedge or soften claims unnecessarily",
  },
];

/* ── Color scraping utilities ────────────────────────────────────────── */

/** Expand 3-digit hex to 6-digit, strip alpha from 8-digit. Returns null if invalid. */
function normalizeHex(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (/^#[0-9a-f]{6}$/.test(h)) return h;
  if (/^#[0-9a-f]{8}$/.test(h)) return h.slice(0, 7); // drop alpha
  return null;
}

/**
 * Reject near-black, near-white, and neutral grays — none of these are
 * meaningful brand colors when extracted via frequency analysis.
 */
function isUsableColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  return luminance > 12 && luminance < 235 && saturation > 25;
}

/**
 * Extract hex colors and font families from a website's live HTML.
 *
 * Signal priority (colors):
 *   1. <meta name="theme-color"> — explicit, authoritative
 *   2. CSS custom properties matching brand/primary/accent/main/hero/key
 *   3. Frequency-ranked hex values from <style> blocks (grays/neutrals filtered)
 *
 * Signal priority (fonts):
 *   1. Google Fonts in <link> tags or @import rules
 *   2. @font-face family declarations in <style> blocks
 */
async function scrapeWebsiteBranding(
  url: string,
): Promise<Omit<BrandingGuidelines, "updatedAt"> | null> {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(normalized, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KarosCMO/1.0; +https://karoslabs.com)" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // 1. <meta name="theme-color"> — most reliable explicit brand color
    const themeColor =
      normalizeHex(
        html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,8})["']/i)?.[1] ??
        html.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{3,8})["'][^>]+name=["']theme-color["']/i)?.[1] ??
        "",
      ) ?? undefined;

    // 2. Collect all inline <style> block content for further parsing
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
      .map((m) => m[1])
      .join("\n");

    // 3. CSS custom property colors — patterns like --primary: #xxx, --brand-color: #xxx
    const cssVarPattern =
      /--(?:[\w-]*(?:primary|brand|accent|main|key|hero|highlight|theme)[\w-]*):\s*(#[0-9a-fA-F]{3,8})/gi;
    const cssVarColors: string[] = [];
    let m: RegExpExecArray | null;
    const cssVarPatternCopy = new RegExp(cssVarPattern.source, cssVarPattern.flags);
    while ((m = cssVarPatternCopy.exec(styleBlocks)) !== null) {
      const hex = normalizeHex(m[1]);
      if (hex && isUsableColor(hex) && !cssVarColors.includes(hex)) cssVarColors.push(hex);
    }

    // 4. Frequency-rank hex colors found in <style> blocks (fallback)
    const freqMap = new Map<string, number>();
    const hexScan = /#([0-9a-fA-F]{3,8})\b/g;
    while ((m = hexScan.exec(styleBlocks)) !== null) {
      const hex = normalizeHex("#" + m[1]);
      if (hex && isUsableColor(hex)) freqMap.set(hex, (freqMap.get(hex) ?? 0) + 1);
    }
    const freqColors = [...freqMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c)
      .filter((c) => !cssVarColors.includes(c)); // avoid dupes with CSS-var list

    // 5. Google Fonts from <link href> tags and @import inside <style> blocks
    const gfMatches = [
      ...html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&;>\s]+)/gi),
      ...styleBlocks.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&;)\s]+)/gi),
    ];
    const googleFonts = gfMatches
      .flatMap((match) =>
        decodeURIComponent(match[1])
          .split("|")
          .map((f) => f.split(":")[0].replace(/\+/g, " ").trim()),
      )
      .filter((f, i, a) => f && a.indexOf(f) === i);

    // 6. @font-face family names from inline <style> blocks
    const fontFacePattern = /@font-face\s*\{[^}]*font-family:\s*['"]?([^;'"}{]+)/gi;
    const localFonts: string[] = [];
    while ((m = fontFacePattern.exec(styleBlocks)) !== null) {
      const family = m[1].trim().replace(/^['"]|['"]$/g, "");
      if (family && !localFonts.includes(family)) localFonts.push(family);
    }

    // 7. Assemble results — prefer explicit signals over frequency analysis
    const colorPool = [themeColor, ...cssVarColors, ...freqColors].filter(Boolean) as string[];
    const primaryColor = colorPool[0];
    const secondaryColor = colorPool.find((c) => c !== primaryColor);
    const allFonts = [...googleFonts, ...localFonts];

    if (!primaryColor && allFonts.length === 0) return null;

    return {
      primaryColor: primaryColor ?? undefined,
      secondaryColor: secondaryColor ?? undefined,
      fontHeading: allFonts[0] ?? undefined,
      fontBody: (allFonts[1] ?? allFonts[0]) ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Auto-generate branding guidelines for a client.
 * Step A: scrape the client's website for colors + fonts.
 * Step B: if no website or scraping yields nothing, apply one of three preset archetypes.
 * Step C: sync both the branding-guidelines and brand-voice context docs so agents
 *         immediately see the new values without a full pipeline re-run.
 */
export async function generateBrandingAction(clientId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "admin" && user.role !== "employee") throw new Error("Forbidden");

  const client = await getClient(clientId);
  if (!client) throw new Error("Client not found");

  let scraped: Omit<BrandingGuidelines, "updatedAt"> | null = null;
  if (client.website) scraped = await scrapeWebsiteBranding(client.website);

  const generated = scraped ?? BRANDING_PRESETS[Math.floor(Math.random() * BRANDING_PRESETS.length)];
  const fullGuidelines: BrandingGuidelines = { ...generated, updatedAt: Date.now() };
  const now = Date.now();

  // Fetch existing context docs in parallel with the client write
  const [, brandingDoc, voiceDoc] = await Promise.all([
    updateClient(clientId, { brandingGuidelines: fullGuidelines }),
    getClientContextDoc(clientId, "branding-guidelines"),
    getClientContextDoc(clientId, "brand-voice"),
  ]);

  // Sync both context docs so agents immediately see the new values
  await Promise.allSettled([
    upsertClientContextDoc({
      clientId,
      docType: "branding-guidelines",
      tier: brandingDoc?.tier ?? "internal",
      content: brandingToContextDocContent(fullGuidelines, client.name),
      version: (brandingDoc?.version ?? 0) + 1,
      sources: brandingDoc?.sources,
      createdAt: brandingDoc?.createdAt ?? now,
      updatedAt: now,
    }),
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

  revalidatePath(`/clients/${clientId}`);
}

/**
 * One-time retroactive backfill: scrape every client's website and sync branding
 * data + context docs for the full client list. Admin-only.
 *
 * For each client:
 *   - Attempts live website scraping; falls back to a preset if scraping fails.
 *   - Merges with existing data: colours/fonts are overwritten with scraped values;
 *     tone keywords, guidelines text, and logoUrl from prior manual edits are preserved.
 *   - Writes both the client record and both context docs atomically.
 */
export async function backfillBrandingForAllClientsAction(): Promise<{
  total: number;
  scraped: number;
  preset: number;
  failed: number;
  results: Array<{ clientId: string; name: string; status: "scraped" | "preset" | "failed"; primaryColor?: string }>;
}> {
  await requireAdmin();

  const clients = await listClients();
  const results: Array<{
    clientId: string;
    name: string;
    status: "scraped" | "preset" | "failed";
    primaryColor?: string;
  }> = [];

  for (const client of clients) {
    try {
      let scraped: Omit<BrandingGuidelines, "updatedAt"> | null = null;
      if (client.website) scraped = await scrapeWebsiteBranding(client.website);

      const generated = scraped ?? BRANDING_PRESETS[Math.floor(Math.random() * BRANDING_PRESETS.length)];
      const status: "scraped" | "preset" = scraped ? "scraped" : "preset";

      // Preserve manually curated fields; overwrite colours/fonts with scraped data
      const existing = client.brandingGuidelines;
      const merged: Omit<BrandingGuidelines, "updatedAt"> = {
        ...generated,
        toneKeywords: existing?.toneKeywords?.length ? existing.toneKeywords : generated.toneKeywords,
        guidelines: existing?.guidelines ?? generated.guidelines,
        logoUrl: existing?.logoUrl ?? generated.logoUrl,
      };

      const fullGuidelines: BrandingGuidelines = { ...merged, updatedAt: Date.now() };
      const now = Date.now();

      const [brandingDoc, voiceDoc] = await Promise.all([
        getClientContextDoc(client.id, "branding-guidelines"),
        getClientContextDoc(client.id, "brand-voice"),
      ]);

      await Promise.all([
        updateClient(client.id, { brandingGuidelines: fullGuidelines }),
        upsertClientContextDoc({
          clientId: client.id,
          docType: "branding-guidelines",
          tier: brandingDoc?.tier ?? "internal",
          content: brandingToContextDocContent(fullGuidelines, client.name),
          version: (brandingDoc?.version ?? 0) + 1,
          sources: brandingDoc?.sources,
          createdAt: brandingDoc?.createdAt ?? now,
          updatedAt: now,
        }),
        voiceDoc
          ? upsertClientContextDoc({
              clientId: client.id,
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

      results.push({ clientId: client.id, name: client.name, status, primaryColor: fullGuidelines.primaryColor });
    } catch (err) {
      console.error(`[backfill] Failed for ${client.name} (${client.id}):`, err);
      results.push({ clientId: client.id, name: client.name, status: "failed" });
    }
  }

  revalidatePath("/clients");

  return {
    total: clients.length,
    scraped: results.filter((r) => r.status === "scraped").length,
    preset: results.filter((r) => r.status === "preset").length,
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
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "admin" && user.role !== "employee") throw new Error("Forbidden");

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
  const { INTEL_AGENT_ID } = await import("@/lib/intel-report");
  const existing = await getAgent(INTEL_AGENT_ID);
  if (!existing) await seedIntelAgentAction();
  const { runIntelReportPipeline } = await import("@/lib/intel-report");
  await runIntelReportPipeline(clientId);
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
  const { listClientContextDocs, replaceClientContextDocs } = await import("@/lib/data");
  const { INTEL_AGENT_ID } = await import("@/lib/intel-report");
  const { getSystemAgent, getClient } = await import("@/lib/data");

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
