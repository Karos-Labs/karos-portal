import * as React from "react";
import { icons, type LucideProps } from "lucide-react";

/**
 * Render a lucide icon by name (icons are user-configurable on agents).
 * Falls back to a sparkles glyph when the name is unknown.
 */
export function Icon({ name, ...props }: { name: string } & LucideProps) {
  const Cmp = (icons as Record<string, React.ComponentType<LucideProps>>)[name] ?? icons.Sparkles;
  return <Cmp {...props} />;
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
