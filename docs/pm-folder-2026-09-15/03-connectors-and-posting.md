# Connectors and posting

Status: draft 2026-09-15 · Owner: Albert · Changes when: a platform changes its API or policy, an approval lands, or a decision in 05 changes. Researched 2026-09-15 from the platforms' own developer documentation and policy pages; each claim carries its source date. Repo facts carry a file and line.

## 1. The rule

We do not sell Facebook (D26). "Meta" here means Instagram, which publishes and reports through Meta's platform, with Threads as a later follow-on. Every post is approved by the client before it goes out (Reddit: a human always posts, D25). "Autopilot" means an approved calendar post publishes at its slot without a second look. It is a switch per client per platform with three levels:

| Level | What happens | Who can have it |
|---|---|---|
| Manual | We deliver; the client posts from the platform (copy and paste, or a one-click share link) | Every platform |
| Connected, manual | The client connects the account; the portal posts when the client presses Publish | Platforms whose API allows posting on the business's own account |
| Autopilot | The client connects the account and switches autopilot on; approved calendar posts publish at their slot | Only where the platform's terms allow unattended posting, with the platform's consent rules met |

## 2. Per platform: what the API allows

**Instagram (Meta Graph API)**
- Post via API: yes. Client needs a professional account (Business for Stories) linked to a Facebook Page on the login path we use, and grants the scopes at connect.
- Karos needs Business Verification and App Review for Advanced Access (`instagram_content_publish`, `instagram_manage_insights`, `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`). Until then only users with a role on our app can connect.
- Formats: image, video, Reels, Stories, carousel up to 10. Limits: 50 API posts per 24 h (Meta's docs also say 100), 400 containers per 24 h, containers expire after 24 h, media on a public URL. No server-side scheduling: our cron holds and publishes at the slot.
- Metrics: reach, saves, shares, views, likes, comments, profile visits, follows; account reach, views, follower count, demographics (100+ followers); delayed up to 48 h.
- Policy: OAuth posting on the business's own account is the API's purpose; consent required; `is_ai_generated` must be set on photorealistic AI video or audio (penalties otherwise); no label for AI-written captions or designed carousels.
- Posture: connect for posting and metrics. Autopilot allowed after approval.

**Threads (Meta)**: yes; a Threads profile (no Instagram link needed since 2025-09-23); own App Review; text 500 chars, image, video, carousel 2 to 20, polls; 250 API posts per 24 h; no scheduling; metrics views, likes, replies, reposts, quotes, shares, followers. Follow-on; nothing exists in the repo.

**LinkedIn**
- Post via API: personal profile yes, self-serve (`w_member_social`) with the person's consent. Company page yes, only through the vetted Community Management API with a page administrator's consent.
- Client: each seat OAuths their own profile; one page ADMINISTRATOR OAuths the page; re-consent every 60 days until Karos holds partner refresh tokens.
- Karos needs the Community Management API application: registered legal entity, business email, privacy policy, app verified by the Karos Page's super admin. Development tier first (500 calls per app per day, 100 per member); Standard tier within 12 months (screencast, technical sign-off).
- Formats: text, image, multi-image, document (the organic "PDF carousel"), video, poll, article; native carousel is sponsored-only. Quotas mostly unpublished. No scheduling in the API ("PUBLISHED is the only accepted state at creation"); the client's own composer schedules up to 3 months ahead.
- Metrics only via Community Management: page share, follower and visitor statistics; member post analytics since API 202506 (impressions, reach, reactions, comments, reshares, saves, sends, link clicks, followers gained, profile views). Nothing meaningful on the self-serve product.
- Policy: the User Agreement bans bots that create, comment, like or share; the general API Terms of Use (section 3.1, item 26) forbid using the APIs "to automate posting", which binds the self-serve product; only Community Management apps may schedule and publish unattended. Since 2026-05-20 generic AI posts are capped to the poster's network; "seems like AI slop" report button since 2026-07-30.
- Posture: draft-only for publishing (the person posts in one click). Connect for metrics through Community Management; apply now. No autopilot. Karos staff never act as a client's page admin.

**X**
- Post via API: yes, on the client's account with OAuth 2.0 (`tweet.read`, `tweet.write`, `users.read`, `offline.access`, plus `media.write` for uploads; OAuth 1.0a user context also accepted). Client needs a normal account with verified email and phone; no business verification.
- Karos needs one developer account on pay-per-use with a spend cap and a use-case description; no app review for standard posting.
- Formats: text (280 chars, more for Premium accounts), up to 4 images or 1 video, polls, replies; a thread is a chain of replies posted in sequence; quote posts require an Enterprise plan. Limits: 100 posts per 15 min per user, 10,000 per 24 h per app. No scheduling: our cron.
- Metrics: public impressions, likes, reposts, replies, quotes, bookmarks; non-public link clicks, profile clicks, engagements (owner only, last 30 days); followers, following, post count. Billed as reads.
- Policy: automated posting is allowed, but OAuth alone "does not by itself constitute sufficient consent to take automated actions": describe the actions, obtain express consent, honour opt-out. AI reply bots need X's prior written approval; keyword-triggered replies are banned; no near-duplicate posts across accounts; no automated likes or follows.
- Posture: connect for posting and metrics. Autopilot after a separate consent screen with an always-on opt-out. Never auto-reply, auto-mention or bulk-quote. X's per-use fee is Karos's cost, not the client's; the client is charged credits per published post (O16).

**TikTok**
- Post via API: yes, Content Posting API. Direct Post publishes; Upload to inbox leaves the video in the client's TikTok inbox to tap Post. Client: any account via Login Kit; a Business Account for deep insights.
- Karos needs app review (days to two weeks) and then a separate Content Posting audit (weeks; UX rules: privacy selector from creator_info with no default, toggles off by default, preview and explicit consent). Until audited every post is private-only and 5 posting users per 24 h. PULL_FROM_URL needs a Karos-verified media domain (signed Google Storage URLs cannot be verified).
- Formats: video up to 10 min and 4 GB; photo carousel up to 35 (PULL_FROM_URL only); caption 2,200 chars; `is_aigc` flag on video and inbox posts (photo posts carry the AI label differently; check the photo reference before shipping content-design carousels). Limits: 6 init calls per minute per user; about 15 posts per day per creator; inbox mode 5 pending per 24 h. No scheduling: our cron.
- Metrics: Display API gives views, likes, comments, shares and follower counts on the client's own videos. Business API (Business Account, separate app, access form since 2026-03-20) adds reach, watch time, full-watch rate, traffic sources, demographics.
- Policy: official API posting is allowed; unofficial automation banned; AI-generated media must set `is_aigc`; business accounts must use the Commercial Music Library.
- Posture: connect for metrics and inbox delivery first (no audit needed; the client taps Post). Direct Post autopilot only after the audit. Karos's developer account has been unverified since 2026-07-27.

**Reddit**
- Post via API: technically (scope `submit`), practically no. All Data API access needs manual approval since 2025-11-11; commercial use needs written permission and a contract; automated accounts carry an [App] label since 2026-03-31; accounts showing automated behaviour face identity verification (about 100,000 bot accounts removed per day).
- Client owns and warms the account, email-verified. Karos needs nothing for posting (never). For discovery: an approved research client under the Responsible Builder Policy (100 requests per minute, delete data within 48 h) with a non-API fallback.
- Metrics: public scores and comment counts are readable without the client's account; the `history` scope exposes only the client's own votes and saves.
- Policy: AI-assisted writing by a human is allowed if it does not "present itself as human-generated" and the community allows it; automated marketing replies are not.
- Posture: never post (D25). No account connection for metrics: outcomes are read from the comment URL the client pastes back.

**YouTube**
- Upload is possible, but every upload from an unaudited API project is forced private; the compliance audit (2 to 4 weeks reported) is mandatory for public uploads; 100 uploads per day per project shared by all clients. Native scheduling with `publishAt`.
- Metrics: per-video views, likes, comments; channel views, watch time, subscribers, demographics (Analytics API). Policy: consent per action ("must not automate ... uploads ... without the user's prior specific and express consent").
- Posture: metrics only. No YouTube agents (Albert, 2026-09-11).

**Google Business Profile**
- Post via API: yes, local posts and review replies. Client: owner or manager of a verified Business Profile, grants `business.manage`.
- Karos needs the API access application: Karos's own profile verified and active 60+ days, applied from an owner email; quota 0 until approved, 300 per minute after. Agencies may not make clients apply for their own project.
- Formats: local posts (standard, event, offer, alert) with one photo or video and a CTA; review replies. Recurring posts; no one-shot publish time.
- Metrics: impressions on Maps and Search, website clicks, calls, direction requests; reviews with rating, text, reply state and policy violations.
- Policy: "must not automate or trigger review replies ... without the user's prior specific and express consent"; replying on a client's behalf needs their authorisation first.
- Posture: pursue now for Reputation. Read reviews and metrics; post replies and local posts only after the client approves each one. No autopilot.

**Pinterest**: yes (pins, carousels up to 5 images, video); Karos needs a business account, Trial access (sandbox only) then Standard (screen recording of the OAuth flow, 2+ weeks reported); no scheduling and "the end user must choose each Pin to be published"; metrics impressions, saves, clicks, video views over a rolling 90 days, no caching of API data. Not now; no Pinterest agent.

Who pays what: the client pays credits only. Platform API costs are Karos's, on Karos's developer accounts. X bills Karos per use (a post $0.015, a post with a link $0.20, a read $0.005; no subscription tiers since the legacy Basic and Pro plans were migrated in June and September 2026), so Karos's cost of publishing an X post is cents and is no reason to stay draft-only. Meta, TikTok, LinkedIn, Google and Pinterest charge nothing; their cost is approvals and engineering. A published post can carry its own credit charge, higher on autopilot; that price is a decision (O16) and belongs in 07 Pricing model, alongside the two plans (D27).

## 3. What exists in the repo today

| Platform | OAuth wired | Posts today | Metrics today | Blockers |
|---|---|---|---|---|
| Instagram | Yes (Facebook login path) | Single photo only; Reels refused; no carousel or Stories (`src/lib/integrations/publishers.ts:175-258`) | Per-post pull exists but requests the deprecated `impressions` metric, so failures zero-fill saves and reach (`analytics-providers.ts:114-125`) | `FACEBOOK_APP_ID/SECRET` are not in the deploy's secrets, so Connect shows "Coming soon" in prep and prod; every Graph call is pinned to v20.0, which sunsets 2026-09-24; no token refresh |
| LinkedIn (personal) | Yes (`w_member_social`) | Text only via the legacy `ugcPosts` endpoint, 3,000-char slice, images dropped silently (`publishers.ts:313-378`) | Likes and comments only via legacy `socialActions`; impressions hard-coded 0 | Posts API replaces ugcPosts; posting as an organisation would fail (no `w_organization_social`); 60-day tokens, refresh never exchanged |
| LinkedIn (company, Community Management) | Yes, separate app | No | Reader exists, no caller; the sync has no arm for it | Community Management approval not obtained; scope bug: requests `r_organization_admin` where the docs require `rw_organization_admin` (`oauth.ts:197`) |
| LinkedIn seats (employee advocacy) | Yes | Never posted to | `fetchSeatMetrics` always returns null (`analytics-providers.ts:507-522`) | Member analytics scope exists since API 202506; not wired |
| X | Yes (PKCE, no `media.write`) | Text only, 280-char slice, no threads or media (`publishers.ts:382-411`) | Public and non-public metrics per post; follower and mention fetchers have no callers | Access tokens expire after 2 hours and the refresh token is never used, so any post or read more than 2 hours after connecting returns 401; comments still reason about Basic and Pro tiers |
| TikTok | Yes | Direct Post exists with `privacy_level` hard-coded SELF_ONLY; no photo path; no status polling (`publishers.ts:415-463`) | Query by publish id, which is not a video id, so lookups will not match | Connect button withheld pending developer verification (since 2026-07-27); no verified media domain; 24-hour tokens, no refresh |
| YouTube | Yes | Throws "not automated yet" | Fetchers exist, no post ids ever set, no caller | No upload; short-lived tokens, no refresh |
| Reddit | Yes (read scopes) | Never (by rule, enforced by absence and tests) | Account-health readers exist, no callers | Secrets not deployed; 1-hour tokens |
| Google Business Profile | Yes | No | Reader inert until Google approves; no caller | Access application not filed |
| Search Console, GA4 | Yes | n/a | Readers exist, "unverified against a real property", no callers | Property ids can only be entered by an admin |
| Threads, Pinterest | No | No | No | Not built |

Per-environment secrets and flags: run the repo's env inventory script (`scripts/env-inventory.ts`, from the AU49 work) rather than retyping the list here.

The publishing pipeline: assets carry a status (draft, approved, scheduled, delivered, published) and a publish mode (auto, manual, placeholder). The publish cron (`src/app/api/publish/route.ts`) picks approved or scheduled assets whose slot has passed and whose mode is auto, claims them, publishes through `publishAssetToPlatform`, stores the platform post id, and marks the integration expired on 401. Three switches must line up for a post to go out unattended: the client setting `autoScheduleEnabled`, the integration's `autoPublish` not off, and the asset's mode auto. There is no single per-client autopilot switch; `ClientSettings.autopilot` is dead. The cron's schedule is not defined anywhere in the repo. The analytics sync stamps an auto asset "published" once its slot passes even when no post went out, so "published" does not prove a post exists. Posts the client puts up by hand ("Mark as posted") never get a post id and are never measured. No connector refreshes tokens.

## 4. Autopilot: the model to build

- One switch per client per platform with the three levels in section 1. Default for a new client: manual. Calendar runs on autopilot publish at the slot; calendar runs on manual deliver to the review queue with a "post it" action.
- The client sees plain words on every post: "Publishes automatically at 09:00 on Tuesday" or "Ready for you to post". Never "approved" or "reviewed" (SOW rule).
- Consent: X requires a separate consent screen describing the automated actions and an always-on opt-out; keep the same screen for every platform. Google Business Profile and Pinterest require the client to choose each item; LinkedIn self-serve forbids automated posting; Reddit never posts.
- Failures are visible: a post that fails to publish shows the reason on the calendar and retries; an expired connection shows "Reconnect" on the post, not only on the settings page.
- A post published by the client by hand gets its platform id when the client pastes the link back, so it can be measured.

## 5. Build or buy

Seven unified posting APIs were compared (Ayrshare, Zernio formerly Late, Postiz, Publer, SocialBu, Sprout, Hootsuite, Buffer, Zapier and Make, Mixpost). The problem they solve for Karos is the visual and video platforms, where the direct path is blocked by audits we have not passed: Instagram, TikTok, YouTube, Threads, Pinterest, Google Business Profile. A partner-audited vendor makes client TikTok and YouTube posts public on day one, removes five separate reviews, and adds post and account analytics for the learning loop.

| Option | Coverage | Price at 30 clients | White-label connect page | Holds client tokens | Verdict |
|---|---|---|---|---|---|
| Ayrshare | 13 networks incl. LinkedIn personal and page, TikTok direct post, Threads, Pinterest, GBP, Reddit; X needs Karos's own developer app and prepaid X credits | Launch $299 per month (10 profiles, white-label connect page, webhooks) until 10 clients; Business $599 per month monthly or $499 annual (30 profiles), extra profiles $8.99 | Yes from Launch (logo, network list, redirect) | Yes; SOC 2 Type II, DPA; US entity | Buy first. Start on Launch, four-week paid pilot with three clients before any annual commitment. |
| Zernio (Late) | 16 platforms | About $338 per month at 120 accounts (graduated per account) | Headless only | Yes; SOC 2 Type II, EU entity; terms allow termination without notice | The priced alternative if cost dominates and a Karos-branded connect page does not matter |
| Postiz self-hosted, Mixpost | Wide | Free software | n/a | Karos holds tokens, but Karos also owns every platform audit | No: re-imports every audit we are trying to avoid; Postiz's scheduled-post failures closed "not planned" |
| Buffer, Publer, SocialBu | Partial | $760 to $1,200 per month at 120 channels | No | Yes | No: single-org, no metrics for product integrations, or undocumented API |
| Sprout, Hootsuite | Enterprise | $399 per seat and up | No | Yes | No: Sprout drafts only; Hootsuite approval-gated |
| Zapier, Make | Glue | Task pricing | No | Yes | No: no TikTok or Threads posting, no analytics, X still needs our app |

Keep direct where the vendor adds nothing: X (own app, pay-per-use; posting and metrics already wired), LinkedIn (personal posting and employee seats under our app; Community Management application for analytics), Reddit read-only, Google reads (Search Console, GA4, Business Profile).

Engineering shape: a vendor publisher behind the existing `publishAssetToPlatform` seam, selected per client and platform on the integration record; the vendor's post id stored as `platformPostId` so the existing analytics sync reads vendor analytics; the direct publishers kept as fallback; "connected via partner" shown in the client's data disclosure. Vendor risk: consent screens name the vendor, not Karos (except X); the vendor can terminate; mitigate with the DPA, per-client profile isolation and a documented disconnect path.

## 6. What to build

| Id | Item | Where |
|---|---|---|
| CN1 | Token refresh for every connector (**shipped, in review**) (X 2 h, TikTok 24 h, Google short-lived, Reddit 1 h, LinkedIn and Meta 60 days). Nothing works unattended without it | portal |
| CN2 | Meta version pin and Instagram insights (**shipped, in review**); still open: carousel, Reels and Stories containers, `is_ai_generated` on photorealistic AI video or audio, deploying the Meta app credentials, Business Verification and App Review | portal + Albert (verification) |
| CN3 | X: chain threads as replies instead of slicing at 280; add `media.write` and the v2 chunked upload for client pictures; replace the "quote" style with a plain post (quote posts need Enterprise); the separate consent screen; a developer account on pay-per-use with a spend cap | portal + Albert (account) |
| CN4 | TikTok: inbox (upload) mode with `video.upload`, `video.list`, `user.info.stats`; a Karos-owned media domain for PULL_FROM_URL; the audit-compliant post UI; developer-account verification; the Content Posting audit; `is_aigc` for content-design output; query metrics by video id | portal + Shlomi (audit UX) + Albert (verification) |
| CN5 | LinkedIn: Community Management application on a fresh app; fix the scope to `rw_organization_admin`; move to the Posts API; wire member post analytics for seats; keep the one-click handoff for publishing | portal + Albert (application) |
| CN6 | Google Business Profile: file the access application from an owner email once Karos's profile is 60 days verified; wire review reading, reply posting after client approval, and Performance metrics; read reply state back | portal + Albert (application) |
| CN7 | The autopilot switch model of section 4: one setting per client per platform replacing the three-flag combination; plain-language state on every post; consent screen; visible failures and reconnect | portal |
| CN8 | Measure hand-posted content: paste-back of the post URL on "Mark as posted" to set the platform id | portal |
| CN9 | Vendor publisher behind `publishAssetToPlatform`; profile key per client; Ayrshare pilot with three clients; keep direct publishers as fallback | portal + service |
| CN10 | Define the cron schedules (publish, analytics sync) in the deploy, and make "published" mean a post exists | portal |
| CN11 | Client-facing entry of Search Console, GA4 and Business Profile ids; wire their readers into the sync | portal |
| CN12 | Retire the parked "posting stays parked" lines in the X contract once CN3 ships; update the LinkedIn contract to "metrics via Community Management, publishing by the person" | docs |

## 7. What the client connects at onboarding

- Instagram: a professional account linked to a Facebook Page; grant the scopes when asked. Stories need a Business account.
- X: the account, with a verified email and phone; accept the consent screen; a second consent if they want autopilot.
- LinkedIn: each person who posts connects their own profile; one page administrator connects the company page; reconnect every 60 days until further notice. Posting stays theirs, in one click.
- TikTok: the account; posts arrive in their TikTok inbox to tap Post until our audit passes. A Business Account unlocks watch-time and audience reporting.
- Google: a Business Profile owner or manager for reviews and local metrics; Search Console and GA4 access for the site's numbers.
- Reddit: nothing to connect. They own the account, warm it, disclose their affiliation, and paste the link of any reply they post.
- YouTube: the channel, for reporting only.

## 8. Decisions

Open in 05: O08 (autopilot defaults), O13 (buy or build), O14 (accounts and applications), O15 (LinkedIn stays draft-only; staff never page admins).

## 9. Client data we hold per connector

| Platform | Stored by Karos | Platform's retention rule | Shown to the client |
|---|---|---|---|
| Instagram (and Threads later) | OAuth tokens (encrypted), page and account ids, post ids, per-post metrics | Metrics available two years back from Meta; our copies follow our own retention | Data disclosure page: "connected via Meta" |
| LinkedIn | Tokens (encrypted), member and organisation URNs, post ids | Member social activity 48 hours, other members' profile data 24 hours, organisation reporting data 1 year; member data only shown to people associated with that page or profile, never exported | Data disclosure: connected; metrics shown only to the client |
| X | Tokens (encrypted), post ids, per-post metrics, follower counts | Non-public metrics readable for 30 days after posting; keep the last value | Data disclosure |
| TikTok | Tokens (encrypted), publish and video ids, counts | Cover URLs expire in 6 hours; counts as read | Data disclosure |
| Reddit | Nothing from the account; the comment URL the client pastes | Research data deleted within 48 hours; no re-identification | Data disclosure: "we never connect your Reddit account" |
| YouTube | Tokens (encrypted), channel and video ids, analytics | Authorised data refreshed or deleted within 30 days | Data disclosure |
| Google Business Profile, Search Console, GA4 | Tokens (encrypted), location, site and property ids, daily metrics | Google API policies; reply and post content moderated by Google | Data disclosure |
| Pinterest | Not connected | No caching of API data beyond own-account analytics | n/a |
| Ayrshare (if adopted) | Profile key per client; Ayrshare holds the platform tokens under its DPA | Deleted on disconnect | Data disclosure: "connected via partner" |
