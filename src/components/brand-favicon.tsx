/* eslint-disable @next/next/no-img-element */

"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn, initials } from "@/lib/utils";
import { faviconUrl } from "@/lib/favicon";

/**
 * Brand avatar with a graceful fallback chain:
 *   explicit logo (`src`) → website favicon (`website`) → initials chip
 *   (when `name` given) → generic building glyph.
 *
 * One component for every brand surface — client switcher, clients grid,
 * competitor track, SEO/GEO comparison rows — so "always show the brand's
 * favicon when we know its website" holds everywhere by construction.
 *
 * `className` carries sizing/rounding shared by every state; `imgClassName`
 * adds image-only chrome (border, object-fit) that must not style the
 * initials fallback.
 */
export function BrandFavicon({
  src,
  website,
  name,
  accentColor = "#2dff9e",
  faviconSize = 32,
  className,
  imgClassName,
}: {
  /** Uploaded/explicit logo URL — tried first. */
  src?: string | null;
  /** Website whose favicon is used when no logo (or the logo 404s). */
  website?: string | null;
  /** Brand name — enables the initials fallback chip. */
  name?: string;
  /** Accent for the initials chip (client accent or theme neon). */
  accentColor?: string;
  /** Pixel size requested from the favicon service (retina: 2× render size). */
  faviconSize?: number;
  className?: string;
  imgClassName?: string;
}) {
  const candidates = [src?.trim() || null, faviconUrl(website, faviconSize)].filter(
    (s): s is string => !!s,
  );
  const [failedCount, setFailedCount] = useState(0);
  const current = failedCount < candidates.length ? candidates[failedCount] : null;

  if (current) {
    return (
      <img
        src={current}
        alt=""
        className={cn("shrink-0", className, imgClassName)}
        onError={() => setFailedCount((n) => n + 1)}
      />
    );
  }

  if (name?.trim()) {
    return (
      <span
        className={cn("flex shrink-0 select-none items-center justify-center font-semibold", className)}
        style={{ background: accentColor + "1f", color: accentColor }}
        aria-hidden
      >
        {initials(name)}
      </span>
    );
  }

  return (
    <span className={cn("flex shrink-0 items-center justify-center", className)} aria-hidden>
      <Icon name="Building2" className="h-3.5 w-3.5 text-muted-2" />
    </span>
  );
}
