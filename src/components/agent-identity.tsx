import type { CSSProperties } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

export type SocialPlatform = "instagram" | "x" | "tiktok" | "linkedin";

const PLATFORM_META: Record<SocialPlatform, { label: string; color: string }> = {
  instagram: { label: "Instagram", color: "#E85C9B" },
  x: { label: "X", color: "#A8A8AD" },
  tiktok: { label: "TikTok", color: "#5ED9D1" },
  linkedin: { label: "LinkedIn", color: "#5B9BD5" },
};

export function socialPlatformsFor(identity: string): SocialPlatform[] {
  const value = identity.toLowerCase();
  const platforms: SocialPlatform[] = [];
  if (/instagram|(^|[\s_-])ig([\s_-]|$)/.test(value)) platforms.push("instagram");
  if (/(^|[\s_-])x([\s_-]|$)|twitter/.test(value)) platforms.push("x");
  if (/tiktok|tik[\s_-]?tok/.test(value)) platforms.push("tiktok");
  if (/linkedin|linked[\s_-]?in/.test(value)) platforms.push("linkedin");
  return platforms;
}

export function SocialPlatformMark({ platform, className }: { platform: SocialPlatform; className?: string }) {
  if (platform === "instagram") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
        <rect x="3.25" y="3.25" width="17.5" height="17.5" rx="5.2" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="12" cy="12" r="4.05" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="17.45" cy="6.85" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  if (platform === "x") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
        <path d="M4.1 3.5h4.75l4.08 5.46 4.75-5.46h2.2l-5.92 6.98 6.34 8.02h-4.78l-4.4-5.89-5.02 5.89H3.9l6.18-7.39L4.1 3.5Zm3.55 1.7 8.71 11.6h1.95L9.59 5.2H7.65Z" />
      </svg>
    );
  }
  if (platform === "tiktok") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
        <path d="M14.2 3.2h2.85c.23 1.78 1.23 2.85 3.05 3.3v2.9a7.08 7.08 0 0 1-3.02-1.08v5.85a6.02 6.02 0 1 1-5.2-5.96v3.03a3.07 3.07 0 1 0 2.32 2.98V3.2Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M5.2 3.5A1.7 1.7 0 1 1 5.2 6.9a1.7 1.7 0 0 1 0-3.4ZM3.75 8.2h2.9v12.3h-2.9V8.2Zm5.05 0h2.78v1.68h.04c.78-1.47 2.67-2.24 4.22-2.24 4.02 0 4.76 2.65 4.76 6.1v6.76h-2.9v-6c0-1.43-.03-3.28-2.2-3.28-2.2 0-2.54 1.56-2.54 3.18v6.1H8.8V8.2Z" />
    </svg>
  );
}

export function AgentIdentity({
  identity,
  icon,
  color,
  size = "md",
  className,
}: {
  identity: string;
  icon: string;
  color: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const platforms = socialPlatformsFor(identity);
  const dimension = size === "sm" ? "h-8 w-8 rounded-md" : "h-12 w-12 rounded-lg";
  const markSize = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  const primary = platforms[0];
  const accent = primary ? PLATFORM_META[primary].color : color;
  const style = {
    "--agent-accent": accent,
    background: `color-mix(in srgb, ${accent} 14%, var(--surface-2))`,
    color: accent,
  } as CSSProperties;

  return (
    <div
      className={cn("relative flex shrink-0 items-center justify-center border border-white/[0.06] shadow-sm", dimension, className)}
      style={style}
    >
      {platforms.length > 1 ? (
        <div className="flex items-center -space-x-1.5">
          {platforms.slice(0, 2).map((platform) => (
            <span key={platform} className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-surface-2" style={{ color: PLATFORM_META[platform].color }}>
              <SocialPlatformMark platform={platform} className="h-3.5 w-3.5" />
            </span>
          ))}
        </div>
      ) : primary ? (
        <SocialPlatformMark platform={primary} className={markSize} />
      ) : (
        <Icon name={icon} className={markSize} />
      )}
    </div>
  );
}

export function AgentPlatformBadges({ identity }: { identity: string }) {
  const platforms = socialPlatformsFor(identity);
  if (platforms.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label={`Platforms: ${platforms.map((p) => PLATFORM_META[p].label).join(", ")}`}>
      {platforms.map((platform) => (
        <span key={platform} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">
          <SocialPlatformMark platform={platform} className="h-3 w-3" />
          {PLATFORM_META[platform].label}
        </span>
      ))}
    </div>
  );
}
