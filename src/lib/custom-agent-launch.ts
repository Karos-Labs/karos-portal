/**
 * Client-safe launch contracts for custom agents.
 *
 * Custom agents all execute through the service's single `prompt` field, but
 * the person launching one should not have to reverse-engineer its playbook.
 * These profiles turn agent identity into a guided brief and then serialize
 * the answers back into that prompt. Imported agents that are not recognized
 * still receive the outcome-focused fallback at the bottom of this file.
 */

import { isPublishHold } from "@/lib/asset-status-copy";
import { isCreditDenialMessage } from "@/lib/credits";
import { normalizeLabSlug } from "@/lib/lab-outputs-shared";

export type AgentBriefFieldType = "text" | "textarea" | "number" | "select";

export interface AgentBriefField {
  key: string;
  label: string;
  type: AgentBriefFieldType;
  required?: boolean;
  placeholder?: string;
  helper?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
}

export interface AgentAttachmentProfile {
  label: string;
  hint: string;
  /** Native file-picker filter. The server still validates every upload. */
  accept?: string;
  /** At least one selected file is required unless satisfyWithFieldKey is filled. */
  required?: boolean;
  satisfyWithFieldKey?: string;
}

export interface AgentLaunchProfile {
  eyebrow: string;
  intro: string;
  fields: AgentBriefField[];
  quickStarts: string[];
  deliverables: string[];
  estimate: string;
  attachments: AgentAttachmentProfile;
}

type AgentIdentity = { key: string; name: string };

const DOCUMENTS_AND_IMAGES =
  ".pdf,.doc,.docx,.txt,.md,.csv,image/png,image/jpeg,image/webp,image/gif";

const generalAttachments: AgentAttachmentProfile = {
  label: "Reference files",
  hint: "Add briefs, examples, brand material, or source data that should shape this run.",
  accept: DOCUMENTS_AND_IMAGES,
};

const genericProfile: AgentLaunchProfile = {
  eyebrow: "Custom work order",
  intro: "Define the outcome and the evidence the agent should use. Its saved playbook and this client's brand context are applied automatically.",
  fields: [
    {
      key: "request",
      label: "What should the agent accomplish?",
      type: "textarea",
      required: true,
      placeholder: "Describe the outcome you want and what a strong final result should contain.",
      helper: "Be specific about the decision, deliverable, or change you need.",
    },
    {
      key: "audience",
      label: "Who is this for?",
      type: "text",
      placeholder: "e.g. prospective customers, the founder, the marketing team",
    },
    {
      key: "success_criteria",
      label: "Success criteria and constraints",
      type: "textarea",
      placeholder: "Must include, avoid, match, or verify…",
    },
  ],
  quickStarts: [
    "Create a production-ready first draft for our current priority.",
    "Improve an existing asset using the attached references.",
    "Research the opportunity and recommend the strongest next move.",
  ],
  deliverables: ["A production-ready result", "Supporting rationale and sources when relevant"],
  estimate: "~10–35 min",
  attachments: generalAttachments,
};

const profiles: Array<{ matches: (identity: string) => boolean; profile: AgentLaunchProfile }> = [
  {
    matches: (identity) => /branded.?short|short.?form|video.?clip/.test(identity),
    profile: {
      eyebrow: "Short-form video brief",
      intro: "Give the editor the source, message, and publishing constraints. A source video or shareable source link is required.",
      fields: [
        {
          key: "request",
          label: "What should this short communicate?",
          type: "textarea",
          required: true,
          placeholder: "Turn the founder interview into a concise short about the product launch.",
          helper: "Name the moment, argument, or story that must survive the edit.",
        },
        {
          key: "source_url",
          label: "Source video link",
          type: "text",
          placeholder: "https://… (use this for video files larger than 4 MB)",
        },
        {
          key: "platform",
          label: "Primary platform",
          type: "select",
          defaultValue: "instagram_reels",
          options: [
            { value: "instagram_reels", label: "Instagram Reels" },
            { value: "tiktok", label: "TikTok" },
            { value: "linkedin", label: "LinkedIn" },
            { value: "cross_platform", label: "Cross-platform" },
          ],
        },
        {
          key: "duration",
          label: "Target duration",
          type: "select",
          defaultValue: "30_seconds",
          options: [
            { value: "15_seconds", label: "About 15 seconds" },
            { value: "30_seconds", label: "About 30 seconds" },
            { value: "45_seconds", label: "About 45 seconds" },
            { value: "60_seconds", label: "About 60 seconds" },
          ],
        },
        {
          key: "cta",
          label: "Call to action",
          type: "text",
          placeholder: "e.g. book a demo, follow for part two, visit the launch page",
        },
        {
          key: "editing_notes",
          label: "Editing constraints",
          type: "textarea",
          placeholder: "Must-use quote, clips to avoid, captions, pacing, safe areas…",
        },
      ],
      quickStarts: [
        "Cut a product-launch short and preserve the founder's strongest claim.",
        "Create a customer-outcome short from the clearest moment in the source.",
        "Turn the source into a fast social teaser without changing the speaker's meaning.",
      ],
      deliverables: ["Edited short-form video", "Platform-ready caption and publishing notes"],
      estimate: "~20–35 min",
      attachments: {
        label: "Source footage",
        hint: "Select or upload the source clip. For files over 4 MB, paste a shareable link above.",
        accept: "video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,.mp4,.mov,.webm,.mp3,.wav",
        required: true,
        satisfyWithFieldKey: "source_url",
      },
    },
  },
  {
    matches: (identity) => /instagram|tiktok|content.?engine/.test(identity),
    profile: {
      eyebrow: "Social content system",
      intro: "Choose whether to set up, refresh, or produce from the client's social content system, then give the agent the campaign signal it needs.",
      fields: [
        {
          key: "run_mode",
          label: "What should the agent do?",
          type: "select",
          defaultValue: "produce",
          options: [
            { value: "produce", label: "Produce content now" },
            { value: "setup", label: "Set up the content system" },
            { value: "refresh", label: "Refresh strategy and formats" },
          ],
        },
        {
          key: "request",
          label: "Content goal or campaign",
          type: "textarea",
          required: true,
          placeholder: "Create content that introduces the new offer to first-time buyers.",
          helper: "Describe the message or business result; the agent chooses the strongest on-brand format.",
        },
        {
          key: "platform",
          label: "Channel",
          type: "select",
          defaultValue: "both",
          options: [
            { value: "both", label: "Instagram + TikTok" },
            { value: "instagram", label: "Instagram" },
            { value: "tiktok", label: "TikTok" },
          ],
        },
        { key: "post_count", label: "Number of posts", type: "number", min: 1, max: 10, defaultValue: "3" },
        {
          key: "audience",
          label: "Audience or segment",
          type: "text",
          placeholder: "e.g. first-time founders in Israel",
        },
        {
          key: "must_include",
          label: "Must include or avoid",
          type: "textarea",
          placeholder: "Offer details, dates, approved claims, visual constraints…",
        },
      ],
      quickStarts: [
        "Introduce our newest offer with a clear, save-worthy carousel.",
        "Build trust with a founder story grounded in a real company moment.",
        "Create a post around the customer problem our product solves best.",
      ],
      deliverables: ["On-brand social creative", "Caption, hashtags, and content rationale"],
      estimate: "~15–35 min",
      attachments: {
        label: "Creative inputs",
        hint: "Product photos, campaign briefs, visual references, and approved source material are especially useful.",
        accept: `${DOCUMENTS_AND_IMAGES},video/mp4,video/quicktime,.mp4,.mov`,
      },
    },
  },
  {
    // Exact key on purpose (the e13 rule): the e10 LinkedIn agents are
    // intake-driven (setup gate + injected LinkedIn agent data), so they must
    // match BEFORE the generic /linkedin/ brief below. Covers the per-client
    // company-page instances (karos-linkedin-company-<slug>) and the master.
    matches: (identity) =>
      identity.startsWith("karos-linkedin-company-") || identity.startsWith("karos-linkedin-agent "),
    profile: {
      eyebrow: "LinkedIn drafts",
      intro:
        "Drafts the next company-page post from your LinkedIn agent data: the company page, seats, and ongoing drops. Voice, topics, and cadence are built from that data. This form only scopes the run. Draft-only; a person always posts.",
      fields: [
        {
          key: "request",
          label: "Anything to lean into this run?",
          type: "textarea",
          helper: "Optional. The agent works from the stored LinkedIn agent data either way.",
          placeholder: "A launch to feature, a topic to hit.",
        },
      ],
      quickStarts: [
        "Lean into this week's update.",
        "Pick an educational angle this time.",
        "Turn the latest milestone into the post.",
      ],
      deliverables: [
        "One company-page post draft with its native asset (carousel, document, or image)",
        "A linked source on every factual claim",
      ],
      estimate: "~10–20 min",
      attachments: {
        label: "Extra material for this run (optional)",
        hint: "One-off references for this post. The page URL, off-limits, seats, and news live in your LinkedIn agent data, not here.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    matches: (identity) => /linkedin/.test(identity),
    profile: {
      eyebrow: "Founder-led LinkedIn brief",
      intro: "Anchor the run in a real executive, an earned point of view, and the audience they need to reach.",
      fields: [
        {
          key: "run_mode",
          label: "What should the agent do?",
          type: "select",
          defaultValue: "draft",
          options: [
            { value: "draft", label: "Draft a post" },
            { value: "setup", label: "Set up an executive content system" },
            { value: "refresh", label: "Refresh an existing system" },
          ],
        },
        {
          key: "executive",
          label: "Executive or account",
          type: "text",
          required: true,
          placeholder: "Name, role, and LinkedIn profile URL",
        },
        {
          key: "request",
          label: "Point of view or outcome",
          type: "textarea",
          required: true,
          placeholder: "Explain what we learned while solving a hard customer problem and why it changes our approach.",
        },
        { key: "audience", label: "Audience", type: "text", placeholder: "Who should care about this and why?" },
        {
          key: "proof",
          label: "Proof the executive has earned",
          type: "textarea",
          placeholder: "Relevant experience, company evidence, customer outcome, or source link. Do not include unverified claims.",
        },
        {
          key: "voice_constraints",
          label: "Voice and boundaries",
          type: "textarea",
          placeholder: "Phrases they use, topics to avoid, compliance constraints, CTA…",
        },
      ],
      quickStarts: [
        "Draft a thought-leadership post from a lesson the executive has genuinely earned.",
        "Turn a recent company milestone into a credible first-person update.",
        "Set up a founder-led LinkedIn system around this executive's expertise.",
      ],
      deliverables: ["Executive-voice LinkedIn draft", "Hook, CTA, and claim-safety rationale"],
      estimate: "~15–30 min",
      attachments: {
        label: "Executive source material",
        hint: "A CV, bio, interview transcript, or past writing sample helps the agent match the person instead of writing generic brand copy.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    // Exact key on purpose: only e13 is intake-driven (setup gate + injected
    // X agent data). Other imported X/Twitter-ish agents get the generic brief.
    matches: (identity) => identity.startsWith("karos-x-agent "),
    profile: {
      eyebrow: "X drafts",
      intro:
        "Drafts a week of posts from your X agent data: the company page, seats, and ongoing drops. Voice, audience, and cadence are built from that data. This form only scopes the run. Draft-only; nothing posts without a human.",
      fields: [
        {
          key: "run_scope",
          label: "Draft for",
          type: "select",
          defaultValue: "the company page and every seat",
          options: [
            { value: "the company page and every seat", label: "Company page and every seat" },
            { value: "the company page only", label: "Company page only" },
          ],
        },
        {
          key: "request",
          label: "Anything to lean into this run?",
          type: "textarea",
          helper: "Optional. The agent works from the stored X agent data either way.",
          placeholder: "A launch to feature, a topic to hit, a seat to focus on.",
        },
      ],
      quickStarts: [
        "Lean into this week's announcement.",
        "Focus this batch on one person's seat.",
        "React to what happened in the industry this week.",
      ],
      deliverables: ["A week of post drafts across the avenues", "A linked source on every news, quote, and reply post"],
      estimate: "~15–25 min",
      attachments: {
        label: "Extra material for this run (optional)",
        hint: "One-off references for this batch. Handles, off-limits, rosters, takes, and news live in your X agent data, not here.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    // Exact key on purpose, the same rule as e13 and e10: only the intake-driven
    // Reddit agent gets this brief and its setup gate. A regex on /reddit/ would
    // be fine today (no other agent mentions Reddit) but a match on words like
    // monitor, listen or research would hijack the reputation and intelligence
    // agents below, so the key is the safer test.
    matches: (identity) => identity.startsWith("karos-reddit-agent "),
    profile: {
      eyebrow: "Reddit reply",
      intro:
        "Finds a live thread worth answering and drafts one genuinely helpful reply, from your Reddit agent data. The subreddits, the questions worth answering and the voice are built from that data. This form only scopes the run. We never post to Reddit; you post the reply yourself.",
      fields: [
        {
          key: "request",
          label: "Anything to steer this run?",
          type: "textarea",
          helper: "Optional. The agent picks the thread from the stored Reddit agent data either way.",
          placeholder: "A subreddit to prioritise, a question type to look for.",
        },
      ],
      quickStarts: [
        "Find the freshest question you can answer well.",
        "Prioritise the subreddits where we have the most standing.",
        "Look for a question our product genuinely answers, value first.",
      ],
      deliverables: [
        "One reply drafted against a live thread, with the thread link and the subreddit's promo verdict",
        "A why-this-is-safe note and the gate results, so you can post it with confidence",
      ],
      estimate: "~10–20 min",
      attachments: {
        label: "Extra material for this run (optional)",
        hint: "One-off references for this reply. The account, its history, off-limits subreddits and your disclosure wording live in your Reddit agent data, not here.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    matches: (identity) => /newsletter/.test(identity),
    profile: {
      eyebrow: "Newsletter brief",
      intro: "Give the issue one editorial job, a reader, and the source material it must cover.",
      fields: [
        { key: "request", label: "Issue theme and goal", type: "textarea", required: true, placeholder: "A monthly issue that helps our readers understand one theme and drives one action." },
        { key: "audience", label: "Reader segment", type: "text", placeholder: "Who opens this issue?" },
        { key: "must_include", label: "Stories, links, or dates to include", type: "textarea", placeholder: "One item per line" },
        { key: "cta", label: "Primary call to action", type: "text", placeholder: "The one action the issue should earn" },
        { key: "tone", label: "Editorial tone", type: "text", placeholder: "e.g. founder note, sharp industry briefing, customer education" },
      ],
      quickStarts: [
        "Create a monthly roundup built around the most useful customer takeaway.",
        "Turn the attached announcements into one coherent, reader-first issue.",
        "Draft an educational issue that leads naturally to our primary offer.",
      ],
      deliverables: ["Complete newsletter copy", "Subject-line options and rendered issue when supported"],
      estimate: "~10–20 min",
      attachments: {
        label: "Issue sources",
        hint: "Attach previous newsletters for voice, source articles for facts, and hero images for the final issue.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    matches: (identity) => /blog|article/.test(identity),
    profile: {
      eyebrow: "Long-form content brief",
      intro: "Connect a real audience question to a search opportunity and a point of view the client can support.",
      fields: [
        {
          key: "run_mode",
          label: "What should the agent do?",
          type: "select",
          defaultValue: "article",
          options: [
            { value: "article", label: "Write an article" },
            { value: "setup", label: "Set up the blog system" },
            { value: "refresh", label: "Refresh topics and formats" },
          ],
        },
        { key: "request", label: "Topic or reader question", type: "textarea", required: true, placeholder: "Answer the question our buyers ask before choosing a solution like ours." },
        { key: "audience", label: "Audience and intent", type: "text", placeholder: "Who is searching, and what decision are they making?" },
        { key: "keywords", label: "Keyword or answer territory", type: "text", placeholder: "Optional; the agent can research it" },
        { key: "point_of_view", label: "Brand point of view and proof", type: "textarea", placeholder: "What can this client credibly say that ranking pages cannot?" },
        { key: "sources", label: "Required sources or internal links", type: "textarea", placeholder: "URLs, studies, product pages, claims to verify…" },
      ],
      quickStarts: [
        "Write a durable explainer that answers a high-intent customer question better than current results.",
        "Create a comparison article grounded in our real differentiation.",
        "Set up a blog system around the topics our audience asks before buying.",
      ],
      deliverables: ["Sourced long-form article", "SEO metadata and answer-engine structure"],
      estimate: "~15–30 min",
      attachments: generalAttachments,
    },
  },
  {
    matches: (identity) => /landing.?page|website|web.?page/.test(identity),
    profile: {
      eyebrow: "Conversion page brief",
      intro: "Define the conversion, offer, and proof before the agent makes layout or copy decisions.",
      fields: [
        { key: "request", label: "Page goal", type: "textarea", required: true, placeholder: "Build a page that turns qualified visitors into demo bookings." },
        { key: "offer", label: "Offer and promise", type: "textarea", required: true, placeholder: "What the visitor gets, why it matters, and any terms" },
        { key: "audience", label: "Audience and traffic source", type: "text", placeholder: "Who lands here, and from where?" },
        { key: "cta", label: "Primary call to action", type: "text", placeholder: "e.g. Book a demo" },
        { key: "proof", label: "Proof and objections", type: "textarea", placeholder: "Testimonials, metrics, guarantees, objections to answer…" },
        { key: "references", label: "Reference URLs", type: "textarea", placeholder: "One URL per line: existing site, inspiration, offer details…" },
      ],
      quickStarts: [
        "Build a focused demo-booking page for our highest-intent audience.",
        "Create a launch page that explains the offer and removes the main objections.",
        "Improve our existing landing page around one clear conversion goal.",
      ],
      deliverables: ["Complete page source and static build", "Conversion copy and build instructions"],
      estimate: "~20–35 min",
      attachments: {
        label: "Brand and page assets",
        hint: "Logos, product images, brand guidelines, testimonials, and wireframes help the page ship closer to final.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    matches: (identity) => /seo|geo|search/.test(identity),
    profile: {
      eyebrow: "Search audit brief",
      intro: "Set the property, market, and business decision so the audit prioritizes findings that can actually change performance.",
      fields: [
        { key: "website", label: "Website or property", type: "text", required: true, placeholder: "https://…" },
        {
          key: "scope",
          label: "Audit scope",
          type: "select",
          defaultValue: "seo_geo",
          options: [
            { value: "seo_geo", label: "SEO + AI answer visibility" },
            { value: "technical", label: "Technical SEO" },
            { value: "content", label: "Content and keyword gaps" },
            { value: "geo", label: "AI answer visibility (GEO)" },
          ],
        },
        { key: "request", label: "Business goal or question", type: "textarea", required: true, placeholder: "Find why high-intent pages are not earning qualified traffic and prioritize fixes." },
        { key: "market", label: "Market, language, and geography", type: "text", placeholder: "e.g. English, US + UK, B2B SaaS" },
        { key: "competitors", label: "Known search competitors", type: "textarea", placeholder: "Domains or brands, one per line" },
      ],
      quickStarts: [
        "Audit our SEO and AI-answer visibility, then rank fixes by business impact.",
        "Find the highest-value content gaps against the competitors listed below.",
        "Diagnose why our priority pages are not ranking or being cited.",
      ],
      deliverables: ["Prioritized search and answer-visibility audit", "Evidence, fixes, and implementation roadmap"],
      estimate: "~20–35 min",
      attachments: {
        label: "Search evidence",
        hint: "Analytics exports, Search Console data, keyword lists, and previous audits make recommendations more specific.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    matches: (identity) => /ux|ui.?audit|accessibility|conversion/.test(identity),
    profile: {
      eyebrow: "Experience audit brief",
      intro: "Anchor the review in one user journey, its business goal, and any evidence already collected.",
      fields: [
        { key: "website", label: "Page or product URL", type: "text", required: true, placeholder: "https://…" },
        { key: "request", label: "Journey and goal to evaluate", type: "textarea", required: true, placeholder: "Review the mobile demo-booking flow for friction and accessibility failures." },
        { key: "audience", label: "Primary user", type: "text", placeholder: "Who is trying to complete the journey?" },
        { key: "known_issues", label: "Known issues or hypotheses", type: "textarea", placeholder: "Drop-off points, support complaints, design concerns…" },
        { key: "devices", label: "Priority devices", type: "text", placeholder: "e.g. mobile Safari first, then desktop" },
      ],
      quickStarts: [
        "Audit our primary conversion journey for usability, accessibility, and trust gaps.",
        "Review the mobile experience and prioritize the five highest-impact fixes.",
        "Compare the current flow with the attached research and validate our hypotheses.",
      ],
      deliverables: ["Evidence-backed UX and accessibility findings", "Prioritized fixes with implementation guidance"],
      estimate: "~15–30 min",
      attachments: {
        label: "Research and screens",
        hint: "Analytics, screenshots, recordings, support themes, and prior research help separate evidence from opinion.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    matches: (identity) =>
      !/amazon|marketplace|listing/.test(identity) &&
      /google.?ads|paid.?social|ad.?creative|\bads?\b/.test(identity),
    profile: {
      eyebrow: "Paid media brief",
      intro: "Give the agent the offer, objective, audience, and economic constraints that define a viable campaign.",
      fields: [
        {
          key: "channel",
          label: "Channel",
          type: "select",
          defaultValue: "meta_tiktok",
          options: [
            { value: "meta_tiktok", label: "Meta + TikTok" },
            { value: "google", label: "Google Ads" },
            { value: "meta", label: "Meta" },
            { value: "tiktok", label: "TikTok" },
            { value: "multi_channel", label: "Multi-channel" },
          ],
        },
        { key: "request", label: "Campaign objective", type: "textarea", required: true, placeholder: "Generate qualified demo requests for the new offer." },
        { key: "offer", label: "Offer and landing page", type: "textarea", required: true, placeholder: "Offer, price, promise, and URL" },
        { key: "audience", label: "Audience and geography", type: "text", placeholder: "Segment, market, exclusions" },
        { key: "budget", label: "Budget and target economics", type: "text", placeholder: "Monthly spend, target CPA/ROAS, margin constraints" },
        { key: "constraints", label: "Claims, compliance, and creative constraints", type: "textarea", placeholder: "Approved claims, prohibited language, asset requirements…" },
      ],
      quickStarts: [
        "Build a paid acquisition plan around our offer and target CPA.",
        "Create campaign angles and ad concepts for the audience below.",
        "Audit the attached performance export and recommend the next budget moves.",
      ],
      deliverables: ["Campaign strategy and structure", "Ad angles, creative briefs, and testing plan"],
      estimate: "~15–30 min",
      attachments: {
        label: "Campaign evidence and creative",
        hint: "Performance exports, existing ads, product imagery, and the landing page brief help the agent make grounded decisions.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    matches: (identity) => /email|lifecycle|sms/.test(identity),
    profile: {
      eyebrow: "Lifecycle campaign brief",
      intro: "Define the moment in the customer journey, the segment, and the action this sequence should earn.",
      fields: [
        { key: "campaign_type", label: "Campaign or flow", type: "text", required: true, placeholder: "e.g. launch campaign, welcome flow, win-back sequence" },
        { key: "request", label: "Goal", type: "textarea", required: true, placeholder: "Move trial users to their first successful outcome and then to paid." },
        { key: "audience", label: "Segment and trigger", type: "text", placeholder: "Who enters, and when?" },
        { key: "offer", label: "Offer and primary CTA", type: "text", placeholder: "What should they do or buy?" },
        { key: "must_include", label: "Required messages and constraints", type: "textarea", placeholder: "Dates, product facts, compliance, links, exclusions…" },
      ],
      quickStarts: [
        "Build a launch sequence that moves the target segment to one clear action.",
        "Create a welcome flow around the customer's first successful outcome.",
        "Audit the current lifecycle and design the highest-impact missing flow.",
      ],
      deliverables: ["Lifecycle strategy and sequence map", "Complete campaign copy and testing plan"],
      estimate: "~15–25 min",
      attachments: generalAttachments,
    },
  },
  {
    matches: (identity) =>
      !/reputation|reviews|monitor/.test(identity) && /brand|rebrand|positioning/.test(identity),
    profile: {
      eyebrow: "Brand strategy brief",
      intro: "Clarify the business shift, audience, and competitive perception before asking the agent to shape identity or positioning.",
      fields: [
        {
          key: "project_type",
          label: "Project",
          type: "select",
          defaultValue: "positioning",
          options: [
            { value: "positioning", label: "Positioning and messaging" },
            { value: "refresh", label: "Brand refresh" },
            { value: "rebrand", label: "Full rebrand" },
            { value: "voice", label: "Voice and messaging system" },
          ],
        },
        { key: "request", label: "Business problem or desired shift", type: "textarea", required: true, placeholder: "Move perception from a tactical vendor to a strategic partner for our buyers." },
        { key: "audience", label: "Priority audience", type: "text", placeholder: "Buyer, user, market, and maturity" },
        { key: "current_perception", label: "Current vs desired perception", type: "textarea", placeholder: "Today they think… We need them to believe…" },
        { key: "competitors", label: "Competitive set and references", type: "textarea", placeholder: "Brands to differentiate from or learn from" },
        { key: "constraints", label: "Non-negotiables", type: "textarea", placeholder: "Elements to keep, legal constraints, rollout timing…" },
      ],
      quickStarts: [
        "Clarify our positioning against the competitors below and build a practical messaging system.",
        "Refresh the brand without losing the equity in our strongest existing assets.",
        "Define the voice and narrative for our next stage of growth.",
      ],
      deliverables: ["Positioning and messaging system", "Brand direction with evidence and rollout guidance"],
      estimate: "~20–35 min",
      attachments: {
        label: "Brand evidence",
        hint: "Current guidelines, identity files, customer research, sales material, and competitor references make the strategy specific.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    matches: (identity) => /amazon|listing|marketplace/.test(identity),
    profile: {
      eyebrow: "Marketplace brief",
      intro: "Give the agent the marketplace, product economics, and listing evidence needed to make commercially realistic recommendations.",
      fields: [
        { key: "marketplace", label: "Marketplace and country", type: "text", required: true, placeholder: "e.g. Amazon US" },
        { key: "product", label: "Product, ASIN, or listing URL", type: "text", required: true, placeholder: "Product name + ASIN/URL when live" },
        { key: "request", label: "Objective", type: "textarea", required: true, placeholder: "Launch a new listing, improve conversion, fix PPC efficiency…" },
        { key: "economics", label: "Economics and constraints", type: "textarea", placeholder: "Price, landed cost, margin, inventory, target ACOS…" },
        { key: "competitors", label: "Competitor ASINs or brands", type: "textarea", placeholder: "One per line" },
      ],
      quickStarts: [
        "Build a commercially realistic launch plan for this product and marketplace.",
        "Audit the listing and prioritize changes most likely to improve conversion.",
        "Create an A+ content and PPC plan around the economics below.",
      ],
      deliverables: ["Marketplace strategy or launch plan", "Listing, creative, and advertising recommendations"],
      estimate: "~20–35 min",
      attachments: {
        label: "Product and marketplace inputs",
        hint: "Product photos, cost sheets, listing exports, keyword data, and competitor references are high-value inputs.",
        accept: DOCUMENTS_AND_IMAGES,
      },
    },
  },
  {
    matches: (identity) => /reputation|reviews|monitor/.test(identity),
    profile: {
      eyebrow: "Reputation brief",
      intro: "Set the surfaces, market, risk, and response boundaries so the agent can separate monitoring from action.",
      fields: [
        { key: "brand", label: "Brand and surfaces", type: "text", required: true, placeholder: "Brand name + review sites, social accounts, or markets" },
        { key: "request", label: "Monitoring or response goal", type: "textarea", required: true, placeholder: "Audit recurring review themes and draft safe responses to the priority issues." },
        { key: "market", label: "Market and time window", type: "text", placeholder: "e.g. US, last 90 days" },
        { key: "concerns", label: "Known risks or incidents", type: "textarea", placeholder: "Escalations, sensitive claims, recurring complaints…" },
        { key: "response_rules", label: "Response and approval rules", type: "textarea", placeholder: "What may be drafted, what requires legal review, what must never be claimed" },
      ],
      quickStarts: [
        "Audit recent reputation signals and prioritize the issues that need action.",
        "Analyze review themes and draft responses within the rules below.",
        "Build a monitoring and escalation plan for the surfaces listed below.",
      ],
      deliverables: ["Reputation or review findings", "Response drafts, monitoring plan, and escalation rules"],
      estimate: "~15–30 min",
      attachments: generalAttachments,
    },
  },
  {
    matches: (identity) => /performance|dashboard|analytics.?report|monthly.?report/.test(identity),
    profile: {
      eyebrow: "Performance analysis brief",
      intro: "Define the reporting window and the decision this analysis needs to support, then attach the freshest source exports.",
      fields: [
        { key: "period", label: "Reporting period", type: "text", required: true, placeholder: "e.g. June 2026 or Q2 2026" },
        { key: "request", label: "Decision this report should support", type: "textarea", required: true, placeholder: "Explain what changed, why, and where to reallocate next month." },
        { key: "channels", label: "Channels and KPIs", type: "text", placeholder: "e.g. paid search, Meta, organic social; pipeline, CAC, ROAS" },
        { key: "comparison", label: "Comparison baseline", type: "text", placeholder: "Previous period, target, forecast, or benchmark" },
        { key: "notes", label: "Known anomalies and context", type: "textarea", placeholder: "Launches, tracking gaps, promotions, outages…" },
      ],
      quickStarts: [
        "Turn the attached exports into an executive performance report with next actions.",
        "Explain the largest changes versus the previous period and recommend reallocations.",
        "Build a concise dashboard narrative for the leadership review.",
      ],
      deliverables: ["Decision-ready performance report", "Trends, anomalies, and prioritized next actions"],
      estimate: "~15–30 min",
      attachments: {
        label: "Performance exports",
        hint: "Attach current analytics, ad-platform, CRM, and sales exports. Name each file clearly so the agent can reconcile them.",
        accept: ".csv,.xlsx,.xls,.pdf,.txt,.md,text/csv,application/pdf",
      },
    },
  },
  {
    matches: (identity) => /intel|competitor|research|scope|proposal/.test(identity),
    profile: {
      eyebrow: "Market intelligence brief",
      intro: "Set the company, market boundary, and decision to avoid a broad report that cannot change the next move.",
      fields: [
        { key: "company", label: "Company and website", type: "text", required: true, placeholder: "Company name + https://…" },
        { key: "request", label: "Decision or research question", type: "textarea", required: true, placeholder: "Find the positioning gap we can own with our buyers in this market." },
        { key: "market", label: "Market and geography", type: "text", placeholder: "Category, countries, language, business model" },
        { key: "audience", label: "Target customer", type: "text", placeholder: "Buyer and use case" },
        { key: "competitors", label: "Known competitors", type: "textarea", placeholder: "One company or URL per line; the agent can discover more" },
      ],
      quickStarts: [
        "Map the competitive landscape and identify the clearest positioning whitespace.",
        "Build a decision-ready intelligence report for the market defined below.",
        "Turn the attached intelligence into a proposal and practical delivery scope.",
      ],
      deliverables: ["Evidence-backed intelligence or scope", "Competitive map and prioritized recommendations"],
      estimate: "~20–35 min",
      attachments: generalAttachments,
    },
  },
];

/**
 * The X agent (e13) runs on stored intake (the client's "X agent data" page),
 * so its launch flow gets a setup gate the other agents don't need. Client-safe
 * twin of the server-side isXAgent in agent-service/x-agent-context.ts.
 */
export function isXAgentIdentity(key: string): boolean {
  return key === "karos-x-agent";
}

/**
 * The submit cores refuse un-set-up X runs with a message starting with this
 * prefix; the run dialog detects it to offer a way into the agent data. One
 * constant so copy edits cannot silently break that affordance.
 */
export const X_SETUP_REQUIRED_PREFIX = "Set up the X agent data";

/**
 * The LinkedIn agents (e10) run on stored intake the same way. Client-safe
 * twin of the server-side isLinkedInAgent in
 * agent-service/linkedin-agent-context.ts.
 */
export function isLinkedInAgentIdentity(key: string): boolean {
  return key === "karos-linkedin-agent" || key.startsWith("karos-linkedin-company-");
}

/** The e10 twin of X_SETUP_REQUIRED_PREFIX. */
export const LINKEDIN_SETUP_REQUIRED_PREFIX = "Set up the LinkedIn agent data";

/**
 * The Reddit agent (e15) runs on stored intake the same way. Client-safe twin
 * of the server-side isRedditAgent in agent-service/reddit-agent-context.ts.
 */
export function isRedditAgentIdentity(key: string): boolean {
  return key === "karos-reddit-agent";
}

/**
 * The e15 twin of X_SETUP_REQUIRED_PREFIX. Keep these three as literal string
 * constants: agent-intake-gate.test.ts regex-matches them out of the submit
 * cores' source, so folding them into a shared helper makes that matcher find
 * nothing and throw.
 */
export const REDDIT_SETUP_REQUIRED_PREFIX = "Set up the Reddit agent data";

/**
 * What a client is allowed to read of a scheduler refusal. The scheduler stores
 * whatever the submit core refused with, which includes internal strings —
 * service URLs, env var names, upstream provider errors. Only the three setup
 * refusals and the three credit denials are written for a client to read; every
 * other message collapses to one plain sentence.
 *
 * Applied server-side, before the row is serialized: a string that never leaves
 * the server cannot be read out of the RSC payload.
 */
function isClientReadableRefusal(message: string): boolean {
  return (
    message.startsWith(X_SETUP_REQUIRED_PREFIX) ||
    message.startsWith(LINKEDIN_SETUP_REQUIRED_PREFIX) ||
    message.startsWith(REDDIT_SETUP_REQUIRED_PREFIX) ||
    isCreditDenialMessage(message)
  );
}

export function clientSafeRefusal(refusal: string): string {
  return isClientReadableRefusal(refusal)
    ? refusal
    : "This agent could not start on its last scheduled run. Your Karos team can unblock it.";
}

/**
 * The manual-run twin of clientSafeRefusal: a client who fires a run must never
 * receive the submit core's internal strings — service URLs, env var names
 * ("AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN"), upstream provider errors — which
 * now reach the client's own run dialog. F34 mounts the run controls during an
 * outage, so the honest failure is a client-safe line, not a raw config error.
 * The same allowlist passes setup refusals and credit denials through verbatim
 * (both are written for the client and the dialog links off the setup ones).
 */
export function clientSafeRunError(error: string): string {
  return isClientReadableRefusal(error) ? error : CLIENT_RUN_REFUSAL_MESSAGE;
}

/**
 * The one sentence a client gets for a run their press could not start.
 *
 * It used to end "Your Karos team has been notified." — and on this path
 * nothing notified anyone: no email, no Slack, no task, no activity row, not
 * even a logger. Every agent-service outage, timeout and 5xx landed here, so
 * the strongest promise in the product sat on the path with the least backing
 * behind it, while the SCHEDULED twin (notifyScheduleFireFailure, fired from
 * the run-scheduled and scheduler routes) pairs a weaker sentence with a real
 * alert. Neither existing notifier fits a client-fired run — one wants a
 * `scheduleId` this path has none of and would email "Scheduled run failed to
 * fire" about a manual press; the other stamps `INTEL_GENERATION` /
 * "Workspace update didn't finish" onto the client's timeline — so the
 * sentence is now one the code can keep, and it hands the client the two
 * things they can actually do. A ContactUsButton already sits in both cards
 * that render this.
 */
export const CLIENT_RUN_REFUSAL_MESSAGE =
  "This run could not be started right now. Try again shortly, or contact your Karos team.";

/**
 * The one sentence a client gets when a WRITE they asked the copilot for did not
 * land — today, `edit_output` saving a revised deliverable.
 *
 * WHY A FOURTH SENTENCE, since reusing one is normally the right answer. The
 * three above all name a RUN or a POST: `clientSafeRefusal` says "could not start
 * on its last scheduled run", `clientSafeRunError` says "this run could not be
 * started", `clientSafePublishError` says "this post didn't go out as scheduled".
 * A client who asked the copilot to reword a caption started no run and posted
 * nothing, so all three would describe an event that did not happen — which is
 * the "tells the client something false" half of the defect, not a fix for the
 * "leaks internals" half. The shape is genuinely new; the WORDING deliberately is
 * not, so the two read as one product voice.
 *
 * Same rules as its siblings: no promise the code does not keep (nothing here
 * notifies anyone — the caller logs the real error for staff instead), and the
 * two things the client can actually do.
 *
 * Kept in this module because this is where the client-safe failure vocabulary
 * already lives — despite the filename, which is now narrower than the file. All
 * four sentences being findable in one place is worth more than a tidy name.
 */
export const CLIENT_SAVE_REFUSAL_MESSAGE =
  "That change couldn't be saved right now. Try again shortly, or contact your Karos team.";

/**
 * What a client is allowed to read of a FAILED PUBLISH — the publish twin of
 * clientSafeRefusal above.
 *
 * `Asset.publishError` holds whatever the platform SDK threw: "Could not
 * determine LinkedIn person URN", "No Instagram Business Account linked to any
 * page", "Media container failed: <Meta's own message>", "Publisher not
 * implemented for platform: <x>". The codebase already classes the field as
 * internal — redactLockedAsset excludes it by construction — but that redaction
 * only covers LOCKED assets, and a failed publish is by definition past due,
 * so every one of them took the un-redacted path.
 *
 * The client still learns their post did not go out and that Karos can get it
 * out; what they no longer read is the exception. The ONE allowlisted string is
 * the ordering hold, which is composed as client copy in the first place
 * (publishHoldMessage) and explains a benign, self-clearing wait.
 *
 * Applied at the server boundary — asset-visibility.ts's two client
 * projections — so the raw string never reaches the RSC payload. Staff
 * surfaces read the asset un-projected and keep the exception.
 */
export function clientSafePublishError(publishError: string): string {
  return isPublishHold(publishError) ? publishError : CLIENT_PUBLISH_FAILURE_MESSAGE;
}

export const CLIENT_PUBLISH_FAILURE_MESSAGE =
  "This post didn't go out as scheduled. Your Karos team can get it posted.";

/**
 * Key prefixes of the per-client agent instances: one imported customAgents doc
 * per client, named after that client's lab-repo folder
 * (karos-linkedin-company-<agentsRepoSlug>). The instance's entry skill is
 * baked under that folder, so the pair is fixed — the instance can only draft
 * for the client its key names.
 */
const PER_CLIENT_AGENT_KEY_PREFIXES = ["karos-linkedin-company-"];

/**
 * The lab-repo client slug a per-client agent instance is bound to, or null
 * when the key names no single client: every agent that is not an instance
 * (karos-x-agent, the LinkedIn master, reddit, tiktok, instagram,
 * branded-shorts, landing-builder…) plus a bare prefix with no slug after it.
 */
export function perClientAgentSlug(key: string): string | null {
  for (const prefix of PER_CLIENT_AGENT_KEY_PREFIXES) {
    if (!key.startsWith(prefix)) continue;
    return normalizeLabSlug(key.slice(prefix.length)) || null;
  }
  return null;
}

/**
 * Whether `agentKey` may run for the client whose lab-repo slug is
 * `clientSlug`. Agents bound to no client run for every client; an instance
 * runs only for its own, so a client with no slug set matches no instance.
 * Both the agent list on the agents page and the submit core's refusal read
 * this one predicate, so a card is never offered that the server would reject.
 */
export function agentKeyMatchesClientSlug(
  agentKey: string,
  clientSlug: string | null | undefined,
): boolean {
  const boundTo = perClientAgentSlug(agentKey);
  return boundTo === null || boundTo === normalizeLabSlug(clientSlug);
}

/**
 * Every launch profile, generic fallback included. Exported so guard tests can
 * sweep the whole set — a square-bracket placeholder that reaches a client
 * ("Focus this batch on [person]'s seat.") reads as an unfinished feature, and
 * a quick-start chip carrying one puts the literal token into the agent prompt.
 */
export const ALL_LAUNCH_PROFILES: readonly AgentLaunchProfile[] = [
  ...profiles.map((entry) => entry.profile),
  genericProfile,
];

export function launchProfileFor(agent: AgentIdentity): AgentLaunchProfile {
  const identity = `${agent.key} ${agent.name}`.toLowerCase();
  const matched = profiles.find((entry) => entry.matches(identity))?.profile;
  if (matched) return matched;
  return {
    ...genericProfile,
    eyebrow: `${agent.name} work order`,
    intro: `Tell ${agent.name} exactly what success looks like. Its saved playbook and this client's brand context are applied automatically.`,
  };
}

export function initialAgentBrief(profile: AgentLaunchProfile): Record<string, string> {
  return Object.fromEntries(
    profile.fields
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.key, field.defaultValue as string]),
  );
}

export function buildCustomAgentPrompt(
  profile: AgentLaunchProfile,
  values: Record<string, string>,
): string {
  return profile.fields
    .map((field) => ({ label: field.label, value: values[field.key]?.trim() }))
    .filter((entry): entry is { label: string; value: string } => Boolean(entry.value))
    .map((entry) => `${entry.label}\n${entry.value}`)
    .join("\n\n");
}
