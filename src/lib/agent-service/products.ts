/**
 * Display catalog for the managed products (karos-agents lab products run by
 * the external agent service). Client-safe — imported by UI components and
 * server actions alike. The service's own task-type registry
 * (agent-service/src/task-types.ts) is the execution source of truth; this
 * file only describes the products to humans and drives the submit form.
 */
import type { ManagedTaskType } from "@/lib/types";
import type { AgentAttachmentProfile } from "@/lib/custom-agent-launch";

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
    estimate: "~10–25 min",
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
    estimate: "~15–30 min",
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
  },
];

export function getManagedProduct(taskType: ManagedTaskType): ManagedProduct {
  return MANAGED_PRODUCTS.find((p) => p.taskType === taskType) ?? MANAGED_PRODUCTS[0];
}

/** agentId used on the mirrored platform `jobs` docs for managed runs. */
export const AGENT_SERVICE_AGENT_ID = "agent-service";
