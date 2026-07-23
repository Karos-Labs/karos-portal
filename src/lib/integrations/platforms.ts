/**
 * Admin-extensible platform registry.
 * Add a new entry here and it will automatically appear as a card on every
 * client's Integrations tab — no other changes required.
 */

export interface PlatformField {
  key: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  /** Helper text displayed below the input */
  hint?: string;
  required?: boolean;
}

export interface PlatformConfig {
  id: string;
  name: string;
  /** Lucide icon name — must exist in lucide-react */
  icon: string;
  /** Brand hex color for the icon background tint */
  color: string;
  /** One-line description shown on the card */
  description: string;
  /** Credential fields for manual setup */
  fields: PlatformField[];
  /**
   * Which Integrations-tab section this platform's card renders in —
   * "publishing" (agents post/schedule content there) vs "analytics" (read-only
   * performance data). Drives the grouped grid; add a category when adding a
   * new platform and it lands in the right section automatically.
   */
  category: "publishing" | "analytics";
}

/**
 * Platform IDs that have an automated OAuth flow defined.
 * Derived from OAUTH_CONFIGS keys but kept here so client components can read
 * it without importing the server-only oauth.ts module.
 */
export const OAUTH_SUPPORTED_PLATFORM_IDS = new Set<string>([
  "linkedin",
  "linkedin_community",
  "facebook",
  "instagram",
  "twitter",
  "youtube",
  "tiktok",
  "reddit",
  "google_search_console",
  "google_analytics",
  "google_business_profile",
]);

/**
 * Platforms that are read/analytics-only connections — never a publish
 * target. Used to hide the "Auto-publish scheduled content" toggle (which
 * would otherwise be a dead control) on their Integrations-tab card.
 */
export const READ_ONLY_PLATFORM_IDS = new Set<string>([
  "linkedin_community",
  "reddit",
  "google_search_console",
  "google_analytics",
  "google_business_profile",
]);

/**
 * The four real platform ids the "Connect All Google Services" unified OAuth
 * flow (provider id "google_unified" in oauth.ts) fans its single token pair
 * out into. "google_unified" itself is never a stored ClientIntegration or a
 * PLATFORM_REGISTRY card — it's a one-click convenience over these four.
 */
export const GOOGLE_UNIFIED_SUB_PLATFORM_IDS = ["youtube", "google_search_console", "google_analytics", "google_business_profile"] as const;

/**
 * The subset of the above that's read-only analytics (excludes YouTube, which
 * keeps its own standalone card since it's also a publish target). The
 * Integrations tab merges these three into a single "Google Services Suite"
 * card instead of three separate ones — this is the list that merge uses.
 */
export const GOOGLE_READ_ONLY_SUB_PLATFORM_IDS = ["google_search_console", "google_analytics", "google_business_profile"] as const;

/**
 * Which platforms each asset type can be pushed to (auto cron or Publish Now).
 * Single source of truth — the publish cron, the asset card, and the schedule
 * form all read this map. Order matters: first connected match wins when a
 * platform has to be inferred.
 */
export const PUBLISHABLE_PLATFORMS: Record<string, string[]> = {
  instagram_post: ["instagram", "tiktok"],
  social_post: ["twitter", "linkedin", "facebook", "tiktok"],
  article: ["linkedin"],
  email: [],
  note: [],
};

/** Human-readable platform names for badges / pickers. */
export const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  linkedin_community: "LinkedIn Company Page",
  twitter: "X (Twitter)",
  youtube: "YouTube",
  tiktok: "TikTok",
};

export const PLATFORM_REGISTRY: PlatformConfig[] = [
  {
    id: "instagram",
    name: "Instagram",
    icon: "Camera",
    color: "#E1306C",
    description: "Publish posts, carousels, and Reels automatically.",
    fields: [
      {
        key: "accessToken",
        label: "Page Access Token",
        type: "password",
        required: true,
        hint: "Long-lived token from Meta for Developers → Graph API Explorer",
      },
      {
        key: "pageId",
        label: "Instagram Business Account ID",
        type: "text",
        required: true,
        placeholder: "17841...",
        hint: "Found under Instagram settings → Professional account → Account ID",
      },
    ],
    category: "publishing",
  },
  {
    id: "facebook",
    name: "Facebook",
    icon: "Share2",
    color: "#1877F2",
    description: "Post updates and campaigns to your Facebook Page.",
    fields: [
      {
        key: "accessToken",
        label: "Page Access Token",
        type: "password",
        required: true,
        hint: "Generate a long-lived Page token via the Graph API Explorer",
      },
      {
        key: "pageId",
        label: "Page ID",
        type: "text",
        required: true,
        placeholder: "123456789",
        hint: "Found in your Facebook Page settings → About → Page transparency",
      },
    ],
    category: "publishing",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    icon: "Briefcase",
    color: "#0A66C2",
    description: "Share thought-leadership content and company updates.",
    fields: [
      {
        key: "accessToken",
        label: "OAuth Access Token",
        type: "password",
        required: true,
        hint: "Generate via LinkedIn Developer Portal → OAuth 2.0 Tools",
      },
      {
        key: "organizationId",
        label: "Organization URN",
        type: "text",
        placeholder: "urn:li:organization:12345",
        hint: "Found in your Company Page URL — the number after /company/",
      },
    ],
    category: "publishing",
  },
  {
    id: "linkedin_community",
    name: "LinkedIn Company Page",
    icon: "Building2",
    color: "#0A66C2",
    description:
      "Read company-page follower demographics and post analytics — a separate LinkedIn app from personal posting (Community Management API).",
    fields: [
      {
        key: "accessToken",
        label: "OAuth Access Token",
        type: "password",
        required: true,
        hint: "Generate via the LinkedIn Developer Portal → the Community Management API app (a different app than the one above)",
      },
      {
        key: "refreshToken",
        label: "Refresh Token",
        type: "password",
        hint: "Captured automatically during the OAuth consent flow",
      },
      {
        key: "organizationId",
        label: "Organization URN",
        type: "text",
        required: true,
        placeholder: "urn:li:organization:12345",
        hint: "Found in your Company Page URL — the number after /company/. Required before org-level reads work.",
      },
    ],
    category: "analytics",
  },
  {
    id: "twitter",
    name: "X (Twitter)",
    icon: "AtSign",
    color: "#000000",
    description: "Schedule and publish posts to your X account.",
    fields: [
      {
        key: "accessToken",
        label: "OAuth 2.0 Bearer Token",
        type: "password",
        required: true,
        hint: "Generate via the X Developer Portal → OAuth 2.0 Tools, or reconnect via Connect above",
      },
    ],
    category: "publishing",
  },
  {
    id: "youtube",
    name: "YouTube",
    icon: "Video",
    color: "#FF0000",
    description: "Upload videos and manage your YouTube channel.",
    fields: [
      {
        key: "accessToken",
        label: "OAuth Access Token",
        type: "password",
        required: true,
        hint: "Generate via Google Cloud Console → APIs → YouTube Data API v3",
      },
      {
        key: "refreshToken",
        label: "Refresh Token",
        type: "password",
        hint: "Required for long-lived access — obtained during the OAuth consent flow",
      },
      {
        key: "channelId",
        label: "Channel ID",
        type: "text",
        placeholder: "UC...",
        hint: "Found in YouTube Studio → Settings → Channel → Advanced settings",
      },
    ],
    category: "publishing",
  },
  {
    id: "tiktok",
    name: "TikTok",
    icon: "Video",
    color: "#000000",
    description: "Publish short-form videos to your TikTok account.",
    fields: [
      {
        key: "accessToken",
        label: "OAuth Access Token",
        type: "password",
        required: true,
        hint: "Connect via the button above, or paste a token from the TikTok Developer Portal → Content Posting API",
      },
      {
        key: "refreshToken",
        label: "Refresh Token",
        type: "password",
        hint: "Required for long-lived access — captured automatically during the OAuth consent flow",
      },
    ],
    category: "publishing",
  },
  {
    id: "reddit",
    name: "Reddit",
    icon: "MessageSquare",
    color: "#FF4500",
    description: "Read account history, karma, and thread activity (draft-first — never auto-posts).",
    fields: [
      {
        key: "accessToken",
        label: "OAuth Access Token",
        type: "password",
        required: true,
        hint: "Connect via the button above, or paste a token from a Reddit app at reddit.com/prefs/apps",
      },
      {
        key: "refreshToken",
        label: "Refresh Token",
        type: "password",
        hint: "Captured automatically during the OAuth consent flow (duration=permanent)",
      },
    ],
    category: "analytics",
  },
  {
    id: "google_search_console",
    name: "Google Search Console",
    icon: "Search",
    color: "#4285F4",
    description: "Read search queries, clicks, impressions, and position for the client's site.",
    fields: [
      {
        key: "accessToken",
        label: "OAuth Access Token",
        type: "password",
        required: true,
        hint: "Generate via Google Cloud Console (Search Console API enabled on this project)",
      },
      {
        key: "refreshToken",
        label: "Refresh Token",
        type: "password",
        hint: "Required for long-lived access — captured automatically during the OAuth consent flow",
      },
      {
        key: "siteUrl",
        label: "Search Console Property",
        type: "text",
        placeholder: "https://example.com/ or sc-domain:example.com",
        hint: "Must match a property this Google account is verified on in Search Console",
      },
    ],
    category: "analytics",
  },
  {
    id: "google_analytics",
    name: "Google Analytics",
    icon: "BarChart3",
    color: "#E37400",
    description: "Read sessions, conversions, and AI-referral traffic from the client's GA4 property.",
    fields: [
      {
        key: "accessToken",
        label: "OAuth Access Token",
        type: "password",
        required: true,
        hint: "Generate via Google Cloud Console (Analytics Data API enabled on this project)",
      },
      {
        key: "refreshToken",
        label: "Refresh Token",
        type: "password",
        hint: "Required for long-lived access — captured automatically during the OAuth consent flow",
      },
      {
        key: "propertyId",
        label: "GA4 Property ID",
        type: "text",
        placeholder: "properties/123456789",
        hint: "Found in GA4 Admin → Property Settings. This account needs Viewer access on it.",
      },
    ],
    category: "analytics",
  },
  {
    id: "google_business_profile",
    name: "Google Business Profile",
    icon: "MapPin",
    color: "#4285F4",
    description: "Read the client's local listing performance (local clients only).",
    fields: [
      {
        key: "accessToken",
        label: "OAuth Access Token",
        type: "password",
        required: true,
        hint: "Requires Google's Business Profile API access request to be approved for this project first",
      },
      {
        key: "refreshToken",
        label: "Refresh Token",
        type: "password",
        hint: "Required for long-lived access — captured automatically during the OAuth consent flow",
      },
      {
        key: "locationId",
        label: "Business Profile Location ID",
        type: "text",
        placeholder: "locations/123456789",
        hint: "Found via the Business Profile API accounts.locations.list call",
      },
    ],
    category: "analytics",
  },
];
