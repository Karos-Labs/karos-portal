"use client";

import { useCallback, useState, useTransition } from "react";
import Link from "next/link";
import { Badge, Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { SocialPlatformMark } from "@/components/agent-identity";
import { AvatarUploader } from "@/components/avatar-uploader";
import { ResumeUploader } from "@/components/resume-uploader";
import { IntegrationsTab } from "@/components/integrations-tab";
import { cn } from "@/lib/utils";
import { checkBrandLogoFile } from "@/lib/brand-logo-file";
import { OnboardingChat } from "./onboarding-chat";
import {
  completeOnboardingAction,
  discoverOnboardingProfileAction,
  ensureOwnEmployeeSeatAction,
  saveOnboardingChatDraftAction,
  saveOnboardingProfileAction,
} from "@/lib/actions/onboarding-actions";
import { simulateOnboardingDiscoveryAction } from "@/lib/actions/onboarding-simulation-actions";
import { HANDLE_PLATFORMS, type ChatAnswers, type ChatDraft, type ChatSeed } from "@/lib/onboarding-chat";
import { isRtl, tr, type ChatLang, type MsgKey } from "@/lib/onboarding-i18n";
import type { AppUser } from "@/lib/types";
import type { IntegrationView } from "@/lib/integrations/sanitize";
import type { SeatView } from "@/components/linkedin-seats-workspace";

/**
 * Client onboarding (2026-09-26): two steps under the wizard bar - a
 * conversation, then the channel cards - replacing the three-form wizard.
 *
 * The same component runs the admin dry run (account menu → "Simulate
 * onboarding") with `simulation` set. Then NOTHING writes: the scan is the
 * admin action (read-only), no draft is saved, the photo/CV/LinkedIn controls
 * and channel cards are inert (they would write the admin's own profile or a
 * real client's channels), and Finish shows a summary instead of saving.
 */

export interface OnboardingSimulation {
  exitHref: string;
  mode: "new" | "existing";
}

const STEPS = [
  { id: 1, label: "stepAboutYou", icon: "MessagesSquare" },
  { id: 2, label: "stepChannels", icon: "Share2" },
] as const satisfies readonly { id: number; label: MsgKey; icon: string }[];

type T = (key: MsgKey, vars?: Record<string, string | number>) => string;

export function OnboardingChatWizard({
  user,
  clientId,
  seed,
  initialDraft,
  notice,
  integrations,
  oauthEnabledPlatforms,
  linkedinSeats,
  seatLimit,
  seatCost,
  simulation,
}: {
  user: Pick<AppUser, "name" | "role" | "photoURL" | "resumeUrl" | "linkedInConnected">;
  clientId: string;
  seed: ChatSeed;
  initialDraft?: ChatDraft | null;
  notice?: string | null;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  linkedinSeats?: SeatView[];
  seatLimit?: number;
  seatCost?: number;
  simulation?: OnboardingSimulation;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [finished, setFinished] = useState<{ answers: ChatAnswers; voicePost: string } | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [lang, setLang] = useState<ChatLang>(initialDraft?.answers.language ?? "en");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const rtl = isRtl(lang);
  const t: T = (key, vars) => tr(lang, key, vars);

  const discover = simulation ? simulateOnboardingDiscoveryAction : discoverOnboardingProfileAction;
  const saveDraft = useCallback(
    (draft: ChatDraft) => {
      if (simulation) return;
      // Best effort: a failed save costs the resume point, never the answer on screen.
      saveOnboardingChatDraftAction(draft).catch(() => {});
    },
    [simulation],
  );

  // The regular logo route (a client may set their own logo): the upload is
  // the client's logo the moment it lands. Absent in a simulation.
  const uploadLogo = simulation
    ? undefined
    : async (file: File): Promise<string> => {
        const check = checkBrandLogoFile(file);
        if (!check.ok) throw new Error(check.error);
        const body = new FormData();
        body.set("file", file);
        const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/logo`, { method: "POST", body });
        const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !json.url) throw new Error(json.error ?? t("uploadFailed"));
        return json.url;
      };

  function finish() {
    if (!finished) return;
    setError(null);
    if (simulation) {
      setStep(3);
      return;
    }
    // The action redirects on success, and `redirect()` throws by design, so
    // only a real failure is caught and shown; the redirect is rethrown.
    startTransition(async () => {
      try {
        await completeOnboardingAction({ answers: finished.answers, voicePost: finished.voicePost });
      } catch (e) {
        if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
        setError(e instanceof Error ? e.message : t("finishFailed"));
      }
    });
  }

  return (
    <div className="animate-fade-up">
      {simulation && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-dashed border-border bg-surface-2 px-4 py-2.5 text-xs text-muted">
          <Icon name="FlaskConical" className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {simulation.mode === "new"
              ? "Simulation (new company). The website scan is real; nothing is saved, uploaded or connected."
              : "Simulation (existing client). Accounts, logo and competitors come from this client's record, no scan; nothing is saved, uploaded or connected."}
          </span>
          <Link href={simulation.exitHref} className="font-medium text-foreground hover:underline">
            Exit
          </Link>
        </div>
      )}

      <div className="mb-5 flex items-center justify-center gap-3">
        {STEPS.map((s, i) => (
          <div key={s.id} className="flex items-center gap-3">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm transition-colors",
                  step === s.id
                    ? "border-neon bg-neon/10 text-neon"
                    : step > s.id
                      ? "border-neon/40 bg-neon/10 text-neon/70"
                      : "border-border text-muted-2",
                )}
              >
                {step > s.id ? <Icon name="Check" className="h-4 w-4" /> : <Icon name={s.icon} className="h-4 w-4" />}
              </div>
              <span className={cn("text-[11px] font-medium", step === s.id ? "text-foreground" : "text-muted-2")}>
                {t(s.label)}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn("mb-4 h-px w-16 transition-colors", step > s.id ? "bg-neon/40" : "bg-border")} />
            )}
          </div>
        ))}
      </div>

      {notice && (
        <div className="mb-4 rounded-md border border-border bg-surface-2 px-4 py-2.5 text-xs text-muted">{notice}</div>
      )}

      {step === 1 && (
        <OnboardingChat
          key={chatKey}
          seed={seed}
          initialDraft={chatKey === 0 ? initialDraft : null}
          discover={discover}
          saveDraft={saveDraft}
          uploadLogo={uploadLogo}
          renderProfile={(l, name) => (
            <ProfileControls user={user} name={name} clientId={clientId} lang={l} simulated={!!simulation} />
          )}
          onLanguageChange={setLang}
          onComplete={(answers, voicePost) => {
            setFinished({ answers, voicePost });
            setStep(2);
          }}
        />
      )}

      {step === 2 && finished && (
        <Card dir={rtl ? "rtl" : "ltr"} className="animate-slide-in-right space-y-5">
          <ConfirmedAccounts answers={finished.answers} t={t} />
          {/* Every card here connects/disconnects a REAL client's channel. */}
          {simulation && (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted">
              Connections are switched off in the simulation (they would connect a real client&apos;s accounts). A real
              client connects here with the same cards as Settings.
            </p>
          )}
          <SimulationInert active={!!simulation}>
            <div dir="ltr">
              <IntegrationsTab
                clientId={clientId}
                integrations={integrations}
                oauthEnabledPlatforms={oauthEnabledPlatforms}
                currentUserRole={user.role}
                linkedinSeats={linkedinSeats}
                seatLimit={seatLimit}
                seatCost={seatCost}
              />
            </div>
          </SimulationInert>
          <ResearchNotice companyName={finished.answers.companyName} t={t} />
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setStep(1)} disabled={isPending}>
              <Icon name={rtl ? "ArrowRight" : "ArrowLeft"} className="h-4 w-4" />
              {t("back")}
            </Button>
            <Button onClick={finish} loading={isPending}>
              {t("finishSetup")}
              <Icon name="CircleCheck" className="h-4 w-4" />
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && simulation && (
        <Card className="animate-slide-in-right space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neon/15 text-neon">
            <Icon name="CircleCheck" className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Simulation finished</h2>
            <p className="text-xs text-muted-2">
              A real client would be saved now and land on Home, with the Intel Report and Task Map building in the
              background from these answers.
            </p>
          </div>
          <div className="flex justify-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setFinished(null);
                setChatKey((k) => k + 1);
                setStep(1);
              }}
            >
              <Icon name="RotateCcw" className="h-4 w-4" />
              Run again
            </Button>
            <Link href={simulation.exitHref}>
              <Button>Exit simulation</Button>
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * What Finish starts. The chat collects only what the client knows; their
 * brand, competitors and market picture are researched afterwards (Intel
 * Report + SEO/GEO) and land in the workspace on their own - so the client is
 * told it has started and that they need not wait for it.
 */
function ResearchNotice({ companyName, t }: { companyName: string; t: T }) {
  const name = companyName || t("yourCompany");
  return (
    <div className="flex items-start gap-2.5 rounded-[12px] border border-border bg-surface-2 px-4 py-3 text-xs text-muted">
      <Icon name="Sparkles" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neon" />
      <p dir="auto">
        {t("researchNotice", { company: name })}
      </p>
    </div>
  );
}

/** Shows its children but takes them out of interaction (and the tab order). */
function SimulationInert({ active, children }: { active: boolean; children: React.ReactNode }) {
  if (!active) return <>{children}</>;
  return (
    <div inert className="opacity-70" title="Disabled in simulation">
      {children}
    </div>
  );
}

/**
 * The optional personal step's controls: the same uploaders Settings uses
 * (they save at once, so nothing is lost across a page load) and the LinkedIn
 * employee-seat connection, which leaves for LinkedIn and comes back to
 * /onboarding, where the chat resumes from its saved draft.
 */
function ProfileControls({
  user,
  name,
  clientId,
  lang,
  simulated,
}: {
  user: Pick<AppUser, "name" | "photoURL" | "resumeUrl" | "linkedInConnected">;
  /** The name typed in the chat; the seat is created under it. */
  name: string;
  clientId: string;
  lang: ChatLang;
  simulated: boolean;
}) {
  const t: T = (key, vars) => tr(lang, key, vars);
  const [photoURL, setPhotoURL] = useState<string | null>(user.photoURL ?? null);
  const [resumeUrl, setResumeUrl] = useState<string | null>(user.resumeUrl ?? null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connectLinkedIn() {
    if (simulated) return;
    setError(null);
    setConnecting(true);
    try {
      // The seat is created under the user's stored name, so the one typed in
      // the chat is saved first (the rest of the answers wait for Finish).
      if (name.trim()) await saveOnboardingProfileAction({ name });
      const result = await ensureOwnEmployeeSeatAction();
      if ("error" in result) {
        setError(result.error);
        setConnecting(false);
        return;
      }
      window.location.assign(
        `/api/integrations/linkedin/employee/auth?clientId=${encodeURIComponent(clientId)}&seatId=${encodeURIComponent(result.seatId)}&returnTo=onboarding`,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("linkedinFailed"),
      );
      setConnecting(false);
    }
  }

  return (
    <SimulationInert active={simulated}>
      <div dir="ltr" className="space-y-4 rounded-[12px] border border-border bg-surface p-4">
        <AvatarUploader name={name || user.name || "You"} value={photoURL} onChange={setPhotoURL} />
        <ResumeUploader value={resumeUrl} onChange={setResumeUrl} />
        {user.linkedInConnected ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-3">
            <Icon name="CircleCheck" className="h-4 w-4 text-neon" />
            <p className="text-sm">{t("linkedinConnected")}</p>
            <Badge tone="neon" className="ml-auto">
              {t("connected")}
            </Badge>
          </div>
        ) : (
          <Button type="button" variant="outline" className="w-full" onClick={connectLinkedIn} loading={connecting}>
            {!connecting && <Icon name="LogIn" className="h-4 w-4" />}
            {t("connectLinkedin")}
          </Button>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </SimulationInert>
  );
}

/**
 * The accounts the client confirmed in the chat, on top of the cards: step 2
 * opens with "connect THESE", not a wall of every network.
 */
function ConfirmedAccounts({ answers, t }: { answers: ChatAnswers; t: T }) {
  const confirmed = HANDLE_PLATFORMS.filter((p) => answers.handles[p]);
  return (
    <div>
      <h2 className="text-base font-semibold">
        {confirmed.length ? t("connectConfirmed") : t("connectChannels")}
      </h2>
      <p className="mb-3 text-xs text-muted-2">
        {t("channelsHint")}
      </p>
      {confirmed.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {confirmed.map((p) => (
            <span
              key={p}
              dir="ltr"
              className="flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs"
            >
              <SocialPlatformMark platform={p} tone="brand" className="h-3.5 w-3.5" />
              {answers.handles[p]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
