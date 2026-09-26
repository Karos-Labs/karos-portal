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
  emptyDiscovery,
  isPrefilled,
  looksLikeWebsite,
  nextStep,
  stepIndex,
  stepOptions,
  textSuggestions,
  voiceSamples,
  type ChatAnswers,
  type ChatDraft,
  type ChatLang,
  type ChatMessage as Message,
  type ChatSeed,
  type Discovery,
  type StepId,
  type VoiceId,
} from "@/lib/onboarding-chat";

/**
 * Step 1 of onboarding: the conversation. Owns the flow only; the wizard
 * decides what "scan the website", "save the draft" and the personal profile
 * controls do, so the same chat runs for a real client and in the admin
 * simulation.
 */

const TYPING_MS = 550;

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
  initialDraft,
  discover,
  saveDraft,
  renderProfile,
  onComplete,
  onLanguageChange,
}: {
  /** What an existing client's record already answers; empty for a new company. */
  seed: ChatSeed;
  /** A conversation saved earlier; resumes at its step. */
  initialDraft?: ChatDraft | null;
  /** The website scan. May resolve empty; must not reject (a rejection is treated as empty). */
  discover: (input: { website: string; companyName: string; language: ChatLang }) => Promise<Discovery>;
  /** Called with the conversation each time a new question is asked. */
  saveDraft?: (draft: ChatDraft) => void;
  /** The photo / CV / LinkedIn controls for the optional personal step. */
  renderProfile: (lang: ChatLang, name: string) => React.ReactNode;
  /** `voicePost` is the sample post the client picked, as they saw it. */
  onComplete: (answers: ChatAnswers, voicePost: string) => void;
  /** The wizard bar above speaks the chat's language too. */
  onLanguageChange?: (lang: ChatLang) => void;
}) {
  const [answers, setAnswers] = useState<ChatAnswers>(
    () => initialDraft?.answers ?? { ...emptyAnswers(), ...withoutBrandVoice(seed) },
  );
  const [step, setStep] = useState<StepId>(initialDraft?.step ?? "language");
  const [messages, setMessages] = useState<Message[]>(() =>
    initialDraft?.messages.length
      ? initialDraft.messages
      : [{ id: 0, from: "bot", text: botLine("language", "en", emptyAnswers(), false) }],
  );
  const [written, setWritten] = useState<{ id: VoiceId; post: string }[]>(initialDraft?.voiceSamples ?? []);
  const [typing, setTyping] = useState<string | null>(null);
  const nextId = useRef((initialDraft?.messages.length ?? 1) + 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lang = answers.language;
  const he = lang === "he";

  useEffect(() => {
    onLanguageChange?.(lang);
  }, [lang, onLanguageChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typing, step]);

  /** Record an answer, echo it as the user's bubble, and ask the next question. */
  function answer(patch: Partial<ChatAnswers>, echo: string) {
    const merged = { ...answers, ...patch };
    setAnswers(merged);
    const userMessage: Message = { id: nextId.current++, from: "user", text: echo };
    const transcript = [...messages, userMessage];
    setMessages(transcript);
    const next = nextStep(step);

    // `typing` is set before the next question arrives, which hides the
    // composer until it is on screen - no double answers.
    const ask = (a: ChatAnswers, samples: { id: VoiceId; post: string }[]) => {
      setTyping(null);
      const botMessage: Message = { id: nextId.current++, from: "bot", text: botLine(next, a.language, a, isPrefilled(next, seed)) };
      setMessages([...transcript, botMessage]);
      setStep(next);
      saveDraft?.({ step: next, answers: a, messages: [...transcript, botMessage], voiceSamples: samples });
    };

    // The website answer starts the scan. What the client's record already
    // holds is kept; the scan only fills what it leaves empty.
    if (step === "website") {
      setTyping(he ? `בודק את ${merged.website}…` : `Looking at ${merged.website}…`);
      discover({ website: merged.website, companyName: merged.companyName, language: merged.language })
        .catch(() => emptyDiscovery())
        .then((found) => {
          const withScan: ChatAnswers = {
            ...merged,
            handles: Object.keys(merged.handles).length ? merged.handles : found.handles,
            category: merged.category || found.category,
            description: merged.description || found.description,
            colors: merged.colors.length ? merged.colors : found.colors,
            logoUrl: merged.logoUrl || found.logoUrl,
            competitors: merged.competitors.length ? merged.competitors : found.competitors,
          };
          setAnswers(withScan);
          setWritten(found.voiceSamples);
          ask(withScan, found.voiceSamples);
        });
      return;
    }
    setTyping("");
    setTimeout(() => ask(merged, written), TYPING_MS);
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
            written={written}
            renderProfile={renderProfile}
            onAnswer={answer}
            onComplete={() =>
              onComplete(
                answers,
                answers.voice ? voiceSamples(answers.companyName, lang, written).find((v) => v.id === answers.voice)?.post ?? "" : "",
              )
            }
          />
        )}
      </div>
    </div>
  );
}

/** The stored brand voice is the seed's business (it decides the voice step), not an answer. */
function withoutBrandVoice(seed: ChatSeed): Partial<ChatAnswers> {
  const rest: ChatSeed = { ...seed };
  delete rest.brandVoice;
  return rest;
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
  written,
  renderProfile,
  onAnswer,
  onComplete,
}: {
  step: StepId;
  kind: (typeof STEPS)[number]["kind"];
  lang: ChatLang;
  answers: ChatAnswers;
  prefilled: boolean;
  written: { id: VoiceId; post: string }[];
  renderProfile: (lang: ChatLang, name: string) => React.ReactNode;
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
          {prefilled && (
            <div>
              <Chip onClick={() => onAnswer({ keepVoice: true, voice: "" }, t("Keep our current voice", "להשאיר את הטון הנוכחי"))}>
                {t("Keep our current voice", "להשאיר את הטון הנוכחי")}
              </Chip>
            </div>
          )}
          {voiceSamples(answers.companyName, lang, written).map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onAnswer({ voice: v.id, keepVoice: false }, v.label)}
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
          {renderProfile(lang, answers.name)}
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
        <BrandMark logoUrl={answers.logoUrl ?? null} initial={initial} accent={accent} />
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

/** The logo the scan found, on a white tile; the initial on the accent when there is none or it fails to load. */
function BrandMark({ logoUrl, initial, accent }: { logoUrl: string | null; initial: string; accent: string }) {
  const [failed, setFailed] = useState(false);
  if (logoUrl && !failed) {
    return (
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-border bg-white p-1.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div
      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[12px] text-xl font-semibold text-white"
      style={{ background: accent }}
      aria-hidden
    >
      {initial}
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
  const voice = answers.keepVoice
    ? t("Kept the current voice", "הטון הנוכחי נשאר")
    : (voiceSamples(answers.companyName, lang).find((v) => v.id === answers.voice)?.label ?? "");
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
              {v || <span className="text-muted-2">{t("Not set", "לא הוזן")}</span>}
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
