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
}

/**
 * Platform IDs that have an automated OAuth flow defined.
 * Derived from OAUTH_CONFIGS keys but kept here so client components can read
 * it without importing the server-only oauth.ts module.
 */
export const OAUTH_SUPPORTED_PLATFORM_IDS = new Set<string>([
  "linkedin",
  "facebook",
  "instagram",
  "twitter",
  "youtube",
]);

/**
 * Which platforms each asset type can be pushed to (auto cron or Publish Now).
 * Single source of truth — the publish cron, the asset card, and the schedule
 * form all read this map. Order matters: first connected match wins when a
 * platform has to be inferred.
 */
export const PUBLISHABLE_PLATFORMS: Record<string, string[]> = {
  instagram_post: ["instagram"],
  social_post: ["twitter", "linkedin", "facebook"],
  article: ["linkedin"],
  email: [],
  note: [],
};

/** Human-readable platform names for badges / pickers. */
export const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  twitter: "X (Twitter)",
  youtube: "YouTube",
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
  },
];
