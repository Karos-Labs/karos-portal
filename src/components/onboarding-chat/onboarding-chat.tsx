"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Input, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { SocialPlatformMark } from "@/components/agent-identity";
import { cn } from "@/lib/utils";
import {
  HANDLE_PLATFORMS,
  STEPS,
  botLine,
  emptyAnswers,
  isPrefilled,
  looksLikeWebsite,
  nextStep,
  simulateDiscovery,
  stepIndex,
  stepOptions,
  textSuggestions,
  voiceSamples,
  type ChatAnswers,
  type ChatLang,
  type StepId,
} from "./script";

/** Step 1 of the redesigned onboarding: the conversation (PROTOTYPE, simulation only). */

interface Message {
  id: number;
  from: "bot" | "user";
  text: string;
}

const TYPING_MS = 550;
const DISCOVERY_MS = 1800;

const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  x: "X",
  tiktok: "TikTok",
  youtube: "YouTube",
};

export function OnboardingChat({
  seed,
  onComplete,
  onLanguageChange,
}: {
  /** What an existing client's record already answers; empty for a new company. */
  seed: Partial<ChatAnswers>;
  onComplete: (answers: ChatAnswers) => void;
  /** The wizard bar above speaks the chat's language too. */
  onLanguageChange?: (lang: ChatLang) => void;
}) {
  const [answers, setAnswers] = useState<ChatAnswers>(() => ({ ...emptyAnswers(), ...seed }));
  const [step, setStep] = useState<StepId>("language");
  const [messages, setMessages] = useState<Message[]>(() => [
    { id: 0, from: "bot", text: botLine("language", "en", { ...emptyAnswers(), ...seed }, false) },
  ]);
  const [typing, setTyping] = useState<string | null>(null);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lang = answers.language;
  const he = lang === "he";

  useEffect(() => {
    onLanguageChange?.(lang);
  }, [lang, onLanguageChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typing, step]);

  function push(from: Message["from"], text: string) {
    setMessages((m) => [...m, { id: nextId.current++, from, text }]);
  }

  /** Record an answer, echo it as the user's bubble, and ask the next question. */
  function answer(patch: Partial<ChatAnswers>, echo: string) {
    const merged = { ...answers, ...patch };
    setAnswers(merged);
    push("user", echo);
    const next = nextStep(step);

    // `typing` is set before every timer below, which hides the composer
    // until the next question is on screen - no double answers.
    const ask = (a: ChatAnswers) => {
      setTyping(null);
      push("bot", botLine(next, a.language, a, isPrefilled(next, seed)));
      setStep(next);
    };

    // The website answer starts the scan. An existing client who kept the
    // stored site keeps their stored accounts and brand too; only fields the
    // record leaves empty are filled from the scan.
    if (step === "website") {
      setTyping(he ? `בודק את ${merged.website}…` : `Looking at ${merged.website}…`);
      setTimeout(() => {
        const found = simulateDiscovery(merged.website, merged.companyName);
        const withScan: ChatAnswers = {
          ...merged,
          handles: Object.keys(merged.handles).length ? merged.handles : found.handles,
          category: merged.category || found.category,
          description: merged.description || found.description,
          colors: merged.colors.length ? merged.colors : found.colors,
          competitors: merged.competitors.length ? merged.competitors : found.competitors,
        };
        setAnswers(withScan);
        ask(withScan);
      }, DISCOVERY_MS);
      return;
    }
    setTyping("");
    setTimeout(() => ask(merged), TYPING_MS);
  }

  const current = STEPS.find((s) => s.id === step);
  const progress = Math.max(0, stepIndex(step));
  const waiting = typing !== null || !current;

  return (
    // Fixed to the viewport: the answer area keeps its natural height and the
    // conversation takes what is left, so a tall card (handles, voice) never
    // pushes the thing to answer below the fold.
    <div
      dir={he ? "rtl" : "ltr"}
      className="flex h-[max(520px,calc(100dvh-230px))] flex-col overflow-hidden rounded-[14px] border border-border bg-surface"
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <BotAvatar />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Karos</p>
          <p className="text-[11px] text-muted-2">
            {he ? "מגדיר את סביבת העבודה שלך" : "Setting up your workspace"}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-border p-0.5 text-[11px]" dir="ltr">
          {(["en", "he"] as ChatLang[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setAnswers((a) => ({ ...a, language: l }))}
              className={cn(
                "rounded-full px-2 py-0.5 transition-colors",
                lang === l ? "bg-surface-3 text-foreground" : "text-muted-2 hover:text-foreground",
              )}
            >
              {l === "en" ? "EN" : "עב"}
            </button>
          ))}
        </div>
      </div>
      <div className="h-0.5 bg-border">
        <div
          className="h-full bg-neon transition-all duration-500"
          style={{ width: `${(progress / (STEPS.length - 1)) * 100}%` }}
        />
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-5">
        {messages.map((m) => (
          <Bubble key={m.id} from={m.from} text={m.text} />
        ))}
        {typing !== null && <Typing label={typing} />}
      </div>

      {/* Composer: changes with the question */}
      <div className="max-h-[60%] shrink-0 overflow-y-auto border-t border-border bg-surface-2/40 p-4">
        {waiting ? (
          <div className="h-9" />
        ) : (
          <Composer
            key={step}
            step={step}
            kind={current.kind}
            lang={lang}
            answers={answers}
            prefilled={isPrefilled(step, seed)}
            onAnswer={answer}
            onComplete={() => onComplete(answers)}
          />
        )}
      </div>
    </div>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────── */

function BotAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neon/15 text-neon">
      <Icon name="Sparkles" className="h-4 w-4" />
    </div>
  );
}

/** `**bold**` only - the copy table's one piece of markup. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i} className="font-semibold">
            <bdi>{part.slice(2, -2)}</bdi>
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Bubble({ from, text }: { from: Message["from"]; text: string }) {
  const bot = from === "bot";
  return (
    <div className={cn("flex animate-fade-up items-end gap-2", bot ? "justify-start" : "justify-end")}>
      {bot && <BotAvatar />}
      <div
        dir="auto"
        className={cn(
          "max-w-[80%] whitespace-pre-wrap rounded-[14px] px-3.5 py-2 text-sm leading-relaxed",
          bot ? "rounded-es-[4px] bg-surface-2 text-foreground" : "rounded-ee-[4px] bg-neon/15 text-foreground",
        )}
      >
        <Rich text={text} />
      </div>
    </div>
  );
}

function Typing({ label }: { label: string }) {
  return (
    <div className="flex items-end gap-2">
      <BotAvatar />
      <div className="flex items-center gap-2 rounded-[14px] rounded-es-[4px] bg-surface-2 px-3.5 py-2.5">
        <span className="flex gap-1">
          {[0, 150, 300].map((d) => (
            <span
              key={d}
              className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-2"
              style={{ animationDelay: `${d}ms` }}
            />
          ))}
        </span>
        {label && (
          <span dir="auto" className="text-xs text-muted">
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

function Chip({ selected, onClick, children }: { selected?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-sm transition-colors",
        selected
          ? "border-neon bg-neon/10 text-foreground"
          : "border-border bg-surface text-muted hover:border-muted-2 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SendRow({
  value,
  onChange,
  onSend,
  placeholder,
  invalid,
  sendLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  invalid?: string | null;
  sendLabel: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      className="space-y-1.5"
    >
      <div className="flex gap-2">
        <Input dir="auto" autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        <Button type="submit" disabled={!value.trim()} aria-label={sendLabel}>
          <Icon name="ArrowUp" className="h-4 w-4" />
        </Button>
      </div>
      {invalid && <p className="text-xs text-danger">{invalid}</p>}
    </form>
  );
}

function Composer({
  step,
  kind,
  lang,
  answers,
  prefilled,
  onAnswer,
  onComplete,
}: {
  step: StepId;
  kind: (typeof STEPS)[number]["kind"];
  lang: ChatLang;
  answers: ChatAnswers;
  prefilled: boolean;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
  onComplete: () => void;
}) {
  const he = lang === "he";
  const t = (en: string, hb: string) => (he ? hb : en);

  switch (kind) {
    case "choice":
      return <ChoiceComposer step={step} lang={lang} answers={answers} onAnswer={onAnswer} t={t} />;
    case "text":
    case "url":
      return <TextComposer step={step} kind={kind} lang={lang} answers={answers} prefilled={prefilled} onAnswer={onAnswer} t={t} />;
    case "handles":
      return <HandlesComposer answers={answers} onAnswer={onAnswer} t={t} />;
    case "brand":
      return <BrandComposer answers={answers} onAnswer={onAnswer} t={t} />;
    case "multi":
      return <MultiComposer step={step} lang={lang} answers={answers} onAnswer={onAnswer} t={t} />;
    case "voice":
      return (
        <div className="grid gap-2">
          {voiceSamples(answers.companyName, lang).map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onAnswer({ voice: v.id }, `${v.label}`)}
              className="rounded-[12px] border border-border bg-surface p-3 text-start transition-colors hover:border-neon"
            >
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-2">{v.label}</span>
              <span dir="auto" className="block text-sm leading-relaxed">
                {v.post}
              </span>
            </button>
          ))}
        </div>
      );
    case "profile":
      return (
        <div className="space-y-3">
          <div inert className="grid gap-2 opacity-70 sm:grid-cols-3" title="Disabled in simulation">
            {[
              { icon: "Camera", label: t("Add a photo", "הוספת תמונה") },
              { icon: "FileText", label: t("Upload CV", "העלאת קורות חיים") },
              { icon: "LogIn", label: t("Connect LinkedIn", "חיבור LinkedIn") },
            ].map((b) => (
              <div key={b.icon} className="flex items-center gap-2 rounded-[10px] border border-dashed border-border px-3 py-2.5 text-sm text-muted">
                <Icon name={b.icon} className="h-4 w-4" />
                {b.label}
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onAnswer({ profile: "skipped" }, t("Skip for now", "אדלג בינתיים"))}>
              {t("Skip for now", "אדלג בינתיים")}
            </Button>
            <Button onClick={() => onAnswer({ profile: "done" }, t("Done", "סיימתי"))}>{t("Done", "סיימתי")}</Button>
          </div>
        </div>
      );
    case "summary":
      return <SummaryComposer answers={answers} lang={lang} onComplete={onComplete} t={t} />;
  }
}

type T = (en: string, hb: string) => string;

function ChoiceComposer({
  step,
  lang,
  answers,
  onAnswer,
  t,
}: {
  step: StepId;
  lang: ChatLang;
  answers: ChatAnswers;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
  t: T;
}) {
  const [other, setOther] = useState("");
  const options = stepOptions(step, lang, answers);
  if (step === "language") {
    return (
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip key={o.value} selected={answers.language === o.value} onClick={() => onAnswer({ language: o.value as ChatLang }, o.label)}>
            {o.label}
          </Chip>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip key={o.value} onClick={() => onAnswer({ role: o.value }, o.label)}>
            {o.label}
          </Chip>
        ))}
      </div>
      <SendRow
        value={other}
        onChange={setOther}
        onSend={() => onAnswer({ role: other.trim() }, other.trim())}
        placeholder={t("Something else…", "משהו אחר…")}
        sendLabel={t("Send", "שליחה")}
      />
    </div>
  );
}

function TextComposer({
  step,
  kind,
  lang,
  answers,
  prefilled,
  onAnswer,
  t,
}: {
  step: StepId;
  kind: "text" | "url";
  lang: ChatLang;
  answers: ChatAnswers;
  prefilled: boolean;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
  t: T;
}) {
  const field = ({ name: "name", company: "companyName", website: "website", audience: "audience" } as const)[
    step as "name" | "company" | "website" | "audience"
  ];
  const stored = answers[field];
  const [editing, setEditing] = useState(!prefilled);
  const [value, setValue] = useState(prefilled ? stored : "");
  const [invalid, setInvalid] = useState<string | null>(null);
  const suggestions = textSuggestions(step, lang);

  if (!editing) {
    return (
      <div className="flex flex-wrap gap-2">
        <Chip onClick={() => onAnswer({}, t("Yes, that's right", "כן, נכון"))}>{t("Yes, that's right", "כן, נכון")}</Chip>
        <Chip onClick={() => setEditing(true)}>{t("Change it", "לשנות")}</Chip>
      </div>
    );
  }

  const placeholder = {
    name: t("Your full name", "השם המלא שלך"),
    companyName: t("Company name", "שם החברה"),
    website: "acme.com",
    audience: t("e.g. marketing leads at B2B companies", "למשל: מנהלי שיווק בחברות B2B"),
  }[field];

  function send() {
    const v = value.trim();
    if (!v) return;
    if (kind === "url" && !looksLikeWebsite(v)) {
      setInvalid(t("That doesn't look like a website. Try acme.com", "זה לא נראה כמו אתר. נסה/י acme.com"));
      return;
    }
    onAnswer({ [field]: v } as Partial<ChatAnswers>, v);
  }

  return (
    <div className="space-y-2.5">
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <Chip key={s} onClick={() => setValue(s)}>
              {s}
            </Chip>
          ))}
        </div>
      )}
      <SendRow
        value={value}
        onChange={(v) => {
          setValue(v);
          setInvalid(null);
        }}
        onSend={send}
        placeholder={placeholder}
        invalid={invalid}
        sendLabel={t("Send", "שליחה")}
      />
    </div>
  );
}

function HandlesComposer({
  answers,
  onAnswer,
  t,
}: {
  answers: ChatAnswers;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
  t: T;
}) {
  const [rows, setRows] = useState(() =>
    HANDLE_PLATFORMS.map((p) => ({ platform: p, value: answers.handles[p] ?? "", none: answers.handles[p] == null })),
  );
  const set = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  function confirm() {
    const handles: ChatAnswers["handles"] = {};
    for (const r of rows) handles[r.platform] = r.none || !r.value.trim() ? null : r.value.trim();
    const count = Object.values(handles).filter(Boolean).length;
    onAnswer({ handles }, t(`Confirmed ${count} accounts`, `אישרתי ${count} חשבונות`));
  }

  return (
    <div className="space-y-3">
      <div className="divide-y divide-border rounded-[12px] border border-border bg-surface">
        {rows.map((r, i) => (
          <div key={r.platform} className="flex items-center gap-3 px-3 py-2">
            <SocialPlatformMark platform={r.platform} tone="brand" className="h-4 w-4 shrink-0" />
            <span className="w-20 shrink-0 text-xs text-muted">{PLATFORM_LABEL[r.platform]}</span>
            {r.none ? (
              <span className="flex-1 text-xs text-muted-2">{t("Not found / we don't have one", "לא נמצא / אין לנו")}</span>
            ) : (
              <input
                dir="ltr"
                value={r.value}
                onChange={(e) => set(i, { value: e.target.value })}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-2"
                placeholder="@handle"
              />
            )}
            <button
              type="button"
              onClick={() => set(i, { none: !r.none })}
              className="shrink-0 text-[11px] text-muted-2 underline-offset-2 hover:text-foreground hover:underline"
            >
              {r.none ? t("Add it", "להוסיף") : t("Not ours", "לא שלנו")}
            </button>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button onClick={confirm}>
          <Icon name="Check" className="h-4 w-4" />
          {t("These are ours", "אלה שלנו")}
        </Button>
      </div>
    </div>
  );
}

function BrandComposer({
  answers,
  onAnswer,
  t,
}: {
  answers: ChatAnswers;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
  t: T;
}) {
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(answers.category);
  const [description, setDescription] = useState(answers.description);
  const initial = (answers.companyName || "?").trim().charAt(0).toUpperCase();
  const accent = answers.colors[0] ?? "#888888";

  return (
    <div className="space-y-3">
      <div className="flex gap-4 rounded-[12px] border border-border bg-surface p-4">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[12px] text-xl font-semibold text-white"
          style={{ background: accent }}
          aria-hidden
        >
          {initial}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {editing ? (
            <>
              <Input dir="auto" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t("Industry", "תעשייה")} />
              <Textarea dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[64px]" />
            </>
          ) : (
            <>
              <p dir="auto" className="text-sm font-semibold">
                {answers.companyName} <span className="font-normal text-muted-2">· {category}</span>
              </p>
              <p dir="auto" className="text-sm text-muted">
                {description}
              </p>
            </>
          )}
          <div className="flex gap-1.5" dir="ltr">
            {answers.colors.map((c) => (
              <span key={c} className="h-5 w-5 rounded-full border border-border" style={{ background: c }} title={c} />
            ))}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        {!editing && (
          <Button variant="ghost" onClick={() => setEditing(true)}>
            {t("Edit", "עריכה")}
          </Button>
        )}
        <Button onClick={() => onAnswer({ category: category.trim(), description: description.trim() }, t("That's us", "זה אנחנו"))}>
          {t("That's us", "זה אנחנו")}
        </Button>
      </div>
    </div>
  );
}

function MultiComposer({
  step,
  lang,
  answers,
  onAnswer,
  t,
}: {
  step: StepId;
  lang: ChatLang;
  answers: ChatAnswers;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
  t: T;
}) {
  const initial = step === "competitors" ? answers.competitors : step === "contentLanguage" ? [lang] : answers.goals;
  const [picked, setPicked] = useState<string[]>(initial);
  const [extra, setExtra] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const options = [...stepOptions(step, lang, answers), ...extra.map((e) => ({ value: e, label: e }))];
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const optional = step === "competitors";

  function send() {
    const labels = options.filter((o) => picked.includes(o.value)).map((o) => o.label);
    const echo = labels.length ? labels.join(", ") : t("None", "אין");
    if (step === "goals") onAnswer({ goals: picked }, echo);
    else if (step === "competitors") onAnswer({ competitors: picked }, echo);
    else onAnswer({ contentLanguages: picked as ChatLang[] }, echo);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip key={o.value} selected={picked.includes(o.value)} onClick={() => toggle(o.value)}>
            {picked.includes(o.value) && <Icon name="Check" className="-ms-0.5 me-1 inline h-3.5 w-3.5" />}
            {o.label}
          </Chip>
        ))}
      </div>
      {step === "competitors" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = draft.trim();
            if (!v) return;
            setExtra((x) => [...x, v]);
            setPicked((p) => [...p, v]);
            setDraft("");
          }}
          className="flex gap-2"
        >
          <Input dir="auto" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("Add a competitor", "הוספת מתחרה")} />
          <Button type="submit" variant="outline" disabled={!draft.trim()}>
            <Icon name="Plus" className="h-4 w-4" />
          </Button>
        </form>
      )}
      <div className="flex justify-end">
        <Button onClick={send} disabled={!optional && picked.length === 0}>
          {t("Continue", "המשך")}
          <Icon name={lang === "he" ? "ArrowLeft" : "ArrowRight"} className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function SummaryComposer({
  answers,
  lang,
  onComplete,
  t,
}: {
  answers: ChatAnswers;
  lang: ChatLang;
  onComplete: () => void;
  t: T;
}) {
  const goals = stepOptions("goals", lang, answers)
    .filter((o) => answers.goals.includes(o.value))
    .map((o) => o.label)
    .join(", ");
  const handles = HANDLE_PLATFORMS.filter((p) => answers.handles[p]).map((p) => PLATFORM_LABEL[p]).join(", ");
  const voice = voiceSamples(answers.companyName, lang).find((v) => v.id === answers.voice)?.label ?? "";
  const rows: [string, string][] = [
    [t("You", "את/ה"), [answers.name, answers.role].filter(Boolean).join(" · ")],
    [t("Company", "חברה"), [answers.companyName, answers.website].filter(Boolean).join(" · ")],
    [t("Accounts", "חשבונות"), handles],
    [t("Industry", "תעשייה"), answers.category],
    [t("Goals", "מטרות"), goals],
    [t("Audience", "קהל"), answers.audience],
    [t("Competitors", "מתחרים"), answers.competitors.join(", ")],
    [t("Voice", "טון"), voice],
    [t("Content language", "שפת תוכן"), answers.contentLanguages.map((l) => (l === "he" ? t("Hebrew", "עברית") : t("English", "אנגלית"))).join(", ")],
  ];
  return (
    <div className="space-y-3">
      <dl className="divide-y divide-border rounded-[12px] border border-border bg-surface text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[120px_1fr] gap-3 px-3 py-1.5">
            <dt className="text-muted-2">{k}</dt>
            <dd dir="auto" className="break-words">
              {v || <span className="text-muted-2">-</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex justify-end">
        <Button onClick={onComplete}>
          {t("Continue to your channels", "המשך לחיבור הרשתות")}
          <Icon name={lang === "he" ? "ArrowLeft" : "ArrowRight"} className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
