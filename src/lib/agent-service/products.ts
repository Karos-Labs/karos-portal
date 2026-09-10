/**
 * Display catalog for the managed products (karos-agents lab products run by
 * the external agent service). Client-safe — imported by UI components and
 * server actions alike. The service's own task-type registry
 * (agent-service/src/task-types.ts) is the execution source of truth; this
 * file only describes the products to humans and drives the submit form.
 */
import type { ManagedTaskType } from "@/lib/types";
import type { AgentAttachmentProfile } from "@/lib/custom-agent-launch";
import { RUN_ESTIMATE } from "@/lib/run-estimate";

/**
 * C4 (SCRUM-212) capability-tag taxonomy, single-sourced here so every place
 * that needs the literal tag list (the `ManagedProduct.capabilities` /
 * `CustomAgent.capabilities` arrays below, and T-B7/SCRUM-251's chat-tool
 * schema and router) draws from one array instead of hand-copying it. See the
 * doc comment on `ManagedProduct.capabilities` below for what each tag means.
 */
export const CAPABILITY_TAGS = [
  "produce_text",
  "produce_image",
  "produce_carousel",
  "produce_video",
  "produce_webpage",
  "produce_report",
] as const;

export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export interface BriefField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select";
  placeholder?: string;
  required?: boolean;
  helper?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  defaultValue?: string;
  /** Serialize a multiline value as an array for agent-service JSON schemas. */
  valueKind?: "string" | "stringList";
}

/**
 * AUDIENCE MARKERS — see platforms.ts for the convention and the guard that
 * reads it. The five `@clientCopy` fields are the ones `managedCatalogEntries()`
 * copies into the `AgentCatalogEntry` that the client copilot's system prompt is
 * built from, so they are read by a model the client is charged for and whose
 * output the client reads.
 *
 * `briefFields` and `inputFiles` carry no markers and are NOT swept: no component
 * renders them and `managedCatalogEntries()` passes only their `key`s to the
 * prompt. Mark those interfaces if that changes.
 */
export interface ManagedProduct {
  taskType: ManagedTaskType;
  /** @clientCopy */
  name: string;
  /** @clientCopy Folded into the catalog description the copilot prompt carries. */
  tagline: string;
  /** @clientCopy Same. */
  description: string;
  /** @notCopy Lucide icon name. */
  icon: string;
  /** @notCopy icon chip color — matches the agents-hub chip treatment */
  color: string;
  /** @clientCopy Written into the prompt as "produces: …". */
  deliverables: string[];
  /** @clientCopy Written into the prompt as "runtime: …". */
  estimate: string;
  briefFields: BriefField[];
  inputFiles: AgentAttachmentProfile;
  /**
   * @notCopy C4 (SCRUM-212) descriptor — capability TAGS, not prose. Written
   * into the prompt as raw identifiers ("capabilities: produce_carousel,
   * produce_video") for the model's own routing/reasoning, exactly the way
   * `taskType`/`id` already are — never a sentence a client reads, so this is
   * classified like `icon`/`color` above rather than like `deliverables`.
   *
   * TAXONOMY (open-ended; add a tag when a new deliverable shape appears):
   *   produce_text     — written copy: captions, articles, emails, replies
   *   produce_image    — a single static visual
   *   produce_carousel — a multi-slide Instagram-style carousel
   *   produce_video    — a video / short-form clip
   *   produce_webpage  — a built page (source + static build)
   *   produce_report   — an internal, non-publishable analysis document
   *
   * Cross-referenced against agent-engine's own finer-grained catalog
   * (`agent-engine/materialize.ts`'s `PRODUCT_DELIVERABLES`, not imported here
   * — a different subsystem's dispatch table, read only to keep these tags
   * honest) so this stays a real assignment, not a placeholder: the
   * `social_post` taskType fans out at the engine to `instagram-agent`
   * (kind `instagram-carousel`), `branded-shorts-agent`/`tiktok-agent` (video),
   * and `x-agent`/`linkedin-agent`/`reddit-agent` (text) — hence all three
   * tags on this one catalog entry. `landing_page` fans out to
   * `landing-builder-agent` (kind `landing-page-site`) only.
   *
   * ASSUMPTION (state explicitly per EXEC-CONTEXT): no ratified C4 spec doc
   * exists in this repo as of T-B6/SCRUM-250 — SCRUM-212's PR is still at
   * Code Review. This taxonomy and the sibling `platforms`/`consumesMedia`/
   * `requiredInputs` fields below are inferred from the ticket text's own
   * vocabulary, not ratified; treat them as this batch's working contract.
   */
  capabilities: string[];
  /**
   * @notCopy Canonical platform keys this product targets (same identifiers
   * `ClientIntegration.platform` and the `create_tasks` `platform` enum use).
   * Empty when the product is platform-agnostic — `landing_page` builds a
   * page, not a social post, so it names no platform.
   */
  platforms: string[];
  /** Whether this product's brief can incorporate uploaded image/video media (mirrors `inputFiles.accept`). */
  consumesMedia: boolean;
  /**
   * @notCopy The subset of `briefFields` keys actually required to run this
   * product (`briefFields.filter(f => f.required)`, kept in sync by hand
   * since this file already hand-authors every other field below) — the flat
   * key-list form T-B7 needs to prompt for missing inputs. `AgentInputDef` in
   * `agent-engine/middleware-admin.ts` is a differently-shaped, unrelated
   * concept (the agent-middleware admin control plane's own per-field
   * metadata) — do not confuse the two.
   */
  requiredInputs: string[];
}

/**
 * The managed-product catalog. `name`, `tagline`, `description`, `deliverables`
 * and `estimate` are CLIENT copy, and the surface that makes them so is not a
 * screen: `managedCatalogEntries()` (agent-roster.ts) folds `tagline` and
 * `description` into the `AgentCatalogEntry` that `buildProactiveSystemAppendix`
 * writes into the copilot's system prompt — the same model a CLIENT_USER's dock
 * talks to, which paraphrases whatever it is handed. Two descriptions carried a
 * spaced hyphen for exactly that reason: nothing renders them, so no render
 * review ever looked at them.
 */
export const MANAGED_PRODUCTS: ManagedProduct[] = [
  {
    taskType: "social_post",
    name: "Social posts",
    tagline: "Instagram & TikTok content from the client's content system",
    description:
      "Runs the Instagram/TikTok content agent: researches what's working, then produces ready-to-review posts. Visual, caption, and hashtags. Using the client's emitted generators when they exist.",
    icon: "Camera",
    color: "#E879F9",
    deliverables: ["Post visual per item", "caption.txt + about.txt per item", "Research trail (internal)"],
    estimate: RUN_ESTIMATE,
    briefFields: [
      { key: "count", label: "Number of posts", type: "number", min: 1, max: 10, placeholder: "3", defaultValue: "3" },
      {
        key: "platform",
        label: "Platform",
        type: "select",
        defaultValue: "both",
        options: [
          { value: "both", label: "Instagram + TikTok" },
          { value: "instagram", label: "Instagram" },
          { value: "tiktok", label: "TikTok" },
        ],
      },
      {
        key: "post_type",
        label: "Existing format",
        type: "text",
        placeholder: "e.g. expert-tips",
        helper: "Use the exact emitted format name, or leave empty and let the agent choose the best lane.",
      },
      { key: "topic", label: "Topic", type: "text", placeholder: "e.g. spring collection launch", helper: "Leave empty to let the agent pick from the client's content plan." },
    ],
    inputFiles: {
      label: "Creative inputs",
      hint: "Attach approved product photos, campaign briefs, or source material the posts should use.",
      accept: ".pdf,.txt,.md,.csv,image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,.mp4,.mov",
    },
    capabilities: ["produce_carousel", "produce_video", "produce_text"],
    platforms: ["instagram", "tiktok"],
    consumesMedia: true,
    // No brief field is marked `required` — the agent can pick topic/format
    // itself from the client's content plan when the client leaves them blank.
    requiredInputs: [],
  },
  {
    taskType: "landing_page",
    name: "Landing page",
    tagline: "A complete page, built on the client's brand kit",
    description:
      "Runs the landing-page builder with the taste and brand vendor skills: full page source plus a static build, styled from the client's brand guidelines when present.",
    icon: "LayoutTemplate",
    color: "#FBBF24",
    deliverables: ["Page source + static build", "Build/run README", "Design rationale (internal)"],
    estimate: RUN_ESTIMATE,
    briefFields: [
      { key: "page_goal", label: "Page goal", type: "text", required: true, placeholder: "e.g. collect demo bookings" },
      { key: "offer", label: "Offer", type: "textarea", placeholder: "What the page promises, including important terms" },
      {
        key: "sections",
        label: "Required sections",
        type: "textarea",
        placeholder: "One per line: Hero, proof, how it works, FAQ…",
        valueKind: "stringList",
      },
      {
        key: "reference_urls",
        label: "Reference URLs",
        type: "textarea",
        placeholder: "One https:// URL per line",
        helper: "Existing site, offer detail, or design inspiration. Only HTTPS links are accepted.",
        valueKind: "stringList",
      },
    ],
    inputFiles: {
      label: "Brand and page assets",
      hint: "Attach logos, product images, brand guidelines, testimonials, or an approved wireframe.",
      accept: ".pdf,.doc,.docx,.txt,.md,image/png,image/jpeg,image/webp,image/svg+xml,.svg",
    },
    capabilities: ["produce_webpage"],
    // Not a social-channel deliverable — no platform applies.
    platforms: [],
    consumesMedia: true,
    requiredInputs: ["page_goal"],
  },
];

export function getManagedProduct(taskType: ManagedTaskType): ManagedProduct {
  return MANAGED_PRODUCTS.find((p) => p.taskType === taskType) ?? MANAGED_PRODUCTS[0];
}

/** agentId used on the mirrored platform `jobs` docs for managed runs. */
export const AGENT_SERVICE_AGENT_ID = "agent-service";
