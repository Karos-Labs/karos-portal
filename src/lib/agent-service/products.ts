/**
 * Display catalog for the managed products (karos-agents lab products run by
 * the external agent service). Client-safe — imported by UI components and
 * server actions alike. The service's own task-type registry
 * (agent-service/src/task-types.ts) is the execution source of truth; this
 * file only describes the products to humans and drives the submit form.
 */
import type { ManagedTaskType } from "@/lib/types";

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
}

export interface ManagedProduct {
  taskType: ManagedTaskType;
  name: string;
  tagline: string;
  description: string;
  icon: string;
  /** icon chip color — matches the agents-hub chip treatment */
  color: string;
  deliverables: string[];
  estimate: string;
  briefFields: BriefField[];
}

export const MANAGED_PRODUCTS: ManagedProduct[] = [
  {
    taskType: "social_post",
    name: "Social posts",
    tagline: "Instagram & TikTok content from the client's content system",
    description:
      "Runs the Instagram/TikTok content agent: researches what's working, then produces ready-to-review posts — visual, caption, and hashtags — using the client's emitted generators when they exist.",
    icon: "Camera",
    color: "#E879F9",
    deliverables: ["Post visual per item", "caption.txt + about.txt per item", "Research trail (internal)"],
    estimate: "~10–25 min",
    briefFields: [
      { key: "count", label: "Number of posts", type: "number", min: 1, max: 10, placeholder: "3" },
      {
        key: "platform",
        label: "Platform",
        type: "select",
        options: [
          { value: "both", label: "Instagram + TikTok" },
          { value: "instagram", label: "Instagram" },
          { value: "tiktok", label: "TikTok" },
        ],
      },
      {
        key: "topic",
        label: "Topic",
        type: "text",
        placeholder: "e.g. spring collection launch",
        helper: "Leave empty to let the agent pick from the client's content plan.",
      },
    ],
  },
  {
    taskType: "newsletter_issue",
    name: "Newsletter issue",
    tagline: "One branded issue, researched and rendered",
    description:
      "Runs the newsletter agent: fresh industry research, drafts a compliant issue in the client's voice, and renders the HTML in dark + light variants ready for any ESP.",
    icon: "Mail",
    color: "#60A5FA",
    deliverables: ["Issue copy", "Rendered HTML (dark + light)", "Research notes (internal)"],
    estimate: "~10–15 min",
    briefFields: [
      { key: "issue_theme", label: "Issue theme", type: "text", placeholder: "e.g. monthly product roundup" },
      {
        key: "must_include",
        label: "Must include",
        type: "textarea",
        placeholder: "One item per line: announcements, links, dates…",
        helper: "Anything the issue must cover.",
      },
    ],
  },
  {
    taskType: "blog_article",
    name: "Blog article",
    tagline: "SEO-aware article with keyword research built in",
    description:
      "Runs the blog agent: scans the search landscape for the topic, then writes a sourced article in the client's voice — markdown plus rendered HTML.",
    icon: "PenLine",
    color: "#34D399",
    deliverables: ["Article (.md + .html)", "Meta/caption files", "Keyword & SERP research (internal)"],
    estimate: "~10–15 min",
    briefFields: [
      { key: "topic", label: "Topic", type: "text", required: true, placeholder: "What should the article cover?" },
      { key: "target_keyword", label: "Target keyword", type: "text", placeholder: "optional" },
      {
        key: "length",
        label: "Length",
        type: "select",
        options: [
          { value: "standard", label: "Standard" },
          { value: "short", label: "Short" },
          { value: "long", label: "Long" },
        ],
      },
    ],
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
      { key: "offer", label: "Offer", type: "text", placeholder: "what the page promises — optional" },
    ],
  },
];

export function getManagedProduct(taskType: ManagedTaskType): ManagedProduct {
  return MANAGED_PRODUCTS.find((p) => p.taskType === taskType) ?? MANAGED_PRODUCTS[0];
}

/** agentId used on the mirrored platform `jobs` docs for managed runs. */
export const AGENT_SERVICE_AGENT_ID = "agent-service";
