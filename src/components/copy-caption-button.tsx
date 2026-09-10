"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { normalizeDashes } from "@/lib/text-utils";
import type { Asset } from "@/lib/types";

/**
 * The exact text a user needs on their clipboard to post by hand: the caption
 * plus the asset's hashtags. Shared so every copy affordance puts the SAME
 * thing on the clipboard - a card that copies hashtags and a modal that
 * doesn't is a silent trap when the phone is the posting surface.
 */
export function captionText(asset: Pick<Asset, "content" | "meta">): string {
  // meta is an untyped bag filled by webhooks and lab imports, so validate the
  // shape rather than trusting the cast - a malformed hashtags value must not
  // take the copy button down with it.
  const raw = asset.meta?.hashtags;
  const hashtags = (Array.isArray(raw) ? raw : []).filter(
    (h): h is string => typeof h === "string" && h.length > 0,
  );
  const content = normalizeDashes(asset.content);
  return hashtags.length ? `${content}\n\n${hashtags.map((h) => "#" + h).join(" ")}` : content;
}

/**
 * Copy `text` to the clipboard. The async Clipboard API needs a secure context
 * and isn't available on every mobile browser we're posting from, so fall back
 * to the execCommand path rather than failing silently.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    // Keep it off-screen but still selectable - display:none can't be selected.
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-9999px";
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

type Variant = "icon" | "full";

/**
 * One-tap "copy the caption so I can paste it into the app I'm posting from".
 *
 * `icon` - the compact affordance on a dense asset card.
 * `full` - a labelled button for the detail modal, which is the phone's main
 *          path into a post (the client Library opens on the calendar and taps
 *          through to the modal, so an icon-only control on the card alone left
 *          the primary flow with no copy at all).
 *
 * Both are 44px tall: the icon variant is a 32px box that used to sit flush
 * over the caption text, under the minimum comfortable touch target.
 */
export function CopyCaptionButton({
  asset,
  variant = "icon",
  className,
}: {
  asset: Pick<Asset, "content" | "meta">;
  variant?: Variant;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    const ok = await writeToClipboard(captionText(asset));
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), ok ? 1500 : 2500);
  }

  if (!asset.content) return null;

  const label = state === "copied" ? "Copied" : state === "failed" ? "Press and hold to copy" : "Copy caption";
  const icon = state === "copied" ? "Check" : state === "failed" ? "TriangleAlert" : "Copy";

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={copy}
        title={label}
        aria-label={label}
        // Visible & tappable by default (touch devices have no hover); on
        // hover-capable pointers it stays a subtle reveal on hover/focus.
        className={cn(
          "inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-surface text-muted-2 transition-opacity hover:text-foreground",
          "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-hover/caption:opacity-100",
          className,
        )}
      >
        <Icon
          name={icon}
          className={cn(
            "h-4 w-4",
            state === "copied" && "text-neon",
            state === "failed" && "text-warning",
          )}
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className={cn(
        "inline-flex h-11 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors",
        state === "copied"
          ? "border-neon/50 text-neon"
          : "border-border text-muted hover:border-border-strong hover:text-foreground",
        className,
      )}
    >
      <Icon
        name={icon}
        className={cn("h-3.5 w-3.5", state === "failed" && "text-warning")}
      />
      {label}
    </button>
  );
}
