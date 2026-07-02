import { describe, it, expect } from "vitest";

import type { Client, ClientReport } from "@/lib/types";
import { mergeNewsletterConfig } from "../defaults";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const baseClient: Client = {
  id: "c1",
  name: "Northwind",
  website: "https://northwind.com",
  industry: "Logistics",
  contactEmail: "hello@northwind.com",
  description: "Northwind moves freight for mid-market manufacturers.",
  accentColor: "#1d4ed8",
  assignedEmployeeIds: [],
  status: "active",
  createdAt: 0,
  createdBy: "u1",
};

const darkBrandClient: Client = {
  ...baseClient,
  brandingGuidelines: {
    primaryColor: "#ff6600",
    uiBackground: "#0a0a0a", // dark
    uiText: "#fafafa", // light
    fontHeading: "Playfair Display",
    fontBody: "Inter",
    visualStyle: "Bold",
    toneKeywords: ["Bold", "Challenger", "Direct"],
    guidelines: "## Brand Voice\nWe speak plainly and back claims with data.\n\n## Do's\n- Use data\n\n## Don'ts\n- Use corporate jargon\n- Make hype claims",
    updatedAt: 0,
  },
};

const lightBrandClient: Client = {
  ...baseClient,
  brandingGuidelines: {
    primaryColor: "#e91e8c",
    uiBackground: "#ffffff", // light
    uiText: "#09090b", // dark
    fontHeading: "Montserrat",
    fontBody: "Open Sans",
    visualStyle: "Warm",
    toneKeywords: ["Warm", "Human"],
    updatedAt: 0,
  },
};

const report: ClientReport = {
  id: "r1",
  clientId: "c1",
  reportDate: "2026-01-01",
  businessType: "Freight brokerage",
  overallScore: 70,
  overallGrade: "B",
  dimensionScores: [],
  competitorRankings: [],
  contentAnalysis: "",
  conversionAnalysis: "",
  seoAnalysis: "",
  geoAnalysis: "",
  positioningAnalysis: "",
  brandAnalysis: "",
  growthAnalysis: "",
  swot: { strengths: [], weaknesses: [], opportunities: ["Own the 'sustainable freight' topic"], threats: [] },
  recommendations: [],
  whitespaceOpportunities: ["No competitor publishes a rate-benchmark guide", "Own the 'sustainable freight' topic"],
  rawMarkdown: "",
  createdAt: 0,
  updatedAt: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeNewsletterConfig prefill", () => {
  it("fills the required brand fields from a dark-mode brand profile", () => {
    const { brand } = mergeNewsletterConfig(darkBrandClient, null);
    expect(brand._meta.company_name).toBe("Northwind");
    expect(brand.palette.gold).toBe("#ff6600"); // accent
    expect(brand.palette.navy).toBe("#0a0a0a"); // dark background → dark base
    expect(brand.palette.cream).toBe("#fafafa"); // light text → light surface
    expect(brand.fonts.display.family).toBe("Playfair Display");
    expect(brand.fonts.display.stack).toContain("'Playfair Display'");
    expect(brand.fonts.body.family).toBe("Inter");
    expect(brand.fonts.google_fonts_href).toContain("Playfair+Display");
    expect(brand.site_url).toBe("https://northwind.com");
    expect(brand.voice.archetype).toContain("plainly");
    expect(brand.sender.from_name).toBe("Northwind");
    expect(brand.sender.from_email).toBe("hello@northwind.com");
  });

  it("inverts navy/cream for a light-mode brand", () => {
    const { brand } = mergeNewsletterConfig(lightBrandClient, null);
    expect(brand.palette.cream).toBe("#ffffff"); // light background → light surface
    expect(brand.palette.navy).toBe("#09090b"); // dark text → dark base
    expect(brand.palette.gold).toBe("#e91e8c");
  });

  it("leaves the brand one field (legal disclaimer) away from ready", async () => {
    const { missingBrandFields } = await import("../brand");
    const { brand } = mergeNewsletterConfig(darkBrandClient, null);
    expect(missingBrandFields(brand)).toEqual(["compliance.disclaimer_pt"]);
  });

  it("maps tone keywords to a dominant editorial register", () => {
    expect(mergeNewsletterConfig(darkBrandClient, null).foundation.voiceRegister).toBe("challenger");
    expect(mergeNewsletterConfig(lightBrandClient, null).foundation.voiceRegister).toBe("warm");
  });

  it("seeds the foundation from description, don'ts and the intel report", () => {
    const { foundation } = mergeNewsletterConfig(darkBrandClient, null, { report });
    expect(foundation.whoTheyAre).toContain("freight");
    // base rules + the AI "don'ts" (prefixed with "Avoid:" when not already imperative)
    expect(foundation.voiceHardRules.some((r) => /corporate jargon/i.test(r))).toBe(true);
    // whitespace + SWOT opportunities, deduped, become seed topics
    expect(foundation.seedTopics).toContain("No competitor publishes a rate-benchmark guide");
    expect(foundation.seedTopics).toContain("Own the 'sustainable freight' topic");
    expect(foundation.seedTopics).toHaveLength(2);
  });

  it("lets a stored save win over the prefill but still prefills an opt-in-only doc", () => {
    // Full stored brand (user cleared the accent on purpose) wins.
    const stored = mergeNewsletterConfig(darkBrandClient, {
      brand: { palette: { gold: "" } },
    } as never);
    expect(stored.brand.palette.gold).toBe("");

    // A doc that only carries optIn (no brand) still receives the full prefill.
    const optInOnly = mergeNewsletterConfig(darkBrandClient, { optIn: true });
    expect(optInOnly.optIn).toBe(true);
    expect(optInOnly.brand.palette.gold).toBe("#ff6600");
  });
});
