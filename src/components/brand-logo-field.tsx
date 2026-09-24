"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { BRAND_LOGO_ACCEPT, BRAND_LOGO_HINT, checkBrandLogoFile } from "@/lib/brand-logo-file";

/**
 * The brand kit's logo control: the current logo, Upload/Replace, and a
 * two-step Remove.
 *
 * It writes through `/api/clients/[id]/logo` — the same route the settings
 * editor and the client's own profile panel use — which stores the file,
 * saves its https download URL as the client's `logoUrl`, and re-projects the
 * client into the engine workspace, so the file uploaded here is the logo on
 * the next post (`client/brand.json`'s `logoUrl`).
 *
 * The upload is immediate rather than part of the dialog's section Saves: the
 * route writes the record itself, and holding a file in a form until a Save
 * nobody associates with it is how an uploaded logo gets lost on Close.
 */
export function BrandLogoField({ clientId, logoUrl }: { clientId: string; logoUrl?: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(logoUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A refresh that delivers a different logo (another surface replaced it)
  // wins over what this control last knew. Adjusted during render, React's
  // pattern for state derived from a changed prop, not in an effect.
  const [seenProp, setSeenProp] = useState(logoUrl);
  if (seenProp !== logoUrl) {
    setSeenProp(logoUrl);
    setCurrent(logoUrl ?? "");
  }

  async function upload(file: File) {
    setError(null);
    // The route's own rules, checked before the bytes travel: a refusal here
    // costs nothing, one from the server costs the upload.
    const check = checkBrandLogoFile(file);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch(`/api/clients/${clientId}/logo`, { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !json.url) {
        setError(json.error ?? "Upload failed.");
        return;
      }
      setCurrent(json.url);
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Upload failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/logo`, { method: "DELETE" });
      if (!res.ok) {
        setError("Could not remove the logo.");
        return;
      }
      setCurrent("");
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Could not remove the logo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-border bg-white p-1.5">
          {current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current} alt="Current logo" className="h-full w-full object-contain" />
          ) : (
            <Icon name="Image" className="h-5 w-5 text-muted-2" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-foreground">{current ? "This logo goes on every post." : "No logo uploaded. Posts use the one on your website, if they can find it."}</p>
          <p className="mt-0.5 text-[11px] text-muted-2">{BRAND_LOGO_HINT}</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-border-strong disabled:opacity-50"
            >
              <Icon name={busy ? "Loader" : "Upload"} className={busy ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {busy ? "Working…" : current ? "Replace" : "Upload logo"}
            </button>
            {current && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={busy || confirming}
                className="text-xs text-muted transition-colors hover:text-danger disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={BRAND_LOGO_ACCEPT}
        className="sr-only"
        aria-label="Logo file"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      {confirming && (
        <div className="mt-2 rounded-[8px] border border-warning/30 bg-warning/10 px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-foreground">
            Remove the logo? Posts stop carrying this file from the next run, and you would need the original file to put it back.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="rounded-[6px] border border-warning/40 bg-warning/15 px-2.5 py-1 text-[11px] font-medium text-warning disabled:opacity-50"
            >
              Remove logo
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-[6px] border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
