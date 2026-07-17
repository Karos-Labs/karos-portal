"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Label, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { sendSupportEmailAction } from "@/lib/actions";

/**
 * "Flag to the Karos team" affordance (SCRUM-52 fix 4): a prefilled support
 * dialog wired to the existing sendSupportEmailAction. Sender identity comes
 * from the session inside the action, so only subject/message cross the wire.
 * Dialog anatomy follows contact-us-modal.tsx.
 */
export function FlagButton({
  subject,
  message,
  label = "Flag to the Karos team",
}: {
  subject: string;
  message: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => firstFieldRef.current?.focus(), 50);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open]);

  function handleClose() {
    setOpen(false);
    setSuccess(false);
    setError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input = {
      subject: (fd.get("subject") as string).trim(),
      message: (fd.get("message") as string).trim(),
    };
    setError(null);
    startTransition(async () => {
      const result = await sendSupportEmailAction(input);
      if (result.ok) setSuccess(true);
      else setError(result.error ?? "Something went wrong.");
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md text-xs text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
      >
        <Icon name="Flag" className="h-3 w-3" />
        {label}
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}
            onClick={(e) => {
              if (e.target === e.currentTarget) handleClose();
            }}
          >
            <div
              className="relative w-full max-w-[480px] rounded-md border border-border bg-surface shadow-[0_12px_60px_rgba(0,0,0,0.8)]"
              role="dialog"
              aria-modal="true"
              aria-labelledby="seo-geo-flag-title"
            >
              <div className="flex items-center justify-between border-b border-border px-6 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/70">
                    <Icon name="Flag" className="h-4 w-4" />
                  </div>
                  <div>
                    <p id="seo-geo-flag-title" className="text-sm font-semibold text-foreground">
                      Flag to the Karos team
                    </p>
                    <p className="text-[11px] text-muted">We typically respond within 24 hours</p>
                  </div>
                </div>
                <button
                  onClick={handleClose}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/40"
                  aria-label="Close dialog"
                >
                  <Icon name="X" className="h-4 w-4" />
                </button>
              </div>

              <div className="px-6 py-5">
                {success ? (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full border border-foreground/10 bg-foreground/[0.04] text-foreground/70">
                      <Icon name="CheckCircle2" className="h-6 w-6" />
                    </div>
                    <p className="text-sm font-semibold text-foreground">Flag sent</p>
                    <p className="max-w-[280px] text-sm text-muted">
                      The Karos team has your note and will reply to your email.
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={handleClose}>
                      Close
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div>
                      <Label htmlFor="sg-flag-subject">Subject</Label>
                      <Input
                        ref={firstFieldRef}
                        id="sg-flag-subject"
                        name="subject"
                        defaultValue={subject}
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="sg-flag-message">Message</Label>
                      <Textarea
                        id="sg-flag-message"
                        name="message"
                        defaultValue={message}
                        placeholder="Tell us what looks off or what you'd like explained."
                        className="min-h-[120px]"
                        required
                        minLength={10}
                      />
                    </div>
                    {error && (
                      <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                        {error}
                      </p>
                    )}
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={isPending}>
                        Cancel
                      </Button>
                      <Button type="submit" size="sm" loading={isPending}>
                        {isPending ? "Sending…" : "Send to the team"}
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
