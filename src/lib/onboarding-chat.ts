import type { SocialPlatform } from "@/components/agent-identity";
import type { Client } from "@/lib/types";
import { CHAT_LANGUAGES, OPENING_MESSAGE, isChatLang, languageName, tr, type ChatLang, type MsgKey } from "@/lib/onboarding-i18n";

export type { ChatLang } from "@/lib/onboarding-i18n";

/**
 * The onboarding conversation, as data (2026-09-26).
 *
 * It reads like a chat, but underneath it is a fixed list of steps and each
 * step fills one named field. Nothing decides at run time what gets asked. That
 * keeps the flow predictable, cheap and testable, and lets every answer be
 * saved the moment it is given so a client can leave and come back.
 *
 * Owner rulings (2026-09-26):
 *   - the language is a dropdown at the top (nine languages), not a question;
 *     the opening message is English only;
 *   - handles are found automatically for a NEW company and confirmed; an
 *     EXISTING client's accounts, logo and competitors come from the database
 *     to confirm or change, with no scan;
 *   - the logo is found automatically too, then approved, replaced or skipped;
 *   - the rest of the brand (palette, category, description) is NOT asked: the
 *     Intel Report and SEO/GEO research after Finish produce it;
 *   - the personal profile is an optional last question.
 *
 * Pure and client-safe: no React, no I/O. Words live in lib/onboarding-i18n.ts;
 * the website scan is lib/onboarding-discovery.ts (server).
 */

/** The networks the handles card asks about, in the order it lists them. */
export const HANDLE_PLATFORMS: SocialPlatform[] = ["instagram", "linkedin", "facebook", "x", "tiktok", "youtube"];

export type VoiceId = "bold" | "warm" | "expert";

export interface ChatAnswers {
  language: ChatLang;
  name: string;
  role: string;
  companyName: string;
  website: string;
  /** A handle, or null for "we don't have one". Absent = not asked yet. */
  handles: Partial<Record<SocialPlatform, string | null>>;
  /** The logo on screen at the logo step: the scan's, an upload, or the one on file. */
  logoUrl?: string;
  /**
   * What the client did with it. "scan" = approved the found logo (stored at
   * Finish); "upload" = uploaded their own (already stored by the upload);
   * "kept" = kept the one on file; "skipped" = none for now.
   */
  logoSource?: "scan" | "upload" | "kept" | "skipped";
  goals: string[];
  audience: string;
  competitors: string[];
  voice: VoiceId | "";
  /** An existing client kept the brand voice already on file. */
  keepVoice?: boolean;
  contentLanguages: ChatLang[];
  /** The optional personal step was answered (done or skipped). */
  profile: "done" | "skipped" | "";
}

export type StepId =
  | "name"
  | "role"
  | "company"
  | "website"
  | "handles"
  | "logo"
  | "goals"
  | "audience"
  | "competitors"
  | "voice"
  | "contentLanguage"
  | "profile"
  | "done";

export type StepKind = "choice" | "text" | "url" | "handles" | "logo" | "multi" | "voice" | "profile" | "summary";

export interface StepDef {
  id: StepId;
  kind: StepKind;
}

/** The conversation, in order. The opening message asks the first one. */
export const STEPS: StepDef[] = [
  { id: "name", kind: "text" },
  { id: "role", kind: "choice" },
  { id: "company", kind: "text" },
  { id: "website", kind: "url" },
  { id: "handles", kind: "handles" },
  { id: "logo", kind: "logo" },
  { id: "goals", kind: "multi" },
  { id: "audience", kind: "text" },
  { id: "competitors", kind: "multi" },
  { id: "voice", kind: "voice" },
  { id: "contentLanguage", kind: "multi" },
  { id: "profile", kind: "profile" },
  { id: "done", kind: "summary" },
];

export function emptyAnswers(): ChatAnswers {
  return {
    language: "en",
    name: "",
    role: "",
    companyName: "",
    website: "",
    handles: {},
    goals: [],
    audience: "",
    competitors: [],
    voice: "",
    contentLanguages: [],
    profile: "",
  };
}

/**
 * What the client's record already answers. `existing` = this workspace was
 * set up before (a website, accounts or a logo on file): the chat then
 * confirms what is stored instead of scanning the website for it.
 */
export type ChatSeed = Partial<ChatAnswers> & { brandVoice?: string; existing?: boolean };

export function seedFromClient(
  client: Pick<Client, "name" | "website" | "socialLinks" | "brandVoice" | "logoUrl">,
  competitors: readonly string[] = [],
): ChatSeed {
  const handles: ChatAnswers["handles"] = {};
  for (const p of HANDLE_PLATFORMS) {
    const v = client.socialLinks?.[p as keyof NonNullable<Client["socialLinks"]>];
    if (typeof v === "string" && v.trim()) handles[p] = v.trim();
  }
  const hasHandles = Object.keys(handles).length > 0;
  const existing = Boolean(client.website?.trim() || hasHandles || client.logoUrl);
  const names = competitors.map((c) => c.trim()).filter(Boolean).slice(0, 8);
  return {
    ...(client.name ? { companyName: client.name } : {}),
    ...(client.website ? { website: client.website } : {}),
    ...(hasHandles ? { handles } : {}),
    ...(client.brandVoice?.trim() ? { brandVoice: client.brandVoice.trim() } : {}),
    ...(client.logoUrl ? { logoUrl: client.logoUrl } : {}),
    ...(names.length ? { competitors: names } : {}),
    ...(existing ? { existing: true } : {}),
  };
}

/** A loose "is this a website" check for the url step. */
export function looksLikeWebsite(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(v);
}

/**
 * What the website scan found. Every field may come back empty; the chat then
 * just asks. Accounts, logo, competitors and sample posts only: the rest of
 * the brand is the research's job after Finish, and appears in the client's
 * workspace when it is ready.
 */
export interface Discovery {
  handles: Partial<Record<SocialPlatform, string | null>>;
  logoUrl: string | null;
  competitors: string[];
  /** Three sample posts about THIS company, in the chat language. Empty = the built-in examples. */
  voiceSamples: { id: VoiceId; post: string }[];
}

export function emptyDiscovery(): Discovery {
  return { handles: {}, logoUrl: null, competitors: [], voiceSamples: [] };
}

const VOICE_KEYS: Record<VoiceId, { label: MsgKey; post: MsgKey }> = {
  bold: { label: "voiceBold", post: "voicePostBold" },
  warm: { label: "voiceWarm", post: "voicePostWarm" },
  expert: { label: "voiceExpert", post: "voicePostExpert" },
};

/**
 * Three sample posts in three tones. The client picks one instead of describing
 * a voice from a blank box. `written` = the scan's posts about this company;
 * the built-in ones fill any tone it could not write.
 */
export function voiceSamples(
  companyName: string,
  lang: ChatLang,
  written: readonly { id: VoiceId; post: string }[] = [],
): { id: VoiceId; label: string; post: string }[] {
  const company = companyName || tr(lang, "yourCompany");
  return (Object.keys(VOICE_KEYS) as VoiceId[]).map((id) => ({
    id,
    label: tr(lang, VOICE_KEYS[id].label),
    post: written.find((w) => w.id === id)?.post.trim() || tr(lang, VOICE_KEYS[id].post, { company }),
  }));
}

/** How each tone is described to the writing agents once a client picks it. */
const VOICE_BRIEF: Record<VoiceId, string> = {
  bold: "Bold and direct. Short, confident sentences that name the problem and take a clear position. Energetic, a little provocative, never hedging.",
  warm: "Warm and human. Speaks to the reader as a partner, leads with empathy and the customer's own words. Reassuring and plain-spoken.",
  expert: "Expert and evidence-led. Leads with data, specific findings and concrete detail. Calm, precise and authoritative, no hype.",
};

/**
 * The brand voice a picked sample stores (`client.brandVoice`): the tone brief
 * plus the post the client actually chose, so the agents get the rule AND an
 * example of it.
 */
export function brandVoiceFromSample(id: VoiceId, post: string): string {
  return `${VOICE_BRIEF[id]}\n\nExample post the client chose as sounding like them:\n"${post.trim()}"`;
}

export interface Option {
  value: string;
  label: string;
}

const ROLES: [string, MsgKey][] = [
  ["Founder / CEO", "roleFounder"],
  ["Marketing", "roleMarketing"],
  ["Sales", "roleSales"],
  ["Operations", "roleOperations"],
];

const GOALS: [string, MsgKey][] = [
  ["leads", "goalLeads"],
  ["awareness", "goalAwareness"],
  ["thought-leadership", "goalThoughtLeadership"],
  ["hiring", "goalHiring"],
  ["community", "goalCommunity"],
  ["launch", "goalLaunch"],
];

/** The chips a choice/multi step offers. Values are stable English ids; labels are in `lang`. */
export function stepOptions(id: StepId, lang: ChatLang, answers: ChatAnswers): Option[] {
  switch (id) {
    case "role":
      return ROLES.map(([value, key]) => ({ value, label: tr(lang, key) }));
    case "goals":
      return GOALS.map(([value, key]) => ({ value, label: tr(lang, key) }));
    case "competitors":
      return answers.competitors.map((c) => ({ value: c, label: c }));
    case "contentLanguage":
      return CHAT_LANGUAGES.map((l) => ({ value: l.code, label: l.label }));
    default:
      return [];
  }
}

/** The English name of a goal, for the research brief. */
export function goalLabel(value: string): string {
  return stepOptions("goals", "en", emptyAnswers()).find((o) => o.value === value)?.label ?? value;
}

/** Quick-fill suggestions under a free-text step. */
export function textSuggestions(id: StepId, lang: ChatLang): string[] {
  if (id !== "audience") return [];
  return (["audienceSuggestion1", "audienceSuggestion2", "audienceSuggestion3"] as const).map((k) => tr(lang, k));
}

/**
 * The bot's line for a step.
 *   prefilled: the client's record already answers THIS step (a verification);
 *   existing:  the workspace was set up before (no scan ran; say "on file").
 */
export function botLine(id: StepId, lang: ChatLang, a: ChatAnswers, ctx: { prefilled: boolean; existing: boolean }): string {
  const first = a.name.trim().split(/\s+/)[0] ?? "";
  switch (id) {
    case "name":
      // The opening message asks it, in English whatever the dropdown says.
      return OPENING_MESSAGE;
    case "role":
      return first ? tr(lang, "askRoleNamed", { name: first }) : tr(lang, "askRole");
    case "company":
      return ctx.prefilled ? tr(lang, "verifyCompany", { company: a.companyName }) : tr(lang, "askCompany");
    case "website":
      return ctx.prefilled ? tr(lang, "verifyWebsite", { website: a.website }) : tr(lang, "askWebsite");
    case "handles": {
      const any = Object.values(a.handles).some(Boolean);
      if (ctx.existing) return tr(lang, any ? "handlesOnFile" : "handlesNoneOnFile");
      return tr(lang, any ? "handlesFound" : "handlesNone");
    }
    case "logo":
      if (ctx.prefilled) return tr(lang, "logoOnFile");
      if (a.logoUrl) return tr(lang, "logoFound");
      return tr(lang, ctx.existing ? "logoNoneOnFile" : "logoNone");
    case "goals":
      return tr(lang, "askGoals");
    case "audience":
      return tr(lang, "askAudience");
    case "competitors":
      if (!a.competitors.length) return tr(lang, "competitorsNone");
      return tr(lang, ctx.existing ? "competitorsOnFile" : "competitorsFound");
    case "voice":
      return tr(lang, ctx.prefilled ? "verifyVoice" : "askVoice");
    case "contentLanguage":
      return tr(lang, "askContentLanguage");
    case "profile":
      return tr(lang, "askProfile");
    case "done":
      return tr(lang, "done", { company: a.companyName || tr(lang, "yourCompany") });
  }
}

export function stepIndex(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id);
}

export function nextStep(id: StepId): StepId {
  const i = stepIndex(id);
  return STEPS[Math.min(i + 1, STEPS.length - 1)]!.id;
}

/** Does the client's record already answer this step? */
export function isPrefilled(id: StepId, seed: ChatSeed): boolean {
  switch (id) {
    case "company":
      return !!seed.companyName;
    case "website":
      return !!seed.website;
    case "handles":
      return !!seed.existing;
    case "voice":
      return !!seed.brandVoice;
    case "logo":
      return !!seed.logoUrl;
    default:
      return false;
  }
}

/* ── Draft: the conversation, saved as it goes ────────────────────────── */

export interface ChatMessage {
  id: number;
  from: "bot" | "user";
  text: string;
}

/**
 * Saved after every answer (on the user's record), so a client who leaves, or
 * goes to LinkedIn and back, returns to the same place in the conversation.
 */
export interface ChatDraft {
  step: StepId;
  answers: ChatAnswers;
  messages: ChatMessage[];
  voiceSamples: { id: VoiceId; post: string }[];
}

const MAX_TEXT = 2000;
const MAX_MESSAGES = 80;
const STEP_IDS = new Set<string>(STEPS.map((s) => s.id));
const VOICE_IDS = new Set<string>(["bold", "warm", "expert"]);

function str(v: unknown, max = MAX_TEXT): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function strList(v: unknown, maxItems = 12, max = 200): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .slice(0, maxItems)
        .map((x) => x.trim().slice(0, max))
    : [];
}

/**
 * Chat answers received from the browser, reduced to the shape above with
 * every string bounded. Anything unrecognisable is dropped rather than trusted.
 */
export function sanitizeChatAnswers(raw: unknown): ChatAnswers {
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const handles: ChatAnswers["handles"] = {};
  const rawHandles = (typeof a.handles === "object" && a.handles !== null ? a.handles : {}) as Record<string, unknown>;
  for (const p of HANDLE_PLATFORMS) {
    const v = rawHandles[p];
    if (v === null) handles[p] = null;
    else if (typeof v === "string" && v.trim()) handles[p] = v.trim().slice(0, 200);
  }
  return {
    ...emptyAnswers(),
    language: isChatLang(a.language) ? a.language : "en",
    name: str(a.name, 100).trim(),
    role: str(a.role, 100).trim(),
    companyName: str(a.companyName, 200).trim(),
    website: str(a.website, 500).trim(),
    handles,
    goals: strList(a.goals),
    audience: str(a.audience).trim(),
    competitors: strList(a.competitors),
    voice: typeof a.voice === "string" && VOICE_IDS.has(a.voice) ? (a.voice as VoiceId) : "",
    contentLanguages: strList(a.contentLanguages, CHAT_LANGUAGES.length).filter(isChatLang),
    profile: a.profile === "done" || a.profile === "skipped" ? a.profile : "",
    ...(a.keepVoice === true ? { keepVoice: true } : {}),
    ...(typeof a.logoUrl === "string" && /^https:\/\//.test(a.logoUrl) ? { logoUrl: a.logoUrl.slice(0, 1000) } : {}),
    ...(a.logoSource === "scan" || a.logoSource === "upload" || a.logoSource === "kept" || a.logoSource === "skipped"
      ? { logoSource: a.logoSource }
      : {}),
  };
}

function sanitizeVoiceSamples(raw: unknown): { id: VoiceId; post: string }[] {
  return (Array.isArray(raw) ? raw : []).flatMap((v) => {
    if (typeof v !== "object" || v === null) return [];
    const vv = v as Record<string, unknown>;
    const post = str(vv.post, 800).trim();
    return typeof vv.id === "string" && VOICE_IDS.has(vv.id) && post ? [{ id: vv.id as VoiceId, post }] : [];
  });
}

/** A draft read back from storage or received from the browser, or null when it is not one. */
export function sanitizeChatDraft(raw: unknown): ChatDraft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.step !== "string" || !STEP_IDS.has(r.step)) return null;
  const messages: ChatMessage[] = (Array.isArray(r.messages) ? r.messages : []).slice(-MAX_MESSAGES).flatMap((m, i) => {
    if (typeof m !== "object" || m === null) return [];
    const mm = m as Record<string, unknown>;
    if (mm.from !== "bot" && mm.from !== "user") return [];
    return [{ id: i, from: mm.from, text: str(mm.text) }];
  });
  return {
    step: r.step as StepId,
    answers: sanitizeChatAnswers(r.answers),
    messages,
    voiceSamples: sanitizeVoiceSamples(r.voiceSamples),
  };
}

/**
 * The run-specific brief the post-onboarding Intel Report receives
 * (`customPrompt`): the answers the chat collected that have no field of
 * their own on the client record, so the first research is aimed at what the
 * client said they want rather than at a guess.
 */
export function intelBriefFromAnswers(a: ChatAnswers): string {
  const lines = [
    "Onboarding answers from the client (use them to focus the research):",
    a.role && `- Person onboarding: ${a.name || "unnamed"}, ${a.role}`,
    a.goals.length > 0 && `- Marketing goals: ${a.goals.map(goalLabel).join(", ")}`,
    a.audience && `- Target audience, in their words: ${a.audience}`,
    a.competitors.length > 0 && `- Competitors they named or confirmed: ${a.competitors.join(", ")}`,
    a.contentLanguages.length > 0 && `- Content language: ${a.contentLanguages.map(languageName).join(" and ")}`,
  ].filter((l): l is string => typeof l === "string" && l !== "");
  return lines.length > 1 ? lines.join("\n") : "";
}
