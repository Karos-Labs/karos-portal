"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Card, Button, Input, Label, Textarea, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AvatarUploader } from "@/components/avatar-uploader";
import { ResumeUploader } from "@/components/resume-uploader";
import { OnboardingSocialsStep } from "@/components/onboarding-socials-step";
import { CLIENT_CATEGORY_MAX_LENGTH, clientCategoryValue, cn } from "@/lib/utils";
import {
  saveOnboardingProfileAction,
  ensureOwnEmployeeSeatAction,
  completeOnboardingAction,
} from "@/lib/actions/onboarding-actions";
import { integrationIsUsable } from "@/lib/integration-status";
import type { AppUser, Client } from "@/lib/types";
import type { IntegrationView } from "@/lib/integrations/sanitize";
import type { SeatView } from "@/components/linkedin-seats-workspace";

const STEPS = [
  { id: 1, label: "Personal Profile", icon: "User" },
  { id: 2, label: "Company Workspace", icon: "Building2" },
  { id: 3, label: "Social Channels", icon: "Share2" },
] as const;

function StepIndicator({ step }: { step: 1 | 2 | 3 | 4 }) {
  return (
    <div className="mb-8 flex items-center justify-center gap-3">
      {STEPS.map((s, i) => (
        <div key={s.id} className="flex items-center gap-3">
          <div className="flex flex-col items-center gap-1.5">
            <div
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors",
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
              {s.label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={cn("mb-4 h-px w-12 transition-colors", step > s.id ? "bg-neon/40" : "bg-border")} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Staff dry run of this exact wizard (admin account menu → "Simulate
 * onboarding"). The same screens render, but NOTHING leaves the browser: the
 * profile save, the LinkedIn seat + OAuth, the uploaders, the channel
 * connections and "Finish setup" all write to real records (the uploaders and
 * profile save would land on the ADMIN's own user document), so in a
 * simulation they are skipped or made inert and Finish shows what would have
 * been written instead of writing it.
 */
export interface OnboardingSimulation {
  /** Where "Exit simulation" goes. */
  exitHref: string;
  /** "new" = a blank company; otherwise the existing client being walked through. */
  mode: "new" | "existing";
}

export function OnboardingWizard({
  user,
  client,
  notice,
  integrations,
  oauthEnabledPlatforms,
  linkedinSeats,
  seatLimit,
  seatCost,
  simulation,
}: {
  user: AppUser;
  client: Client;
  notice?: string | null;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  linkedinSeats?: SeatView[];
  seatLimit?: number;
  seatCost?: number;
  simulation?: OnboardingSimulation;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [simulatedFinish, setSimulatedFinish] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [photoURL, setPhotoURL] = useState<string | null>(user.photoURL ?? null);
  const [resumeUrl, setResumeUrl] = useState<string | null>(user.resumeUrl ?? null);
  // Connecting redirects to LinkedIn and back (full page load), so this only ever
  // needs to reflect the freshly-fetched server prop - no local setter required.
  const linkedInConnected = !!user.linkedInConnected;

  const [clientName, setClientName] = useState(client.name);
  // The box says "Industry / niche" and always did; the FIELD behind it is
  // `category`, the one the client's own profile chip shows and edits. It used
  // to write the legacy `industry` instead, so a client answered this question
  // at signup and then found the chip in their sidebar still empty.
  const [category, setCategory] = useState(clientCategoryValue(client) ?? "");
  const [brandVoice, setBrandVoice] = useState(client.brandVoice ?? "");

  function goNext() {
    setError(null);
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (simulation) {
      setStep(2);
      return;
    }
    startTransition(async () => {
      try {
        await saveOnboardingProfileAction({ name, phone });
        setStep(2);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save your profile.");
      }
    });
  }

  function connectLinkedIn() {
    setError(null);
    if (simulation) {
      setError("Simulation: LinkedIn is not connected (it would create a seat and start OAuth).");
      return;
    }
    setConnecting(true);
    startTransition(async () => {
      try {
        await saveOnboardingProfileAction({ name, phone });
        const result = await ensureOwnEmployeeSeatAction();
        if ("error" in result) {
          setError(result.error);
          setConnecting(false);
          return;
        }
        window.location.href = `/api/integrations/linkedin/employee/auth?clientId=${encodeURIComponent(client.id)}&seatId=${encodeURIComponent(result.seatId)}&returnTo=onboarding`;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start LinkedIn connection.");
        setConnecting(false);
      }
    });
  }

  function goToSocials() {
    setError(null);
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (!clientName.trim()) {
      setError("Please enter your company name.");
      return;
    }
    setStep(3);
  }

  function finish() {
    setError(null);
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (!clientName.trim()) {
      setError("Please enter your company name.");
      return;
    }
    if (simulation) {
      setSimulatedFinish(true);
      return;
    }
    // No try/catch here: completeOnboardingAction redirects on success, and
    // `redirect()` throws by design (Next.js docs: must be called outside
    // try/catch) - catching around it risks swallowing the navigation.
    startTransition(() => completeOnboardingAction({ name, phone, clientName, category, brandVoice }));
  }

  return (
    <div className="animate-fade-up">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Karos CMO</h1>
        <p className="mt-1 text-sm text-muted">Let&apos;s get your workspace set up. It only takes a minute.</p>
      </div>

      {simulation && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-dashed border-border bg-surface-2 px-4 py-2.5 text-xs text-muted">
          <Icon name="FlaskConical" className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            Simulation ({simulation.mode === "new" ? "new company" : `existing client: ${client.name}`}). Nothing is
            saved, uploaded or connected.
          </span>
          <Link href={simulation.exitHref} className="font-medium text-foreground hover:underline">
            Exit
          </Link>
        </div>
      )}

      <StepIndicator step={simulatedFinish ? 4 : step} />

      {notice && (
        <div className="mb-4 rounded-md border border-border bg-surface-2 px-4 py-2.5 text-xs text-muted">
          {notice}
        </div>
      )}

      {simulation && simulatedFinish ? (
        <SimulationSummary
          simulation={simulation}
          profile={{ name, phone }}
          workspace={{ clientName, category, brandVoice }}
          connectedChannels={integrations.filter(integrationIsUsable).map((i) => i.platform)}
          onRestart={() => {
            setSimulatedFinish(false);
            setStep(1);
          }}
        />
      ) : (
      <Card key={step} className="animate-slide-in-right space-y-5">
        {step === 1 ? (
          <>
            <div>
              <h2 className="text-base font-semibold">Personal profile</h2>
              <p className="text-xs text-muted-2">Tell us who you are. This powers your AI-written voice.</p>
            </div>

            {/* Uploads write the signed-in user's record at once - in a
                simulation that is the admin's own profile. */}
            <SimulationInert active={!!simulation}>
              <AvatarUploader name={name || user.name} value={photoURL} onChange={setPhotoURL} />
            </SimulationInert>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="ob-name">Full name</Label>
                <Input id="ob-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="ob-phone">Phone (optional)</Label>
                <Input id="ob-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 000 0000" />
              </div>
            </div>

            <div>
              <Label>Resume / CV (optional)</Label>
              {/* F67: this used to claim the resume was "used to write LinkedIn
                  content in your authentic voice". It reaches no model - the
                  upload route stores a URL on the user record and the prompt
                  branch that once read it is gone - so the promise was for a
                  feature that does not exist. Same sentence the Settings card
                  already tells the truth with. */}
              <p className="mb-2 text-[11px] text-muted-2">
                Stored for your Karos team. They use it when writing your LinkedIn advocacy posts.
              </p>
              <SimulationInert active={!!simulation}>
                <ResumeUploader value={resumeUrl} onChange={setResumeUrl} />
              </SimulationInert>
            </div>

            <div>
              <Label>LinkedIn</Label>
              {linkedInConnected ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-3">
                  <Icon name="CircleCheck" className="h-4 w-4 text-neon" />
                  <p className="text-sm text-foreground">Your LinkedIn account is connected.</p>
                  <Badge tone="neon" className="ml-auto">Connected</Badge>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={connectLinkedIn}
                  loading={connecting}
                  disabled={connecting || isPending}
                >
                  {!connecting && <Icon name="LogIn" className="h-4 w-4" />}
                  Connect your LinkedIn
                </Button>
              )}
            </div>

            {error && <p className="text-xs text-danger">{error}</p>}

            <div className="flex justify-end pt-2">
              <Button onClick={goNext} loading={isPending && !connecting} disabled={isPending}>
                Next
                <Icon name="ArrowRight" className="h-4 w-4" />
              </Button>
            </div>
          </>
        ) : step === 2 ? (
          <>
            <div>
              <h2 className="text-base font-semibold">Company workspace</h2>
              <p className="text-xs text-muted-2">A few details so we can tailor your content strategy.</p>
            </div>

            <div>
              <Label htmlFor="ob-client-name">Company name</Label>
              <Input id="ob-client-name" value={clientName} onChange={(e) => setClientName(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="ob-category">Industry / niche</Label>
              <Input
                id="ob-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. B2B SaaS, fintech, healthcare"
                /* The cap the chip this fills is measured against, felt here
                   rather than discovered on save. */
                maxLength={CLIENT_CATEGORY_MAX_LENGTH}
              />
            </div>
            <div>
              <Label htmlFor="ob-brand-voice">Brand voice</Label>
              <Textarea
                id="ob-brand-voice"
                value={brandVoice}
                onChange={(e) => setBrandVoice(e.target.value)}
                className="min-h-[100px]"
                placeholder="Tone, vocabulary, rules for how your brand should sound…"
              />
            </div>

            {error && <p className="text-xs text-danger">{error}</p>}

            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(1)} disabled={isPending}>
                <Icon name="ArrowLeft" className="h-4 w-4" />
                Back
              </Button>
              <Button onClick={goToSocials} disabled={isPending}>
                Next
                <Icon name="ArrowRight" className="h-4 w-4" />
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* Every card here connects/disconnects a REAL client's channel. */}
            <SimulationInert active={!!simulation}>
              <OnboardingSocialsStep
                clientId={client.id}
                integrations={integrations}
                oauthEnabledPlatforms={oauthEnabledPlatforms}
                currentUserRole={user.role}
                linkedinSeats={linkedinSeats}
                seatLimit={seatLimit}
                seatCost={seatCost}
              />
            </SimulationInert>

            {error && <p className="text-xs text-danger">{error}</p>}

            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(2)} disabled={isPending}>
                <Icon name="ArrowLeft" className="h-4 w-4" />
                Back
              </Button>
              <Button onClick={finish} loading={isPending}>
                Finish setup
                <Icon name="CircleCheck" className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </Card>
      )}
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

/** Replaces the redirect to /dashboard at the end of a simulation. */
function SimulationSummary({
  simulation,
  profile,
  workspace,
  connectedChannels,
  onRestart,
}: {
  simulation: OnboardingSimulation;
  profile: { name: string; phone: string };
  workspace: { clientName: string; category: string; brandVoice: string };
  connectedChannels: string[];
  onRestart: () => void;
}) {
  const rows: [string, string][] = [
    ["Name", profile.name],
    ["Phone", profile.phone],
    ["Company name", workspace.clientName],
    ["Industry / niche", workspace.category],
    ["Brand voice", workspace.brandVoice],
    ["Connected channels", connectedChannels.join(", ")],
  ];
  return (
    <Card className="animate-slide-in-right space-y-5">
      <div>
        <h2 className="text-base font-semibold">Simulation finished</h2>
        <p className="text-xs text-muted-2">
          A real client would now be sent to Home. This is what &quot;Finish setup&quot; would have written.
        </p>
      </div>
      <dl className="divide-y divide-border rounded-md border border-border text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[140px_1fr] gap-3 px-4 py-2">
            <dt className="text-muted-2">{label}</dt>
            <dd dir="auto" className="whitespace-pre-wrap break-words">{value.trim() || <span className="text-muted-2">(empty)</span>}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="mb-1.5 text-xs font-medium">Then, in the background:</p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
          <li>hasCompletedOnboarding flips to true (the wizard never shows again)</li>
          <li>the Home &quot;Get set up&quot; ladder order is stored</li>
          <li>the Intel Report pipeline runs</li>
          <li>the Task Map swarm runs</li>
        </ul>
      </div>
      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" onClick={onRestart}>
          <Icon name="RotateCcw" className="h-4 w-4" />
          Run again
        </Button>
        <Link href={simulation.exitHref}>
          <Button>Exit simulation</Button>
        </Link>
      </div>
    </Card>
  );
}
