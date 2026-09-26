"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { SocialPlatformMark } from "@/components/agent-identity";
import { OnboardingSocialsStep } from "@/components/onboarding-socials-step";
import { cn } from "@/lib/utils";
import { OnboardingChat } from "./onboarding-chat";
import { HANDLE_PLATFORMS, type ChatAnswers, type ChatLang } from "./script";
import type { Role } from "@/lib/types";
import type { IntegrationView } from "@/lib/integrations/sanitize";
import type { SeatView } from "@/components/linkedin-seats-workspace";

/**
 * The redesigned onboarding (PROTOTYPE): two steps under the same wizard bar -
 * a conversation, then the channel cards. Mounted only by the admin
 * simulation, so nothing here writes: the chat keeps its answers in memory and
 * the channel cards are inert.
 */

const STEPS = [
  { id: 1, label: "About you", he: "עליכם", icon: "MessagesSquare" },
  { id: 2, label: "Your channels", he: "הרשתות", icon: "Share2" },
] as const;

export function OnboardingChatWizard({
  clientId,
  seed,
  mode,
  exitHref,
  integrations,
  oauthEnabledPlatforms,
  currentUserRole,
  linkedinSeats,
  seatLimit,
  seatCost,
}: {
  clientId: string;
  seed: Partial<ChatAnswers>;
  mode: "new" | "existing";
  exitHref: string;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  currentUserRole: Role;
  linkedinSeats?: SeatView[];
  seatLimit?: number;
  seatCost?: number;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [answers, setAnswers] = useState<ChatAnswers | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [lang, setLang] = useState<ChatLang>("en");
  const he = lang === "he";

  return (
    <div className="animate-fade-up">
      <div className="mb-4 flex items-center gap-2 rounded-md border border-dashed border-border bg-surface-2 px-4 py-2.5 text-xs text-muted">
        <Icon name="FlaskConical" className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          Prototype flow ({mode === "new" ? "new company" : "existing client"}). Website detection is simulated;
          nothing is saved or connected.
        </span>
        <Link href={exitHref} className="font-medium text-foreground hover:underline">
          Exit
        </Link>
      </div>

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
                {he ? s.he : s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn("mb-4 h-px w-16 transition-colors", step > s.id ? "bg-neon/40" : "bg-border")} />
            )}
          </div>
        ))}
      </div>

      {step === 1 && (
        <OnboardingChat
          key={chatKey}
          seed={seed}
          onLanguageChange={setLang}
          onComplete={(a) => {
            setAnswers(a);
            setStep(2);
          }}
        />
      )}

      {step === 2 && answers && (
        <Card className="animate-slide-in-right space-y-5">
          <ConfirmedAccounts answers={answers} />
          <div inert className="opacity-70" title="Disabled in simulation">
            <OnboardingSocialsStep
              clientId={clientId}
              integrations={integrations}
              oauthEnabledPlatforms={oauthEnabledPlatforms}
              currentUserRole={currentUserRole}
              linkedinSeats={linkedinSeats}
              seatLimit={seatLimit}
              seatCost={seatCost}
            />
          </div>
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setStep(1)}>
              <Icon name="ArrowLeft" className="h-4 w-4" />
              Back
            </Button>
            <Button onClick={() => setStep(3)}>
              Finish setup
              <Icon name="CircleCheck" className="h-4 w-4" />
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card className="animate-slide-in-right space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neon/15 text-neon">
            <Icon name="CircleCheck" className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Simulation finished</h2>
            <p className="text-xs text-muted-2">
              A real client would land on Home now, with the Intel Report and Task Map building in the background.
            </p>
          </div>
          <div className="flex justify-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setAnswers(null);
                setChatKey((k) => k + 1);
                setStep(1);
              }}
            >
              <Icon name="RotateCcw" className="h-4 w-4" />
              Run again
            </Button>
            <Link href={exitHref}>
              <Button>Exit simulation</Button>
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * The accounts the client confirmed in the chat, on top of the cards: step 2
 * opens with "connect THESE", not a wall of every network.
 */
function ConfirmedAccounts({ answers }: { answers: ChatAnswers }) {
  const confirmed = HANDLE_PLATFORMS.filter((p) => answers.handles[p]);
  if (confirmed.length === 0) return null;
  return (
    <div>
      <h2 className="text-base font-semibold">Connect the accounts you confirmed</h2>
      <p className="mb-3 text-xs text-muted-2">
        Once connected we check the account matches the handle you confirmed.
      </p>
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
    </div>
  );
}
