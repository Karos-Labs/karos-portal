import type { SocialPlatform } from "@/components/agent-identity";
import type { Client } from "@/lib/types";

/**
 * The onboarding conversation, as data (PROTOTYPE, 2026-09-26).
 *
 * It reads like a chat, but underneath it is a fixed list of steps and each
 * step fills one named field. A model may later phrase the questions and parse
 * free-text answers; it never decides what gets asked. That keeps the flow
 * predictable, cheap and testable, and lets every answer be saved the moment
 * it is given so a client can leave and come back.
 *
 * Owner rulings (2026-09-26): the personal profile is asked inside the chat as
 * an optional last question; handle discovery will use ScrappyCoco; the client
 * chooses the chat language, English by default.
 *
 * Pure: no React, no I/O. `simulateDiscovery` stands in for the real website
 * + ScrappyCoco scan until that is built.
 */

export type ChatLang = "en" | "he";

/** The networks the handles card asks about, in the order it lists them. */
export const HANDLE_PLATFORMS: SocialPlatform[] = ["instagram", "linkedin", "facebook", "x", "tiktok", "youtube"];

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
  goals: string[];
  audience: string;
  competitors: string[];
  voice: VoiceId | "";
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

export type StepKind =
  | "choice"
  | "text"
  | "url"
  | "handles"
  | "brand"
  | "multi"
  | "voice"
  | "profile"
  | "summary";

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

/**
 * What an existing client's record already answers. The chat still walks those
 * steps, but opens each one as "we have X, still right?" instead of a blank
 * question.
 */
export function seedFromClient(client: Pick<Client, "name" | "website" | "socialLinks" | "category" | "description" | "brandingGuidelines">): Partial<ChatAnswers> {
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
  };
}

/** "https://www.acme.co.il/about" → "acme". Empty when there is no usable host. */
export function brandSlug(website: string): string {
  const raw = website.trim();
  if (!raw) return "";
  let host = raw;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return "";
  }
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  return (labels[0] ?? "").replace(/[^a-z0-9_-]/g, "");
}

/** A loose "is this a website" check for the url step. */
export function looksLikeWebsite(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(v);
}

export interface Discovery {
  handles: Partial<Record<SocialPlatform, string | null>>;
  category: string;
  description: string;
  colors: string[];
  competitors: string[];
}

/**
 * PROTOTYPE STAND-IN for the real scan. The real one reads the site's
 * header/footer links for profile URLs first (the most reliable source), then
 * asks ScrappyCoco per missing platform, and takes logo, colours and category
 * from the existing branding pipeline. This one derives believable values from
 * the domain so the flow can be walked: TikTok is always "not found", so the
 * card's "we don't have one" and "add it" paths are always visible.
 */
export function simulateDiscovery(website: string, companyName: string): Discovery {
  const slug = brandSlug(website) || companyName.toLowerCase().replace(/[^a-z0-9]/g, "") || "yourbrand";
  const hue = [...slug].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return {
    handles: {
      instagram: `@${slug}`,
      linkedin: `linkedin.com/company/${slug}`,
      facebook: `facebook.com/${slug}`,
      x: `@${slug}`,
      tiktok: null,
      youtube: `@${slug}`,
    },
    category: "B2B software",
    description: `${companyName || slug} helps teams do more with less.`,
    colors: [hslHex(hue, 70, 50), hslHex((hue + 180) % 360, 30, 20), "#F5F5F4"],
    competitors: ["Northwind", "Contoso", "Globex"],
  };
}

function hslHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

export type VoiceId = "bold" | "warm" | "expert";

/** Three sample posts in three tones. The client picks one instead of describing a voice from a blank box. */
export function voiceSamples(companyName: string, lang: ChatLang): { id: VoiceId; label: string; post: string }[] {
  const n = companyName || (lang === "he" ? "החברה שלכם" : "your company");
  return lang === "he"
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
        : he
          ? "מצאתי את החשבונות האלה. אשר/י שהם שלכם, או תקן/י."
          : "I found these accounts. Confirm they're yours, or fix them.";
    case "brand":
      return he ? "וזה המותג כפי שקראתי אותו מהאתר. זה אתם?" : "And here's your brand as I read it from the site. Is this you?";
    case "goals":
      return he ? "מה הכי חשוב לכם שהשיווק ישיג? אפשר לבחור כמה." : "What should your marketing achieve? Pick as many as you like.";
    case "audience":
      return he ? "למי אתם מדברים? תאר/י את הקהל במשפט." : "Who are you talking to? Describe your audience in a sentence.";
    case "competitors":
      return he ? "אלה המתחרים שזיהיתי. תוריד/י או תוסיף/י." : "These look like your competitors. Remove or add any.";
    case "voice":
      return he ? "איזה מהפוסטים האלה נשמע הכי כמוכם?" : "Which of these posts sounds most like you?";
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

/** The steps before `id`, for a progress count. */
export function stepIndex(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id);
}

export function nextStep(id: StepId): StepId {
  const i = stepIndex(id);
  return STEPS[Math.min(i + 1, STEPS.length - 1)]!.id;
}

/** Does an existing client's record already answer this step? */
export function isPrefilled(id: StepId, seed: Partial<ChatAnswers>): boolean {
  switch (id) {
    case "company":
      return !!seed.companyName;
    case "website":
      return !!seed.website;
    case "handles":
      return !!seed.handles && Object.keys(seed.handles).length > 0;
    case "brand":
      return !!(seed.category || seed.description || seed.colors?.length);
    default:
      return false;
  }
}
