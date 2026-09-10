import { describe, expect, it } from "vitest";
import { competitorBrandKeys, looksLikeUrlInput, parseCompetitorInput } from "../competitor-input";
import { brandKeys } from "../seo-geo";

describe("looksLikeUrlInput", () => {
  it("detects full URLs, bare domains, and domains with paths", () => {
    expect(looksLikeUrlInput("https://speedrun.a16z.com/program")).toBe(true);
    expect(looksLikeUrlInput("http://whop.com")).toBe(true);
    expect(looksLikeUrlInput("speedrun.a16z.com")).toBe(true);
    expect(looksLikeUrlInput("en.mapstr.com/app")).toBe(true);
    expect(looksLikeUrlInput("Amazon.com")).toBe(true);
  });

  it("treats plain names as names", () => {
    expect(looksLikeUrlInput("Whop")).toBe(false);
    expect(looksLikeUrlInput("Speedrun by a16z")).toBe(false);
    expect(looksLikeUrlInput("a16z")).toBe(false);
    expect(looksLikeUrlInput("")).toBe(false);
  });
});

describe("parseCompetitorInput", () => {
  it("normalizes URL input to a hostname company + url (favicon-ready)", () => {
    expect(parseCompetitorInput("https://speedrun.a16z.com/program?x=1")).toEqual({
      company: "speedrun.a16z.com",
      url: "speedrun.a16z.com",
    });
    expect(parseCompetitorInput("https://www.calcalist.co.il")).toEqual({
      company: "calcalist.co.il",
      url: "calcalist.co.il",
    });
    expect(parseCompetitorInput("whop.com")).toEqual({ company: "whop.com", url: "whop.com" });
  });

  it("passes plain names through untouched", () => {
    expect(parseCompetitorInput("  Speedrun by a16z ")).toEqual({ company: "Speedrun by a16z" });
  });

  it("keys a pasted URL to the same brand as its resolved analysis row", () => {
    // The duplicate guarantee: the raw-URL manual row and the AI's resolved row
    // must share an identity key so the merge collapses them into one.
    const pasted = parseCompetitorInput("https://speedrun.a16z.com/whatever");
    const rawKeys = brandKeys(pasted.company, pasted.url);
    const resolvedKeys = brandKeys("Speedrun by a16z", "speedrun.a16z.com");
    expect(rawKeys.some((k) => resolvedKeys.includes(k))).toBe(true);
  });
});

describe("competitorBrandKeys (legacy raw-URL rows)", () => {
  it("keys a legacy raw-URL manual row to the same brand as its resolved twin", () => {
    const legacy = competitorBrandKeys("https://speedrun.a16z.com/apply", undefined);
    const resolved = competitorBrandKeys("Speedrun by a16z", "speedrun.a16z.com");
    expect(legacy.some((k) => resolved.includes(k))).toBe(true);
  });

  it("matches brandKeys exactly for normal rows", () => {
    expect(competitorBrandKeys("Whop", "whop.com")).toEqual(["whop"]);
    expect(competitorBrandKeys("Speedrun by a16z")).toEqual(["speedrunbya16z"]);
  });
});
