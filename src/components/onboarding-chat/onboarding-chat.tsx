"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";
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
  type ChatMessage as Message,
  type ChatSeed,
  type Discovery,
  type StepId,
  type VoiceId,
} from "@/lib/onboarding-chat";
import { CHAT_LANGUAGES, OPENING_MESSAGE, isChatLang, isRtl, languageLabel, tr, type ChatLang, type MsgKey } from "@/lib/onboarding-i18n";

/**
 * Step 1 of onboarding: the conversation. Owns the flow only; the wizard
 * decides what "scan the website", "save the draft", "upload a logo" and the
 * personal profile controls do, so the same chat runs for a real client and
 * in the admin simulation.
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

/** A translator bound to one language, handed to the composers. */
type T = (key: MsgKey, vars?: Record<string, string | number>) => string;

export function OnboardingChat({
  seed,
  initialDraft,
  discover,
  saveDraft,
  renderProfile,
  uploadLogo,
  findLogo,
  onComplete,
  onLanguageChange,
}: {
  /** What the client's record already answers; empty for a new company. */
  seed: ChatSeed;
  /** A conversation saved earlier; resumes at its step. */
  initialDraft?: ChatDraft | null;
  /** The website scan (new companies only). May resolve empty; a rejection counts as empty. */
  discover: (input: { website: string; companyName: string; language: ChatLang }) => Promise<Discovery>;
  /** Called with the conversation each time a new question is asked. */
  saveDraft?: (draft: ChatDraft) => void;
  /** The photo / CV / LinkedIn controls for the optional personal step. */
  renderProfile: (lang: ChatLang, name: string) => React.ReactNode;
  /** Stores an uploaded logo and returns its URL. Absent = uploads disabled (the simulation). */
  uploadLogo?: (file: File) => Promise<string>;
  /** Finds the logo on a website (one page read, no model). Resolves null when there is none. */
  findLogo: (input: { website: string; companyName: string }) => Promise<string | null>;
  /** `voicePost` is the sample post the client picked, as they saw it. */
  onComplete: (answers: ChatAnswers, voicePost: string) => void;
  /** The wizard bar above speaks the chat's language too. */
  onLanguageChange?: (lang: ChatLang) => void;
}) {
  const [answers, setAnswers] = useState<ChatAnswers>(
    () => initialDraft?.answers ?? { ...emptyAnswers(), ...seedAnswers(seed) },
  );
  const [step, setStep] = useState<StepId>(initialDraft?.step ?? "name");
  const [messages, setMessages] = useState<Message[]>(() =>
    initialDraft?.messages.length ? initialDraft.messages : [{ id: 0, from: "bot", text: OPENING_MESSAGE }],
  );
  const [written, setWritten] = useState<{ id: VoiceId; post: string }[]>(initialDraft?.voiceSamples ?? []);
  const [typing, setTyping] = useState<string | null>(null);
  const nextId = useRef((initialDraft?.messages.length ?? 1) + 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lang = answers.language;
  const rtl = isRtl(lang);
  const t: T = (key, vars) => tr(lang, key, vars);
  const existing = !!seed.existing;

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
      const text = botLine(next, a.language, a, { prefilled: isPrefilled(next, seed), existing });
      const botMessage: Message = { id: nextId.current++, from: "bot", text };
      setMessages([...transcript, botMessage]);
      setStep(next);
      saveDraft?.({ step: next, answers: a, messages: [...transcript, botMessage], voiceSamples: samples });
    };

    // A NEW company's website answer starts the scan: accounts, logo,
    // competitors and sample posts. An EXISTING client's accounts, logo and
    // competitors come from their record, so nothing is scanned for them
    // (owner ruling 2026-09-26) - they confirm or change what is on file.
    if (step === "website" && !existing) {
      setTyping(t("scanning", { website: merged.website }));
      discover({ website: merged.website, companyName: merged.companyName, language: merged.language })
        .catch(() => emptyDiscovery())
        .then((found) => {
          const withScan: ChatAnswers = {
            ...merged,
            handles: Object.keys(merged.handles).length ? merged.handles : found.handles,
            ...(merged.logoUrl || !found.logoUrl ? {} : { logoUrl: found.logoUrl }),
            competitors: merged.competitors.length ? merged.competitors : found.competitors,
          };
          setAnswers(withScan);
          setWritten(found.voiceSamples);
          ask(withScan, found.voiceSamples);
        });
      return;
    }
    // Arriving at the logo step with no logo but a website (an existing
    // client whose record has none): look on the site first, then ask.
    if (next === "logo" && !merged.logoUrl && merged.website) {
      setTyping(t("lookingForLogo"));
      findLogo({ website: merged.website, companyName: merged.companyName })
        .catch(() => null)
        .then((url) => {
          const withLogo: ChatAnswers = url ? { ...merged, logoUrl: url } : merged;
          setAnswers(withLogo);
          ask(withLogo, written);
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
      dir={rtl ? "rtl" : "ltr"}
      className="flex h-[max(520px,calc(100dvh-230px))] flex-col overflow-hidden rounded-[14px] border border-border bg-surface"
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <BotAvatar />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Karos</p>
          <p className="text-[11px] text-muted-2">{t("headerSubtitle")}</p>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <Icon name="Languages" className="h-3.5 w-3.5" />
          <span className="sr-only">{t("language")}</span>
          <select
            value={lang}
            onChange={(e) => {
              const next = e.target.value;
              if (isChatLang(next)) setAnswers((a) => ({ ...a, language: next }));
            }}
            aria-label={t("language")}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
          >
            {CHAT_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
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
            t={t}
            answers={answers}
            prefilled={isPrefilled(step, seed)}
            written={written}
            renderProfile={renderProfile}
            uploadLogo={uploadLogo}
            findLogo={() => findLogo({ website: answers.website, companyName: answers.companyName })}
            logoOnFile={seed.logoUrl ?? null}
            onAnswer={answer}
            onComplete={() =>
              onComplete(
                answers,
                answers.voice ? (voiceSamples(answers.companyName, lang, written).find((v) => v.id === answers.voice)?.post ?? "") : "",
              )
            }
          />
        )}
      </div>
    </div>
  );
}

/** The seed's answers. The stored brand voice and `existing` decide steps; they are not answers. */
function seedAnswers(seed: ChatSeed): Partial<ChatAnswers> {
  const rest: ChatSeed = { ...seed };
  delete rest.brandVoice;
  delete rest.existing;
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
  t,
  answers,
  prefilled,
  written,
  renderProfile,
  uploadLogo,
  findLogo,
  logoOnFile,
  onAnswer,
  onComplete,
}: {
  step: StepId;
  kind: (typeof STEPS)[number]["kind"];
  lang: ChatLang;
  t: T;
  answers: ChatAnswers;
  prefilled: boolean;
  written: { id: VoiceId; post: string }[];
  renderProfile: (lang: ChatLang, name: string) => React.ReactNode;
  uploadLogo?: (file: File) => Promise<string>;
  findLogo: () => Promise<string | null>;
  logoOnFile: string | null;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
  onComplete: () => void;
}) {
  switch (kind) {
    case "choice":
      return <ChoiceComposer step={step} lang={lang} t={t} answers={answers} onAnswer={onAnswer} />;
    case "text":
    case "url":
      return <TextComposer step={step} kind={kind} lang={lang} t={t} answers={answers} prefilled={prefilled} onAnswer={onAnswer} />;
    case "handles":
      return <HandlesComposer t={t} answers={answers} onAnswer={onAnswer} />;
    case "logo":
      return (
        <LogoComposer
          t={t}
          answers={answers}
          logoOnFile={logoOnFile}
          uploadLogo={uploadLogo}
          findLogo={answers.website ? findLogo : undefined}
          onAnswer={onAnswer}
        />
      );
    case "multi":
      return <MultiComposer step={step} lang={lang} t={t} answers={answers} onAnswer={onAnswer} />;
    case "voice":
      return (
        <div className="grid gap-2">
          {prefilled && (
            <div>
              <Chip onClick={() => onAnswer({ keepVoice: true, voice: "" }, t("keepVoice"))}>{t("keepVoice")}</Chip>
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
            <Button variant="ghost" onClick={() => onAnswer({ profile: "skipped" }, t("skipForNow"))}>
              {t("skipForNow")}
            </Button>
            <Button onClick={() => onAnswer({ profile: "done" }, t("doneButton"))}>{t("doneButton")}</Button>
          </div>
        </div>
      );
    case "summary":
      return <SummaryComposer lang={lang} t={t} answers={answers} onComplete={onComplete} />;
  }
}

function ChoiceComposer({
  step,
  lang,
  t,
  answers,
  onAnswer,
}: {
  step: StepId;
  lang: ChatLang;
  t: T;
  answers: ChatAnswers;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
}) {
  const [other, setOther] = useState("");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {stepOptions(step, lang, answers).map((o) => (
          <Chip key={o.value} onClick={() => onAnswer({ role: o.value }, o.label)}>
            {o.label}
          </Chip>
        ))}
      </div>
      <SendRow
        value={other}
        onChange={setOther}
        onSend={() => onAnswer({ role: other.trim() }, other.trim())}
        placeholder={t("somethingElse")}
        sendLabel={t("send")}
      />
    </div>
  );
}

function TextComposer({
  step,
  kind,
  lang,
  t,
  answers,
  prefilled,
  onAnswer,
}: {
  step: StepId;
  kind: "text" | "url";
  lang: ChatLang;
  t: T;
  answers: ChatAnswers;
  prefilled: boolean;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
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
        <Chip onClick={() => onAnswer({}, t("yesRight"))}>{t("yesRight")}</Chip>
        <Chip onClick={() => setEditing(true)}>{t("changeIt")}</Chip>
      </div>
    );
  }

  const placeholder = {
    name: t("placeholderName"),
    companyName: t("placeholderCompany"),
    website: "acme.com",
    audience: t("placeholderAudience"),
  }[field];

  function send() {
    const v = value.trim();
    if (!v) return;
    if (kind === "url" && !looksLikeWebsite(v)) {
      setInvalid(t("invalidWebsite"));
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
        sendLabel={t("send")}
      />
    </div>
  );
}

function HandlesComposer({
  t,
  answers,
  onAnswer,
}: {
  t: T;
  answers: ChatAnswers;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
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
    onAnswer({ handles }, t("confirmedAccounts", { count }));
  }

  return (
    <div className="space-y-3">
      <div className="divide-y divide-border rounded-[12px] border border-border bg-surface">
        {rows.map((r, i) => (
          <div key={r.platform} className="flex items-center gap-3 px-3 py-2">
            <SocialPlatformMark platform={r.platform} tone="brand" className="h-4 w-4 shrink-0" />
            <span className="w-20 shrink-0 text-xs text-muted">{PLATFORM_LABEL[r.platform]}</span>
            {r.none ? (
              <span className="flex-1 text-xs text-muted-2">{t("notFound")}</span>
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
              {r.none ? t("addIt") : t("notOurs")}
            </button>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button onClick={confirm}>
          <Icon name="Check" className="h-4 w-4" />
          {t("theseAreOurs")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The logo step. Whatever logo is on the table - the one on file, one found
 * on the site, or one just uploaded - is previewed on a light AND a dark
 * ground (a white logo vanishes on white), labelled with where it came from,
 * with every way forward next to it: approve it, look on the site (again),
 * upload one, or skip. A logo that fails to load is said so and treated as
 * none (two stored logos on prod were dead links, 2026-09-26).
 *
 * An upload is stored at once by the regular logo route, so it is already the
 * client's logo; an approved logo from the site is copied into storage at
 * Finish; keeping the one on file writes nothing.
 */
function LogoComposer({
  t,
  answers,
  logoOnFile,
  uploadLogo,
  findLogo,
  onAnswer,
}: {
  t: T;
  answers: ChatAnswers;
  logoOnFile: string | null;
  uploadLogo?: (file: File) => Promise<string>;
  /** Absent when there is no website to look at. */
  findLogo?: () => Promise<string | null>;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
}) {
  type Origin = "file" | "site" | "upload";
  const initialOrigin: Origin = answers.logoUrl && answers.logoUrl === logoOnFile ? "file" : "site";
  const [logo, setLogo] = useState<{ url: string; origin: Origin } | null>(
    answers.logoUrl ? { url: answers.logoUrl, origin: initialOrigin } : null,
  );
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState<"find" | "upload" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const usable = logo && !broken ? logo : null;

  async function find() {
    if (!findLogo) return;
    setBusy("find");
    setNote(null);
    const url = await findLogo().catch(() => null);
    setBusy(null);
    if (url) {
      setLogo({ url, origin: "site" });
      setBroken(false);
    } else {
      setNote(t("logoNotFoundInline"));
    }
  }

  async function pick(file: File | undefined) {
    if (!file || !uploadLogo) return;
    setBusy("upload");
    setNote(null);
    try {
      const url = await uploadLogo(file);
      setLogo({ url, origin: "upload" });
      setBroken(false);
    } catch (e) {
      setNote(e instanceof Error ? e.message : t("uploadFailed"));
    } finally {
      setBusy(null);
    }
  }

  function approve() {
    if (!usable) return;
    const source = usable.origin === "file" ? "kept" : usable.origin === "site" ? "scan" : "upload";
    const echo = usable.origin === "file" ? t("keepIt") : usable.origin === "upload" ? t("uploadedLogo") : t("thatsOurLogo");
    onAnswer({ logoUrl: usable.url, logoSource: source }, echo);
  }

  const badge = logo ? (logo.origin === "file" ? t("badgeOnFile") : logo.origin === "site" ? t("badgeFromSite") : t("badgeUploaded")) : null;

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-[12px] border border-border">
        {logo && !broken ? (
          <div className="grid grid-cols-2" dir="ltr">
            {[
              { bg: "bg-white", label: t("onLight"), text: "text-neutral-500" },
              { bg: "bg-neutral-900", label: t("onDark"), text: "text-neutral-400" },
            ].map((g) => (
              <div key={g.label} className={cn("flex h-28 flex-col items-center justify-center gap-2 px-8 py-4", g.bg)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logo.url} alt="" className="h-12 w-full object-contain" onError={() => setBroken(true)} />
                <span className={cn("text-[10px]", g.text)}>{g.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-28 flex-col items-center justify-center gap-2 border-dashed bg-surface text-muted-2">
            <Icon name={broken ? "ImageOff" : "Image"} className="h-6 w-6" />
            <span className="text-xs">{broken ? t("logoLoadFailed") : t("noLogoYet")}</span>
          </div>
        )}
        {badge && !broken && (
          <div className="flex items-center gap-1.5 border-t border-border bg-surface px-3 py-1.5 text-[11px] text-muted">
            <Icon name={logo?.origin === "site" ? "Globe" : logo?.origin === "upload" ? "Upload" : "Archive"} className="h-3 w-3" />
            {badge}
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/svg+xml,image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      {note && <p className="text-xs text-muted">{note}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onAnswer({ logoSource: "skipped" }, t("skipForNow"))} disabled={!!busy}>
          {t("skipForNow")}
        </Button>
        {findLogo && (
          <Button variant="outline" onClick={find} loading={busy === "find"} disabled={!!busy}>
            {busy !== "find" && <Icon name="Search" className="h-4 w-4" />}
            {t("findOnSite")}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => inputRef.current?.click()}
          loading={busy === "upload"}
          disabled={!uploadLogo || !!busy}
          title={uploadLogo ? undefined : "Disabled in simulation"}
        >
          {busy !== "upload" && <Icon name="Upload" className="h-4 w-4" />}
          {usable ? t("uploadDifferent") : t("uploadLogo")}
        </Button>
        {usable && (
          <Button onClick={approve} disabled={!!busy}>
            <Icon name="Check" className="h-4 w-4" />
            {usable.origin === "file" ? t("keepIt") : t("thatsOurLogo")}
          </Button>
        )}
      </div>
    </div>
  );
}

function MultiComposer({
  step,
  lang,
  t,
  answers,
  onAnswer,
}: {
  step: StepId;
  lang: ChatLang;
  t: T;
  answers: ChatAnswers;
  onAnswer: (patch: Partial<ChatAnswers>, echo: string) => void;
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
    const echo = labels.length ? labels.join(", ") : t("none");
    if (step === "goals") onAnswer({ goals: picked }, echo);
    else if (step === "competitors") onAnswer({ competitors: picked }, echo);
    else onAnswer({ contentLanguages: picked.filter(isChatLang) }, echo);
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
          <Input dir="auto" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("addCompetitor")} />
          <Button type="submit" variant="outline" disabled={!draft.trim()}>
            <Icon name="Plus" className="h-4 w-4" />
          </Button>
        </form>
      )}
      <div className="flex justify-end">
        <Button onClick={send} disabled={!optional && picked.length === 0}>
          {t("continue")}
          <Icon name={isRtl(lang) ? "ArrowLeft" : "ArrowRight"} className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function SummaryComposer({
  lang,
  t,
  answers,
  onComplete,
}: {
  lang: ChatLang;
  t: T;
  answers: ChatAnswers;
  onComplete: () => void;
}) {
  const goals = stepOptions("goals", lang, answers)
    .filter((o) => answers.goals.includes(o.value))
    .map((o) => o.label)
    .join(", ");
  const handles = HANDLE_PLATFORMS.filter((p) => answers.handles[p]).map((p) => PLATFORM_LABEL[p]).join(", ");
  const voice = answers.keepVoice
    ? t("voiceKept")
    : (voiceSamples(answers.companyName, lang).find((v) => v.id === answers.voice)?.label ?? "");
  const logo =
    answers.logoSource === "scan"
      ? t("logoFromSite")
      : answers.logoSource === "upload"
        ? t("logoUploaded")
        : answers.logoSource === "kept"
          ? t("logoKept")
          : "";
  const rows: [string, string][] = [
    [t("sumYou"), [answers.name, answers.role].filter(Boolean).join(" · ")],
    [t("sumCompany"), [answers.companyName, answers.website].filter(Boolean).join(" · ")],
    [t("sumAccounts"), handles],
    [t("sumLogo"), logo],
    [t("sumGoals"), goals],
    [t("sumAudience"), answers.audience],
    [t("sumCompetitors"), answers.competitors.join(", ")],
    [t("sumVoice"), voice],
    [t("sumContentLanguage"), answers.contentLanguages.map(languageLabel).join(", ")],
  ];
  return (
    <div className="space-y-3">
      <dl className="divide-y divide-border rounded-[12px] border border-border bg-surface text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[120px_1fr] gap-3 px-3 py-1.5">
            <dt className="text-muted-2">{k}</dt>
            <dd dir="auto" className="break-words">
              {v || <span className="text-muted-2">{t("notSet")}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex justify-end">
        <Button onClick={onComplete}>
          {t("toChannels")}
          <Icon name={isRtl(lang) ? "ArrowLeft" : "ArrowRight"} className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
