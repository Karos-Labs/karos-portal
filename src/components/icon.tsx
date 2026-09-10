import * as React from "react";
import { icons, type LucideProps } from "lucide-react";

/**
 * Render a lucide icon by name (icons are user-configurable on agents).
 * Falls back to a sparkles glyph when the name is unknown.
 * Default stroke is 1.5 - thin, minimal line work across the whole app.
 */
export function Icon({ name, strokeWidth = 1.5, ...props }: { name: string } & LucideProps) {
  const Cmp = (icons as Record<string, React.ComponentType<LucideProps>>)[name];
  if (!Cmp && process.env.NODE_ENV !== "production" && !warned.has(name)) {
    // Loud in dev: the silent sparkle fallback hid 37 renamed icons across 24
    // files after a lucide major (QA F63) - including a cheerful sparkle beside
    // a red error message.
    warned.add(name);
    console.warn(`[Icon] unknown lucide icon "${name}" - falling back to Sparkles`);
  }
  const Resolved = Cmp ?? icons.Sparkles;
  return <Resolved strokeWidth={strokeWidth} {...props} />;
}

/** One warning per unknown name per session, not per render. */
const warned = new Set<string>();

/**
 * The X (Twitter) wordmark. lucide dropped brand glyphs, so the platform logo
 * is a hand-rolled SVG - a filled glyph, not a stroked icon, so it ignores the
 * stroke props the lucide icons take. Sized via className (h-/w-).
 */
export function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** The LinkedIn "in" glyph - same hand-rolled-brand-logo rule as XLogo. */
export function LinkedInLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125M7.119 20.452H3.555V9h3.564zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0z" />
    </svg>
  );
}

/** The Instagram glyph - same hand-rolled-brand-logo rule as XLogo. */
export function InstagramLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 1.366.062 2.633.336 3.608 1.311.975.975 1.249 2.242 1.311 3.608.058 1.266.07 1.646.07 4.85s-.012 3.584-.07 4.85c-.062 1.366-.336 2.633-1.311 3.608-.975.975-2.242 1.249-3.608 1.311-1.266.058-1.646.07-4.85.07s-3.584-.012-4.85-.07c-1.366-.062-2.633-.336-3.608-1.311-.975-.975-1.249-2.242-1.311-3.608-.058-1.266-.07-1.646-.07-4.85s.012-3.584.07-4.85c.062-1.366.336-2.633 1.311-3.608.975-.975 2.242-1.249 3.608-1.311 1.266-.058 1.646-.07 4.85-.07m0 1.802c-3.15 0-3.5.012-4.737.068-.94.043-1.68.19-2.223.733-.543.543-.69 1.283-.733 2.223-.056 1.237-.068 1.587-.068 4.737s.012 3.5.068 4.737c.043.94.19 1.68.733 2.223.543.543 1.283.69 2.223.733 1.237.056 1.587.068 4.737.068s3.5-.012 4.737-.068c.94-.043 1.68-.19 2.223-.733.543-.543.69-1.283.733-2.223.056-1.237.068-1.587.068-4.737s-.012-3.5-.068-4.737c-.043-.94-.19-1.68-.733-2.223-.543-.543-1.283-.69-2.223-.733-1.237-.056-1.587-.068-4.737-.068m0 3.064a5.135 5.135 0 1 1 0 10.27 5.135 5.135 0 0 1 0-10.27m0 1.802a3.333 3.333 0 1 0 0 6.666 3.333 3.333 0 0 0 0-6.666m6.538-2.043a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0" />
    </svg>
  );
}

/** The TikTok glyph - same hand-rolled-brand-logo rule as XLogo. */
export function TikTokLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M16.6 5.82a4.28 4.28 0 0 1-1.05-2.82h-3.1v12.2a2.59 2.59 0 1 1-1.84-2.48V9.55a5.7 5.7 0 1 0 4.94 5.65V8.9a7.32 7.32 0 0 0 4.28 1.37V7.17a4.28 4.28 0 0 1-3.23-1.35" />
    </svg>
  );
}

/** The Reddit glyph - same hand-rolled-brand-logo rule as XLogo. */
export function RedditLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 0C5.373 0 0 5.373 0 12c0 6.627 5.373 12 12 12s12-5.373 12-12c0-6.627-5.373-12-12-12m5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.983 0 1.777.795 1.777 1.777 0 .717-.429 1.333-1.03 1.615a3.1 3.1 0 0 1 .043.552c0 2.827-3.294 5.12-7.355 5.12-4.062 0-7.355-2.293-7.355-5.12 0-.187.015-.371.043-.552-.601-.282-1.03-.898-1.03-1.615 0-.982.794-1.777 1.777-1.777.477 0 .899.182 1.207.491 1.194-.856 2.85-1.418 4.674-1.488l.899-4.223a.532.532 0 0 1 .631-.411l2.986.63a1.25 1.25 0 0 1 1.124-.701zM8.235 12.79a1.25 1.25 0 0 0 0 2.498c.687 0 1.248-.561 1.248-1.249a1.25 1.25 0 0 0-1.248-1.249m7.53 0a1.25 1.25 0 0 0 0 2.498 1.25 1.25 0 0 0 0-2.498m-3.765 4.588c-.919 0-1.812-.043-2.671-.124a.34.34 0 0 0-.246.582c.796.796 2.05 1.184 2.917 1.184.867 0 2.121-.388 2.917-1.184a.34.34 0 0 0-.246-.582c-.859.081-1.752.124-2.671.124" />
    </svg>
  );
}

/**
 * The platform glyph for an engine agent, by its slug.
 *
 * lucide dropped brand glyphs, so a platform agent rendered with a lucide name
 * got a generic stand-in (Camera for Instagram, AtSign for X) - readable, but a
 * catalog this size is much faster to scan when the channel is its own logo.
 * Slug-keyed rather than icon-name-keyed on purpose: the control plane supplies
 * the icon name, and a rename there should not silently drop a logo.
 * Prefix-matched rather than slug-exact, so a channel's variants inherit its
 * logo without an entry each.
 *
 * An agent with no single channel (blog, landing, intel) renders `fallback` -
 * normally its control-plane lucide icon.
 *
 * `fallback` is a prop rather than something the caller decides by testing for
 * a logo first, because the obvious alternative - a `platformLogoFor(slug)`
 * returning the component so the caller can branch - is a component created
 * during render, which `react-hooks/static-components` rejects and which breaks
 * fast refresh's ability to track the component.
 */
export function PlatformLogo({
  slug,
  className,
  fallback = null,
}: {
  slug: string;
  className?: string;
  fallback?: React.ReactNode;
}) {
  if (slug.startsWith("instagram")) return <InstagramLogo className={className} />;
  if (slug.startsWith("linkedin")) return <LinkedInLogo className={className} />;
  if (slug.startsWith("x-")) return <XLogo className={className} />;
  if (slug.startsWith("tiktok")) return <TikTokLogo className={className} />;
  if (slug.startsWith("reddit")) return <RedditLogo className={className} />;
  return <>{fallback}</>;
}

/** A curated set of icons offered in the agent builder picker. */
export const AGENT_ICONS = [
  "Sparkles",
  "Camera",
  "Mail",
  "PenLine",
  "Search",
  "Megaphone",
  "AtSign",
  "Share2",
  "Globe",
  "Newspaper",
  "MessageSquare",
  "TrendingUp",
  "Video",
  "Bot",
  "Zap",
  "Hash",
  "FileText",
  "Aperture",
];
