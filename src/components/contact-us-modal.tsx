"use client";

import { useState, useEffect, useTransition, useRef } from "react";
import { Headphones, X, CheckCircle } from "lucide-react";
import { Button, Input, Textarea, Label } from "@/components/ui";
import { sendSupportEmailAction } from "@/lib/actions";

export function ContactUsButton() {
  const [open, setOpen] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Lock body scroll and handle Escape key when open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    document.addEventListener("keydown", onKey);
    // Focus first field after open animation settles
    const t = setTimeout(() => firstFieldRef.current?.focus(), 50);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleClose() {
    setOpen(false);
    setSuccess(false);
    setError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input = {
      name: (fd.get("name") as string).trim(),
      email: (fd.get("email") as string).trim(),
      subject: (fd.get("subject") as string).trim(),
      message: (fd.get("message") as string).trim(),
    };
    setError(null);
    startTransition(async () => {
      const result = await sendSupportEmailAction(input);
      if (result.ok) {
        setSuccess(true);
      } else {
        setError(result.error ?? "Something went wrong.");
      }
    });
  }

  return (
    <>
      {/* Trigger button — matches ThemeToggle / NotificationBell sizing */}
      <button
        onClick={() => setOpen(true)}
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-muted transition-all duration-150 hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/40"
        aria-label="Contact support"
        title="Contact us"
      >
        <Headphones className="h-[18px] w-[18px]" />
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          {/* Dialog card */}
          <div
            className="relative w-full max-w-[480px] rounded-[16px] border border-border bg-surface shadow-[0_12px_60px_rgba(0,0,0,0.8)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="support-dialog-title"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-neon-soft text-neon shadow-[0_0_14px_-4px_rgba(45,255,158,0.4)]">
                  <Headphones className="h-4 w-4" />
                </div>
                <div>
                  <p id="support-dialog-title" className="text-sm font-semibold text-foreground">
                    Contact Support
                  </p>
                  <p className="text-[11px] text-muted">We typically respond within 24 hours</p>
                </div>
              </div>
              <button
                onClick={handleClose}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/40"
                aria-label="Close dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5">
              {success ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neon-soft text-neon shadow-[0_0_20px_-4px_rgba(45,255,158,0.4)]">
                    <CheckCircle className="h-6 w-6" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">Message sent!</p>
                  <p className="text-sm text-muted max-w-[280px]">
                    Your message is on its way. We&apos;ll reply directly to your email.
                  </p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={handleClose}>
                    Close
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="cs-name">Your name</Label>
                      <Input
                        ref={firstFieldRef}
                        id="cs-name"
                        name="name"
                        placeholder="Jane Smith"
                        autoComplete="name"
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="cs-email">Your email</Label>
                      <Input
                        id="cs-email"
                        name="email"
                        type="email"
                        placeholder="jane@company.com"
                        autoComplete="email"
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="cs-subject">Subject</Label>
                    <Input
                      id="cs-subject"
                      name="subject"
                      placeholder="What can we help with?"
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="cs-message">Message</Label>
                    <Textarea
                      id="cs-message"
                      name="message"
                      placeholder="Describe your issue or question in as much detail as you like…"
                      className="min-h-[120px]"
                      required
                    />
                  </div>
                  {error && (
                    <p className="rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                      {error}
                    </p>
                  )}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={isPending}>
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" loading={isPending}>
                      {isPending ? "Sending…" : "Send message"}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
