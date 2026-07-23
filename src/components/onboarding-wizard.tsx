"use client";

import { useState, useTransition } from "react";
import { Card, Button, Input, Label, Textarea, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AvatarUploader } from "@/components/avatar-uploader";
import { ResumeUploader } from "@/components/resume-uploader";
import { OnboardingSocialsStep } from "@/components/onboarding-socials-step";
import { cn } from "@/lib/utils";
import {
  saveOnboardingProfileAction,
  ensureOwnEmployeeSeatAction,
  completeOnboardingAction,
} from "@/lib/actions/onboarding-actions";
import type { AppUser, Client } from "@/lib/types";
import type { IntegrationView } from "@/lib/integrations/sanitize";
import type { SeatView } from "@/components/linkedin-seats-workspace";

const STEPS = [
  { id: 1, label: "Personal Profile", icon: "User" },
  { id: 2, label: "Company Workspace", icon: "Building2" },
  { id: 3, label: "Social Channels", icon: "Share2" },
] as const;

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
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

export function OnboardingWizard({
  user,
  client,
  notice,
  integrations,
  oauthEnabledPlatforms,
  linkedinSeats,
  seatLimit,
  seatCost,
}: {
  user: AppUser;
  client: Client;
  notice?: string | null;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  linkedinSeats?: SeatView[];
  seatLimit?: number;
  seatCost?: number;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [photoURL, setPhotoURL] = useState<string | null>(user.photoURL ?? null);
  const [resumeUrl, setResumeUrl] = useState<string | null>(user.resumeUrl ?? null);
  // Connecting redirects to LinkedIn and back (full page load), so this only ever
  // needs to reflect the freshly-fetched server prop — no local setter required.
  const linkedInConnected = !!user.linkedInConnected;

  const [clientName, setClientName] = useState(client.name);
  const [industry, setIndustry] = useState(client.industry ?? "");
  const [brandVoice, setBrandVoice] = useState(client.brandVoice ?? "");

  function goNext() {
    setError(null);
    if (!name.trim()) {
      setError("Please enter your name.");
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
    // No try/catch here: completeOnboardingAction redirects on success, and
    // `redirect()` throws by design (Next.js docs: must be called outside
    // try/catch) — catching around it risks swallowing the navigation.
    startTransition(() => completeOnboardingAction({ name, phone, clientName, industry, brandVoice }));
  }

  return (
    <div className="animate-fade-up">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Karos CMO</h1>
        <p className="mt-1 text-sm text-muted">Let&apos;s get your workspace set up — it only takes a minute.</p>
      </div>

      <StepIndicator step={step} />

      {notice && (
        <div className="mb-4 rounded-md border border-border bg-surface-2 px-4 py-2.5 text-xs text-muted">
          {notice}
        </div>
      )}

      <Card key={step} className="animate-slide-in-right space-y-5">
        {step === 1 ? (
          <>
            <div>
              <h2 className="text-base font-semibold">Personal profile</h2>
              <p className="text-xs text-muted-2">Tell us who you are — this powers your AI-written voice.</p>
            </div>

            <AvatarUploader name={name || user.name} value={photoURL} onChange={setPhotoURL} />

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
              <p className="mb-2 text-[11px] text-muted-2">
                Used to write LinkedIn content in your authentic voice.
              </p>
              <ResumeUploader value={resumeUrl} onChange={setResumeUrl} />
            </div>

            <div>
              <Label>LinkedIn</Label>
              {linkedInConnected ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-3">
                  <Icon name="CheckCircle" className="h-4 w-4 text-neon" />
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
              <Label htmlFor="ob-industry">Industry / niche</Label>
              <Input id="ob-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. B2B SaaS, fintech, healthcare" />
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
            <OnboardingSocialsStep
              clientId={client.id}
              integrations={integrations}
              oauthEnabledPlatforms={oauthEnabledPlatforms}
              currentUserRole={user.role}
              linkedinSeats={linkedinSeats}
              seatLimit={seatLimit}
              seatCost={seatCost}
            />

            {error && <p className="text-xs text-danger">{error}</p>}

            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => setStep(2)} disabled={isPending}>
                <Icon name="ArrowLeft" className="h-4 w-4" />
                Back
              </Button>
              <Button onClick={finish} loading={isPending}>
                Finish setup
                <Icon name="CheckCircle" className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
