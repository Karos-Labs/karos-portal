"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Input, Label } from "@/components/ui";
import { Icon } from "@/components/icon";
import { submitClientRequestAction } from "@/lib/actions";

export default function RequestAccessPage() {
  const [companyName, setCompanyName] = useState("");
  const [website, setWebsite] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [useCase, setUseCase] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyName.trim() || !adminEmail.trim() || !useCase.trim()) {
      return setError("Company name, admin email, and use case are all required.");
    }
    setLoading(true);
    try {
      const result = await submitClientRequestAction({
        companyName,
        website,
        adminEmail,
        useCase,
      });
      if (result.ok) {
        setSubmitted(true);
      } else {
        setError(result.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-neon-soft neon-glow">
            <Icon name="Building2" className="h-6 w-6 text-neon" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Karos<span className="neon-text">CMO</span>
          </h1>
          <p className="mt-1 text-sm text-muted">Request access for your company.</p>
        </div>

        {submitted ? (
          <div className="card-grad rounded-[var(--radius)] border border-border p-6 text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neon-soft">
              <Icon name="CheckCircle" className="h-6 w-6 text-neon" />
            </div>
            <div>
              <p className="font-medium">Request received!</p>
              <p className="mt-1 text-sm text-muted">
                Our team will review your request and reach out to{" "}
                <span className="text-foreground">{adminEmail}</span> within 1–2 business days
                with your Client Access Key.
              </p>
            </div>
            <Link href="/login">
              <Button variant="subtle" className="w-full">
                Back to sign in
              </Button>
            </Link>
          </div>
        ) : (
          <div className="card-grad rounded-[var(--radius)] border border-border p-6">
            <p className="mb-5 text-sm text-muted">
              No access key yet? Tell us about your company and we&apos;ll set up your account
              and send you a key within 1–2 business days.
            </p>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <Label>Company name <span className="text-danger">*</span></Label>
                <Input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Acme Co"
                  required
                />
              </div>

              <div>
                <Label>Company website</Label>
                <Input
                  type="url"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://acmeco.com"
                />
              </div>

              <div>
                <Label>Your work email <span className="text-danger">*</span></Label>
                <Input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="you@acmeco.com"
                  required
                />
                <p className="mt-1 text-[11px] text-muted">
                  We&apos;ll send your access key here. You&apos;ll become the primary admin for
                  your company account.
                </p>
              </div>

              <div>
                <Label>How will you use KarosCMO? <span className="text-danger">*</span></Label>
                <textarea
                  value={useCase}
                  onChange={(e) => setUseCase(e.target.value)}
                  placeholder="e.g. We need to automate Instagram content for our retail brand and run weekly email campaigns…"
                  rows={3}
                  required
                  className="w-full rounded-[var(--radius-sm)] border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-2 focus:border-neon focus:outline-none resize-none"
                />
              </div>

              {error && <p className="text-xs text-danger">{error}</p>}

              <Button type="submit" loading={loading} disabled={loading} className="w-full">
                Submit request
              </Button>
            </form>

            <p className="mt-4 text-center text-[11px] text-muted-2">
              Already have an access key?{" "}
              <Link href="/login" className="text-neon hover:underline underline-offset-2">
                Sign up here →
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
