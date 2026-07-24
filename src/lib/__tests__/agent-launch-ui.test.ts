import { describe, expect, it } from "vitest";
import {
  buildCustomAgentPrompt,
  initialAgentBrief,
  launchProfileFor,
} from "@/lib/custom-agent-launch";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";

describe("custom agent launch profiles", () => {
  it("gives known agents purpose-built fields and attachment guidance", () => {
    const instagram = launchProfileFor({ key: "karos-instagram-agent", name: "Instagram Agent" });
    const linkedin = launchProfileFor({ key: "karos-linkedin-agent", name: "LinkedIn Agent" });
    const shorts = launchProfileFor({ key: "branded-shorts", name: "Branded Shorts" });
    const x = launchProfileFor({ key: "karos-x-agent", name: "X Agent" });

    expect(instagram.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(["run_mode", "request", "platform", "post_count"]),
    );
    expect(linkedin.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(["executive", "request", "proof"]),
    );
    expect(shorts.attachments.required).toBe(true);
    expect(shorts.attachments.satisfyWithFieldKey).toBe("source_url");
    // The X agent is intake-driven (its data page holds handles, off-limits,
    // rosters, takes) — the launch brief only scopes the run. It must never
    // ask for things the agent BUILDS (audience, themes, cadence) or already
    // stores (account handles).
    expect(x.fields.map((field) => field.key)).toEqual(["run_scope", "request"]);
    expect(x.fields.map((field) => field.key)).not.toEqual(
      expect.arrayContaining(["account", "audience", "themes", "cadence"]),
    );
    expect(new Set([instagram.eyebrow, linkedin.eyebrow, shorts.eyebrow, x.eyebrow]).size).toBe(4);
  });

  it("keeps unknown imported agents runnable with a complete fallback brief", () => {
    const profile = launchProfileFor({ key: "future-agent", name: "Future Agent" });
    expect(profile.fields.find((field) => field.key === "request")?.required).toBe(true);
    expect(profile.fields.map((field) => field.key)).toContain("success_criteria");
    expect(profile.attachments.label).toBe("Reference files");
  });

  it("does not let broad words route specialized agents to the wrong brief", () => {
    const amazon = launchProfileFor({ key: "karos-amazon-mgmt", name: "Amazon Listing & Ads Management" });
    const reputation = launchProfileFor({ key: "karos-reputation", name: "Brand Reputation Monitoring" });
    const intel = launchProfileFor({ key: "karos-intel", name: "Digital Intelligence Report" });

    expect(amazon.eyebrow).toBe("Marketplace brief");
    expect(reputation.eyebrow).toBe("Reputation brief");
    expect(intel.eyebrow).toBe("Market intelligence brief");
  });

  it("serializes guided answers into the service prompt without losing labels", () => {
    const profile = launchProfileFor({ key: "karos-linkedin-agent", name: "LinkedIn Agent" });
    const values = {
      ...initialAgentBrief(profile),
      executive: "Maya Chen, CEO",
      request: "Explain the lesson from our enterprise rollout.",
      audience: "Operations leaders",
    };
    const prompt = buildCustomAgentPrompt(profile, values);

    expect(prompt).toContain("Executive or account\nMaya Chen, CEO");
    expect(prompt).toContain("Point of view or outcome\nExplain the lesson");
    expect(prompt).toContain("Audience\nOperations leaders");
  });
});

describe("managed product launch profiles", () => {
  it("keeps every managed agent's brief and file request distinct", () => {
    const fieldSignatures = MANAGED_PRODUCTS.map((product) =>
      product.briefFields.map((field) => field.key).join(","),
    );
    const fileLabels = MANAGED_PRODUCTS.map((product) => product.inputFiles.label);

    expect(new Set(fieldSignatures).size).toBe(MANAGED_PRODUCTS.length);
    expect(new Set(fileLabels).size).toBe(MANAGED_PRODUCTS.length);
  });

  it("exposes the richer schema-backed landing-page inputs", () => {
    const landing = MANAGED_PRODUCTS.find((product) => product.taskType === "landing_page");
    expect(landing?.briefFields.map((field) => field.key)).toEqual([
      "page_goal",
      "offer",
      "sections",
      "reference_urls",
    ]);
    expect(landing?.briefFields.find((field) => field.key === "reference_urls")?.valueKind).toBe(
      "stringList",
    );
  });
});
