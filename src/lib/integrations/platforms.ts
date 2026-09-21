/**
 * Admin-extensible platform registry.
 * Add a new entry here and it will automatically appear as a card on every
 * client's Integrations tab — no other changes required.
 *
 * AUDIENCE MARKERS. Every string-typed field in the two interfaces below carries
 * `@clientCopy`, `@staffCopy` or `@notCopy`, and the client-copy guard
 * (`client-copy-boundary.test.ts`) reads the markers off these declarations to
 * decide what to sweep. It FAILS CLOSED: a new string field with no marker turns
 * the guard red rather than being skipped, because "which audience reads this"
 * is a question only the person adding the field can answer — deriving it from
 * render sites is what let seven admin-only credential hints look like client
 * copy while the two lines a client actually reads went unnoticed.
 */

/**
 * Credential fields for the manual-setup accordion.
 *
 * Every string field here is `@staffCopy`: the ONLY render site is the "Manual
 * credentials" accordion inside `{isAdmin && …}` (integrations-tab.tsx). A client
 * never sees a token field, so these may keep naming developer portals, PKCE and
 * consent flows, and their spaced hyphens are an operator's own punctuation.
 */
export interface PlatformField {
  /** @notCopy Form state key. */
  key: string;
  /** @staffCopy */
  label: string;
  type: "text" | "password";
  /** @staffCopy */
  placeholder?: string;
  /** @staffCopy Helper text displayed below the input */
  hint?: string;
  required?: boolean;
}

export interface PlatformConfig {
  /** @notCopy Provider id — matches the stored integration document. */
  id: string;
  /** @clientCopy Rendered ungated in the card header and the "Add a channel" list. */
  name: string;
  /** @notCopy Lucide icon name — must exist in lucide-react */
  icon: string;
  /** @notCopy Brand hex color for the icon background tint */
  color: string;
  /** @clientCopy One-line description shown ungated on the card and in the picker. */
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
  /**
   * @notCopy Retired as a NEW connect option (superseded by another card, or
   * withdrawn) but kept in this array — not deleted — because
   * `sanitize.ts`/`integration-actions.ts` look up a still-connected client's
   * OWN integration by this id to know which credential fields are public vs
   * secret; deleting the entry outright silently blanks that lookup for anyone
   * already connected. `integrations-tab.tsx` hides the card from the grid
   * unless the client already has a stored integration for this id, so an
   * existing connection stays visible and manageable while nobody NEW is
   * offered it.
   */
  hidden?: boolean;
}

/**
 * Platform IDs that have an automated OAuth flow defined.
 * Derived from OAUTH_CONFIGS keys but kept here so client components can read
 * it without importing the server-only oauth.ts module.
 *
 * NOT EVERY OAUTH_CONFIGS KEY — "facebook" is one Karos Labs does not sell
 * (portal feedback round 2, 2026-09: "we don't work with Facebook"), so it is
 * off this list and off PLATFORM_REGISTRY, and nothing offers a client a
 * Connect button for it. The oauth.ts config and the publisher stay where they
 * are: an account already connected keeps working, and its scopes are still
 * covered by oauth-scopes.test.ts.
 */
export const OAUTH_SUPPORTED_PLATFORM_IDS = new Set<string>([
  "linkedin",
  "linkedin_community",
  "instagram_business",
  "twitter",
  "youtube",
  "tiktok",
]);

/**
 * Platforms that are read/analytics-only connections — never a publish
 * target. Used to hide the "Auto-publish scheduled content" toggle (which
 * would otherwise be a dead control) on their Integrations-tab card.
 */
export const READ_ONLY_PLATFORM_IDS = new Set<string>([
  "linkedin_community",
]);

/**
 * Platforms whose OAuth flow is fully built here but cannot yet be completed
 * because the PLATFORM has not approved the Karos Labs developer account.
 *
 * TikTok is blocked on TikTok verifying that account (call directive D2,
 * 27 Jul 2026). Offering a "Connect with TikTok" button in that state sends the
 * client into a popup that can only fail, so the card says pending verification
 * instead of pretending. DELETE THE ENTRY the day verification lands — nothing
 * else needs changing, the OAuth config is already complete.
 *
 * TEMPORARY — DEMO RECORDING ONLY (2026-09-20): tiktok removed from this set
 * so the real "Connect with TikTok" button shows up against prep (running
 * with the TikTok app's Sandbox client key/secret, not the real one) to
 * record the Login Kit + Content Posting API demo video TikTok's re-review
 * requires. This must NOT reach production before TikTok actually approves
 * the account — put "tiktok" back in this Set (or revert this commit) once
 * the demo is recorded and before this branch is promoted to prod.
 */
export const PENDING_VERIFICATION_PLATFORM_IDS = new Set<string>([]);

/**
 * Which platforms each asset type can be pushed to (auto cron or Publish Now).
 * Single source of truth — the publish cron, the asset card, and the schedule
 * form all read this map. Order matters: first connected match wins when a
 * platform has to be inferred.
 *
 * `social_post` DROPPED FACEBOOK (portal feedback round 2, 2026-09). It is a
 * target list, so a target we do not sell being on it means the auto-publish
 * cron could pick it as the inferred platform for a post nobody meant to send
 * there. `publishToFacebook` still exists for anything already connected — it
 * is simply no longer inferable.
 *
 * `instagram_post` DROPPED "instagram" (classic Facebook-Login) the same way,
 * 2026-09-20: it fails outright for any account with no linked Facebook Page —
 * confirmed live against Karos Labs' own account — and "instagram_business"
 * (Instagram Login, no Page required) supersedes it for every case that
 * matters, so a target that only sometimes works has no reason to stay
 * inferable. `publishToInstagram` stays for anything already connected.
 *
 * `social_post` APPENDED "youtube" last (2026-09-21, real upload landed in
 * `publishToYouTube`). Appended, not inserted ahead of "tiktok": a client
 * connected to both keeps inferring tiktok first, same as before this
 * change — the blind-guess case this ordering governs is narrow to begin
 * with, since every real scheduling path (the schedule form, bulk-upload,
 * the webhook's platform hint) stamps `asset.scheduledPlatform` explicitly
 * before either cron ever calls `inferPlatform`, and that field always wins
 * over this array (see both call sites: `asset.scheduledPlatform ??
 * inferPlatform(...)`). This list only gets reached for a post nobody
 * targeted at all.
 */
export const PUBLISHABLE_PLATFORMS: Record<string, string[]> = {
  instagram_post: ["instagram_business", "tiktok"],
  social_post: ["twitter", "linkedin", "tiktok", "youtube"],
  article: ["linkedin"],
  email: [],
  note: [],
};

/**
 * Human-readable platform names for badges / pickers. THE map for displaying a
 * provider id — never title-case an id at render, which is how the connected-
 * channels card printed "Linkedin" and "Youtube", misspelling both brands
 * (QA F122). Use `platformLabel()` so an unknown id still degrades sanely.
 */
export const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  instagram_business: "Instagram (direct login)",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  linkedin_community: "LinkedIn Company Page",
  twitter: "X (Twitter)",
  x: "X",
  youtube: "YouTube",
  tiktok: "TikTok",
  /** The OAuth "connect Reddit" integration was removed 2026-09-21 (it had no
   * reader anywhere in this repo) — this label stays so `platformLabel("reddit")`
   * still reads "Reddit" rather than the raw id anywhere it's asked for, same as
   * "facebook" and "google" below. Not to be confused with the still-live
   * Reddit content-drafting agent, which never went through this OAuth flow. */
  reddit: "Reddit",
  /** Legacy aggregate id for the Google OAuth connection (still in live data). */
  google: "Google",
  /** The manual-credentials-only "Instagram performance" card, removed from
   * PLATFORM_REGISTRY 2026-09-21 (confirmed dead: no OAuth flow, no caller of
   * either function it backed anywhere in src/ outside its own file and
   * tests). Kept here for the same reason `.facebook`/`.google` are: a client
   * whose admin set this up before the removal can still have an
   * `instagram_insights` `ClientIntegration` document in Firestore, and this
   * one line is what stops `platformLabel()` printing the raw id if that
   * document is ever read back through this map. It is a harmless fallback
   * string either way, which is why the same caution did not carry over to
   * `agent-identity.tsx`'s `platformForIntegrationId` — see that function's
   * comment for why a MARK is a different call than a LABEL. */
  instagram_insights: "Instagram performance",
};

/**
 * Display name for a provider id. Falls back to the id with underscores opened
 * up rather than a raw snake_case token, so an id added to the data before it
 * is added here never reaches a client as "google_business_profile".
 */
export function platformLabel(id: string): string {
  return PLATFORM_LABELS[id] ?? id.replace(/_/g, " ");
}

/**
 * The channel catalog — and it has TWO audiences, split by which render site
 * reads the field. Whoever edits an entry is editing one or the other.
 *
 * `name` and `description` are CLIENT copy. integrations-tab.tsx renders them
 * ungated in the "Add a channel" list and in every card header, on a page a
 * CLIENT_USER reaches (clients/[id]/settings) and inside the onboarding wizard
 * (onboarding-socials-step.tsx). So they follow the client copy rules: sentence
 * case, em dash, and no developer vocabulary — the Reddit and LinkedIn Company
 * Page lines both carried a spaced hyphen, and the latter also named the
 * "Community Management API", which is our integration problem and not a
 * description of what the client gets.
 *
 * `fields[].label / placeholder / hint` are OPERATOR copy. Their only render
 * site is the "Manual credentials" accordion, which is inside `{isAdmin && …}`
 * (integrations-tab.tsx) — a client never sees a token field, so those hints may
 * keep naming the LinkedIn Developer Portal, PKCE and consent flows. The
 * client-copy guard scopes itself by that gate rather than by field name, so
 * moving one of these into an ungated position brings it into scope.
 */
export const PLATFORM_REGISTRY: PlatformConfig[] = [
  /**
   * HIDDEN 2026-09-20 (`hidden: true` below) — not deleted, because a still-
   * connected client's `fields` are how `sanitize.ts`/`integration-actions.ts`
   * know `pageId` is public and `accessToken` is secret; see `PlatformConfig.hidden`.
   * `integrations-tab.tsx` only shows this card to a client who already has an
   * "instagram" integration document; nobody new is offered it.
   *
   * Retired for the same reason Facebook was dropped as a sellable channel: it
   * goes through Facebook Login and needs the client's Instagram professional
   * account linked to a Facebook Page, which fails outright for any account
   * that has none (confirmed live against Karos Labs' own account:
   * `owned_pages` → `[]`) — and it was ALSO a second Connect button for the
   * exact same platform "instagram_business" below already covers with no
   * Page requirement, which is what actually prompted retiring it: a client
   * should not have to connect Instagram twice to get one working channel.
   * Removed from `OAUTH_SUPPORTED_PLATFORM_IDS` and `PUBLISHABLE_PLATFORMS`
   * too. `publishToInstagram`/`PLATFORM_LABELS.instagram` stay — an account
   * already connected through it keeps working — it just is not offered again.
   */
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
    hidden: true,
  },
  /**
   * THE INSTAGRAM PUBLISH CARD OFFERED TO NEW CONNECTIONS, since 2026-09-20 —
   * see the "instagram" entry above for why its sibling is hidden rather than
   * gone.
   *
   * PUBLISHING HERE SINCE 2026-09-20 (Albert): this card used to be read-only
   * (category "analytics") on the reasoning that the agents' publish path
   * stayed on the Facebook-Login card and this existed only for the extra
   * account data ("instagram_business_basic", "instagram_business_manage_insights")
   * only the Instagram Login product grants. Albert asked for Karos Labs' own
   * account specifically to be publishable through the same auto-publish flow,
   * so `publishToInstagramBusiness` (publishers.ts) and "publishing" here
   * replaced that read-only stance. `instagram_business_content_publish` is
   * the scope that backs it (oauth.ts).
   */
  {
    id: "instagram_business",
    name: "Instagram (direct login)",
    icon: "Camera",
    color: "#E1306C",
    description:
      "Publish posts and get deeper account insights, even without a linked Facebook Page.",
    fields: [
      {
        key: "accessToken",
        label: "Instagram access token",
        type: "password",
        required: true,
        hint: "Long-lived token from Meta for Developers → Instagram API setup with Instagram login",
      },
    ],
    category: "publishing",
  },
  /* NO FACEBOOK ENTRY (portal feedback round 2, 2026-09: "throughout it all we
     can remove Facebook, we don't work with Facebook"). This array IS the
     Connect list — every card and every "Add a channel" row is one of these —
     so removing the entry is what takes the channel off the Integrations tab
     and out of the onboarding wizard. `PLATFORM_LABELS.facebook` stays: a
     client with a Facebook integration already in Firestore must still see it
     named rather than see the raw id. */
  /* NO "instagram_insights" ENTRY (removed 2026-09-21). It was a manual-
     credentials-only card ("Instagram performance": an admin typed in a
     client's Facebook Page ID so Karos Labs' shared System User token could
     read detailed media-level insights) with no OAuth flow and, confirmed by
     grep, no caller anywhere in src/ of either function it backed
     (`listRecentInstagramMedia`/`fetchInstagramMediaInsights`,
     instagram-insights.ts — both removed with it) outside their own tests.
     Unlike the "instagram" entry above, there is no still-connected client
     to keep this card visible for, so nothing here parallels `hidden: true`.
     `PLATFORM_LABELS.instagram_insights` stays regardless, one line, for the
     same legacy-data reason `.facebook`/`.google` do. */
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
        hint: "Found in your Company Page URL - the number after /company/",
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
      "Read company-page follower demographics and post analytics. A separate LinkedIn connection from personal posting.",
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
        hint: "Found in your Company Page URL - the number after /company/. Required before org-level reads work.",
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
        hint: "Required for long-lived access - obtained during the OAuth consent flow",
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
        hint: "Required for long-lived access - captured automatically during the OAuth consent flow",
      },
    ],
    category: "publishing",
  },
];
