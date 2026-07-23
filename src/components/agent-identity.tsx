import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

export type SocialPlatform = "instagram" | "x" | "tiktok" | "linkedin" | "reddit" | "facebook" | "youtube";

/**
 * Real platform logos (simple-icons paths, 24x24, currentColor) — the same
 * marks the karos-labs landing page hero uses, so an agent carries one
 * identity from the marketing site through the whole app.
 */
const PLATFORM_PATHS: Record<SocialPlatform, string> = {
  instagram:
    "M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.43.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.43.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.16-.43-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.43-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zM12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63c-.79.31-1.46.72-2.12 1.38C1.35 2.68.94 3.35.63 4.14.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91.31.79.72 1.46 1.38 2.12.66.66 1.33 1.08 2.12 1.38.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56.79-.31 1.46-.72 2.12-1.38.66-.66 1.08-1.33 1.38-2.12.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91-.31-.79-.72-1.46-1.38-2.12C21.32 1.35 20.65.94 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0zm0 5.84A6.16 6.16 0 1 0 12 18.16 6.16 6.16 0 0 0 12 5.84zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.4-10.85a1.44 1.44 0 1 0 0 2.88 1.44 1.44 0 0 0 0-2.88z",
  tiktok:
    "M12.53.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z",
  x: "M18.24 2.25h3.31l-7.23 8.26 8.5 11.24H16.17l-5.21-6.82L4.99 21.75H1.68l7.73-8.84L1.25 2.25H8.08l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z",
  reddit:
    "M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-6.994 4.87-3.865 0-6.994-2.176-6.994-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z",
  linkedin:
    "M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zm1.78 13.02H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z",
  facebook:
    "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647z",
  youtube:
    "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z M9.545 15.568V8.432L15.818 12l-6.273 3.568z",
};

const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  x: "X",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  facebook: "Facebook",
  youtube: "YouTube",
};

export function socialPlatformsFor(identity: string): SocialPlatform[] {
  const value = identity.toLowerCase();
  const platforms: SocialPlatform[] = [];
  if (/instagram|(^|[\s_-])ig([\s_-]|$)/.test(value)) platforms.push("instagram");
  if (/tiktok|tik[\s_-]?tok/.test(value)) platforms.push("tiktok");
  if (/(^|[\s_-])x([\s_-]|$)|twitter/.test(value)) platforms.push("x");
  if (/reddit/.test(value)) platforms.push("reddit");
  if (/linkedin|linked[\s_-]?in/.test(value)) platforms.push("linkedin");
  if (/facebook|(^|[\s_-])fb([\s_-]|$)/.test(value)) platforms.push("facebook");
  if (/youtube|(^|[\s_-])yt([\s_-]|$)/.test(value)) platforms.push("youtube");
  return platforms;
}

/** Platform-registry id → mark id (the registry still says "twitter"). */
export function platformForIntegrationId(id: string): SocialPlatform | null {
  if (id === "twitter") return "x";
  return id === "instagram" || id === "x" || id === "tiktok" || id === "linkedin" || id === "reddit" || id === "facebook" || id === "youtube"
    ? id
    : null;
}

/**
 * Non-social agents that appear in the landing page's channel row carry the
 * same lucide mark there and here. Checked only when no platform matched.
 */
function landingMarkFor(identity: string): string | null {
  const value = identity.toLowerCase();
  if (/landing/.test(value)) return "LayoutTemplate";
  if (/newsletter/.test(value)) return "Mail";
  if (/blog/.test(value)) return null; // "SEO-aware" blog taglines are not the SEO agent
  if (/seo|(^|[\s_-])geo([\s_-]|$)/.test(value)) return "Search";
  if (/rebrand/.test(value)) return "Sparkles";
  if (/short|video|clip/.test(value)) return "Video";
  return null;
}

export function SocialPlatformMark({ platform, className }: { platform: SocialPlatform; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d={PLATFORM_PATHS[platform]} />
    </svg>
  );
}

/**
 * The one mark for an agent, resolved from its identity string: the real
 * platform logo when the agent is a social agent, the landing-page mark for
 * the other channels, and the stored lucide icon as the fallback.
 */
export function AgentMark({ identity, icon, className }: { identity: string; icon?: string; className?: string }) {
  const platform = socialPlatformsFor(identity)[0];
  if (platform) return <SocialPlatformMark platform={platform} className={className} />;
  return <Icon name={landingMarkFor(identity) ?? icon ?? "Sparkles"} className={className} />;
}

/**
 * The agent avatar chip — the landing page hero treatment: the real mark in
 * light gray on a neutral dark rounded square. Agents spanning two platforms
 * (e.g. Instagram + TikTok social posts) stack both logos.
 */
export function AgentIdentity({
  identity,
  icon,
  size = "md",
  className,
}: {
  identity: string;
  icon?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const platforms = socialPlatformsFor(identity);
  const dimension = size === "sm" ? "h-8 w-8 rounded-lg" : "h-12 w-12 rounded-2xl";
  const markSize = size === "sm" ? "h-4 w-4" : "h-5 w-5";

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center border border-foreground/10 bg-foreground/[0.04] text-foreground/80",
        dimension,
        className,
      )}
    >
      {platforms.length > 1 ? (
        <div className="flex items-center -space-x-1.5">
          {platforms.slice(0, 2).map((platform) => (
            <span
              key={platform}
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-surface-2 text-foreground/80"
            >
              <SocialPlatformMark platform={platform} className="h-3 w-3" />
            </span>
          ))}
        </div>
      ) : (
        <AgentMark identity={identity} icon={icon} className={markSize} />
      )}
    </div>
  );
}

export function AgentPlatformBadges({ identity }: { identity: string }) {
  const platforms = socialPlatformsFor(identity);
  if (platforms.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label={`Platforms: ${platforms.map((p) => PLATFORM_LABEL[p]).join(", ")}`}>
      {platforms.map((platform) => (
        <span key={platform} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">
          <SocialPlatformMark platform={platform} className="h-3 w-3" />
          {PLATFORM_LABEL[platform]}
        </span>
      ))}
    </div>
  );
}
