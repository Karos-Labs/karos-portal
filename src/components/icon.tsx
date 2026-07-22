import * as React from "react";
import { icons, type LucideProps } from "lucide-react";

/**
 * Render a lucide icon by name (icons are user-configurable on agents).
 * Falls back to a sparkles glyph when the name is unknown.
 * Default stroke is 1.5 — thin, minimal line work across the whole app.
 */
export function Icon({ name, strokeWidth = 1.5, ...props }: { name: string } & LucideProps) {
  const Cmp = (icons as Record<string, React.ComponentType<LucideProps>>)[name] ?? icons.Sparkles;
  return <Cmp strokeWidth={strokeWidth} {...props} />;
}

/**
 * The X (Twitter) wordmark. lucide dropped brand glyphs, so the platform logo
 * is a hand-rolled SVG — a filled glyph, not a stroked icon, so it ignores the
 * stroke props the lucide icons take. Sized via className (h-/w-).
 */
export function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
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
