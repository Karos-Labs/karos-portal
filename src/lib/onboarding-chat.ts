import type { SocialPlatform } from "@/components/agent-identity";
import type { Client } from "@/lib/types";

/**
 * The onboarding conversation, as data (2026-09-26).
 *
 * It reads like a chat, but underneath it is a fixed list of steps and each
 * step fills one named field. Nothing decides at run time what gets asked. That
 * keeps the flow predictable, cheap and testable, and lets every answer be
 * saved the moment it is given so a client can leave and come back.
 *
 * Owner rulings (2026-09-26): the personal profile is asked inside the chat as
 * an optional last question; handle discovery uses ScrappyCoco; the client
 * chooses the chat language, English by default.
 *
 * Pure and client-safe: no React, no I/O. The website scan itself is
 * `src/lib/onboarding-discovery.ts` (server); this module owns only the shape
 * it returns (`Discovery`) and what the chat does with it.
 */

export type ChatLang = "en" | "he";

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
  category: string;
  description: string;
  colors: string[];
  logoUrl?: string | null;
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
  | "language"
  | "name"
  | "role"
  | "company"
  | "website"
  | "handles"
  | "brand"
  | "goals"
  | "audience"
  | "competitors"
  | "voice"
  | "contentLanguage"
  | "profile"
  | "done";

export type StepKind = "choice" | "text" | "url" | "handles" | "brand" | "multi" | "voice" | "profile" | "summary";

export interface StepDef {
  id: StepId;
  kind: StepKind;
}

/** The conversation, in order. Every client walks all of it; an existing client's steps open pre-filled. */
export const STEPS: StepDef[] = [
  { id: "language", kind: "choice" },
  { id: "name", kind: "text" },
  { id: "role", kind: "choice" },
  { id: "company", kind: "text" },
  { id: "website", kind: "url" },
  { id: "handles", kind: "handles" },
  { id: "brand", kind: "brand" },
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
    category: "",
    description: "",
    colors: [],
    goals: [],
    audience: "",
    competitors: [],
    voice: "",
    contentLanguages: [],
    profile: "",
  };
}

/** What an existing client's record answers; the chat opens those steps as "still right?". */
export type ChatSeed = Partial<ChatAnswers> & { brandVoice?: string };

export function seedFromClient(
  client: Pick<
    Client,
    "name" | "website" | "socialLinks" | "category" | "description" | "brandingGuidelines" | "logoUrl" | "brandVoice"
  >,
): ChatSeed {
  const handles: ChatAnswers["handles"] = {};
  for (const p of HANDLE_PLATFORMS) {
    const v = client.socialLinks?.[p as keyof NonNullable<Client["socialLinks"]>];
    if (typeof v === "string" && v.trim()) handles[p] = v.trim();
  }
  const colors = (client.brandingGuidelines?.dominantColors ?? []).map((c) => c.hex).filter(Boolean).slice(0, 4);
  return {
    ...(client.name ? { companyName: client.name } : {}),
    ...(client.website ? { website: client.website } : {}),
    ...(Object.keys(handles).length ? { handles } : {}),
    ...(client.category ? { category: client.category } : {}),
    ...(client.description ? { description: client.description } : {}),
    ...(colors.length ? { colors } : {}),
    ...(client.logoUrl ? { logoUrl: client.logoUrl } : {}),
    ...(client.brandVoice?.trim() ? { brandVoice: client.brandVoice.trim() } : {}),
  };
}

/** A loose "is this a website" check for the url step. */
export function looksLikeWebsite(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(v);
}

/** What the website scan found. Every field may come back empty; the chat then just asks. */
export interface Discovery {
  handles: Partial<Record<SocialPlatform, string | null>>;
  category: string;
  description: string;
  colors: string[];
  logoUrl: string | null;
  competitors: string[];
  /** Three sample posts about THIS company, in the chat language. Empty = the built-in examples. */
  voiceSamples: { id: VoiceId; post: string }[];
}

export function emptyDiscovery(): Discovery {
  return { handles: {}, category: "", description: "", colors: [], logoUrl: null, competitors: [], voiceSamples: [] };
}

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
  const n = companyName || (lang === "he" ? "החברה שלכם" : "your company");
  const fallback: { id: VoiceId; label: string; post: string }[] =
    lang === "he"
      ? [
          { id: "bold", label: "נועז", post: `רוב הצוותים מבזבזים חצי שבוע על עבודה ידנית. ב-${n} החלטנו שזה נגמר. הנה איך.` },
          { id: "warm", label: "חם", post: `כל לקוח שלנו התחיל באותה שאלה: "אפשר לעשות את זה פשוט יותר?" ב-${n} התשובה היא כן, ואנחנו כאן לאורך כל הדרך.` },
          { id: "expert", label: "מומחה", post: `ניתחנו 200 תהליכי עבודה בשנה האחרונה. שלושה דפוסים חוזרים בכל ארגון שמצליח, והנה מה ש-${n} למדה מהם.` },
        ]
      : [
          { id: "bold", label: "Bold", post: `Most teams lose half their week to busywork. At ${n}, we decided that ends now. Here's how.` },
          { id: "warm", label: "Warm", post: `Every customer we work with starts with the same question: "Can this be simpler?" At ${n}, the answer is yes, and we're with you the whole way.` },
          { id: "expert", label: "Expert", post: `We analysed 200 workflows last year. Three patterns show up in every team that wins, and here's what ${n} learned from them.` },
        ];
  return fallback.map((v) => ({ ...v, post: written.find((w) => w.id === v.id)?.post.trim() || v.post }));
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

/** The chips a choice/multi step offers. */
export function stepOptions(id: StepId, lang: ChatLang, answers: ChatAnswers): Option[] {
  const he = lang === "he";
  switch (id) {
    case "language":
      return [
        { value: "en", label: "English" },
        { value: "he", label: "עברית" },
      ];
    case "role":
      return he
        ? [
            { value: "Founder / CEO", label: "מייסד/ת או מנכ״ל/ית" },
            { value: "Marketing", label: "שיווק" },
            { value: "Sales", label: "מכירות" },
            { value: "Operations", label: "תפעול" },
          ]
        : [
            { value: "Founder / CEO", label: "Founder / CEO" },
            { value: "Marketing", label: "Marketing" },
            { value: "Sales", label: "Sales" },
            { value: "Operations", label: "Operations" },
          ];
    case "goals":
      return he
        ? [
            { value: "leads", label: "יותר לידים" },
            { value: "awareness", label: "מודעות למותג" },
            { value: "thought-leadership", label: "מובילות מחשבתית" },
            { value: "hiring", label: "גיוס" },
            { value: "community", label: "קהילה" },
            { value: "launch", label: "השקת מוצר" },
          ]
        : [
            { value: "leads", label: "More leads" },
            { value: "awareness", label: "Brand awareness" },
            { value: "thought-leadership", label: "Thought leadership" },
            { value: "hiring", label: "Hiring" },
            { value: "community", label: "Community" },
            { value: "launch", label: "Product launch" },
          ];
    case "competitors":
      return answers.competitors.map((c) => ({ value: c, label: c }));
    case "contentLanguage":
      return [
        { value: "en", label: he ? "אנגלית" : "English" },
        { value: "he", label: he ? "עברית" : "Hebrew" },
      ];
    default:
      return [];
  }
}

/** The English name of a goal, whatever language the chip was shown in. */
export function goalLabel(value: string): string {
  return stepOptions("goals", "en", emptyAnswers()).find((o) => o.value === value)?.label ?? value;
}

/** Quick-fill suggestions under a free-text step. */
export function textSuggestions(id: StepId, lang: ChatLang): string[] {
  if (id !== "audience") return [];
  return lang === "he"
    ? ["מנהלי שיווק בחברות B2B", "מייסדים של סטארטאפים", "לקוחות פרטיים בישראל"]
    : ["Marketing leads at B2B companies", "Startup founders", "Consumers in the US"];
}

/**
 * The bot's line for a step. `prefilled` = an existing client's record already
 * answers it, so the line is a verification, not a question.
 */
export function botLine(id: StepId, lang: ChatLang, a: ChatAnswers, prefilled: boolean): string {
  const he = lang === "he";
  const first = a.name.trim().split(/\s+/)[0] ?? "";
  switch (id) {
    case "language":
      return "Hi, I'm Karos. I'll set up your workspace in a few quick questions. Which language should we talk in?\n\nהיי, אני קארוס. באיזו שפה נדבר?";
    case "name":
      return he ? "מעולה. איך קוראים לך?" : "Great. What's your name?";
    case "role":
      return he ? `נעים מאוד${first ? `, ${first}` : ""}. מה התפקיד שלך?` : `Nice to meet you${first ? `, ${first}` : ""}. What's your role?`;
    case "company":
      return prefilled
        ? he
          ? `רשום אצלנו שהחברה היא **${a.companyName}**. נכון?`
          : `We have your company as **${a.companyName}**. Is that right?`
        : he
          ? "איך קוראים לחברה?"
          : "What's the company called?";
    case "website":
      return prefilled
        ? he
          ? `והאתר הוא **${a.website}**?`
          : `And your website is **${a.website}**?`
        : he
          ? "מה כתובת האתר? אחפש משם את החשבונות שלכם ברשתות ואת המותג."
          : "What's your website? I'll use it to find your social accounts and your brand.";
    case "handles":
      return prefilled
        ? he
          ? "אלה החשבונות שרשומים אצלנו. תקן/י מה שלא נכון."
          : "These are the accounts we have on file. Fix anything that's off."
        : Object.values(a.handles).some(Boolean)
          ? he
            ? "מצאתי את החשבונות האלה. אשר/י שהם שלכם, או תקן/י."
            : "I found these accounts. Confirm they're yours, or fix them."
          : he
            ? "לא מצאתי חשבונות ברשתות. אפשר להוסיף אותם כאן."
            : "I couldn't find your social accounts. You can add them here.";
    case "brand":
      return prefilled
        ? he
          ? "וזה המותג כפי שהוא רשום אצלנו. זה עדיין נכון?"
          : "And here's your brand as we have it. Still right?"
        : he
          ? "וזה המותג כפי שקראתי אותו מהאתר. זה אתם?"
          : "And here's your brand as I read it from the site. Is this you?";
    case "goals":
      return he ? "מה הכי חשוב לכם שהשיווק ישיג? אפשר לבחור כמה." : "What should your marketing achieve? Pick as many as you like.";
    case "audience":
      return he ? "למי אתם מדברים? תאר/י את הקהל במשפט." : "Who are you talking to? Describe your audience in a sentence.";
    case "competitors":
      return a.competitors.length
        ? he
          ? "אלה המתחרים שזיהיתי. תוריד/י או תוסיף/י."
          : "These look like your competitors. Remove or add any."
        : he
          ? "מי המתחרים העיקריים שלכם? אפשר גם לדלג."
          : "Who are your main competitors? You can skip this too.";
    case "voice":
      return prefilled
        ? he
          ? "יש לנו כבר טון מותג שמור. להשאיר אותו, או לבחור את הפוסט שנשמע הכי כמוכם?"
          : "We already have a brand voice on file. Keep it, or pick the post that sounds most like you?"
        : he
          ? "איזה מהפוסטים האלה נשמע הכי כמוכם?"
          : "Which of these posts sounds most like you?";
    case "contentLanguage":
      return he ? "באיזו שפה לכתוב את התוכן שלכם?" : "Which language should your content be written in?";
    case "profile":
      return he
        ? "שאלה אחרונה, רק בשבילך (לא חובה): תמונה, קורות חיים ו-LinkedIn אישי עוזרים לנו לכתוב בשמך."
        : "Last one, just for you (optional): a photo, your CV and your personal LinkedIn help us write in your voice.";
    case "done":
      return he ? "זהו, הכול מוכן. הנה הסיכום:" : "That's everything. Here's the summary:";
  }
}

export function stepIndex(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id);
}

export function nextStep(id: StepId): StepId {
  const i = stepIndex(id);
  return STEPS[Math.min(i + 1, STEPS.length - 1)]!.id;
}

/** Does an existing client's record already answer this step? */
export function isPrefilled(id: StepId, seed: ChatSeed): boolean {
  switch (id) {
    case "company":
      return !!seed.companyName;
    case "website":
      return !!seed.website;
    case "handles":
      return !!seed.handles && Object.keys(seed.handles).length > 0;
    case "brand":
      return !!(seed.category || seed.description || seed.colors?.length);
    case "voice":
      return !!seed.brandVoice;
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

function isLang(v: unknown): v is ChatLang {
  return v === "en" || v === "he";
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
    language: isLang(a.language) ? a.language : "en",
    name: str(a.name, 100).trim(),
    role: str(a.role, 100).trim(),
    companyName: str(a.companyName, 200).trim(),
    website: str(a.website, 500).trim(),
    handles,
    category: str(a.category, 200).trim(),
    description: str(a.description).trim(),
    colors: strList(a.colors, 6, 9).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c)),
    goals: strList(a.goals),
    audience: str(a.audience).trim(),
    competitors: strList(a.competitors),
    voice: typeof a.voice === "string" && VOICE_IDS.has(a.voice) ? (a.voice as VoiceId) : "",
    contentLanguages: strList(a.contentLanguages, 2).filter(isLang),
    profile: a.profile === "done" || a.profile === "skipped" ? a.profile : "",
    ...(a.keepVoice === true ? { keepVoice: true } : {}),
    ...(typeof a.logoUrl === "string" && /^https:\/\//.test(a.logoUrl) ? { logoUrl: a.logoUrl.slice(0, 1000) } : {}),
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
    a.contentLanguages.length > 0 &&
      `- Content language: ${a.contentLanguages.map((l) => (l === "he" ? "Hebrew" : "English")).join(" and ")}`,
  ].filter((l): l is string => typeof l === "string" && l !== "");
  return lines.length > 1 ? lines.join("\n") : "";
}
