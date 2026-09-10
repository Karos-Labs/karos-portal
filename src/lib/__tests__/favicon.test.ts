import { describe, expect, it } from "vitest";
import { brandFaviconUrl, domainFromName, faviconUrl } from "@/lib/favicon";

function host(url: string | null): string | null {
  if (!url) return null;
  return new URL(url).searchParams.get("domain");
}

describe("domainFromName", () => {
  it("accepts a name that is itself a domain", () => {
    expect(domainFromName("ploy.ai")).toBe("ploy.ai");
    expect(domainFromName("Okara.ai")).toBe("okara.ai");
    expect(domainFromName("notion.so")).toBe("notion.so");
    expect(domainFromName("app.getcursor.com")).toBe("app.getcursor.com");
  });

  it("tolerates a scheme or a trailing slash", () => {
    expect(domainFromName("https://ploy.ai")).toBe("ploy.ai");
    expect(domainFromName("ploy.ai/")).toBe("ploy.ai");
  });

  it("refuses anything that is not a single dotted token", () => {
    // A false positive here fetches an unrelated company's logo.
    expect(domainFromName("Acme Inc.")).toBeNull();
    expect(domainFromName("U.S. Bank")).toBeNull();
    expect(domainFromName("Speedrun by a16z")).toBeNull();
    expect(domainFromName("Karos Labs")).toBeNull();
    expect(domainFromName("ploy")).toBeNull();
    expect(domainFromName("")).toBeNull();
    expect(domainFromName(undefined)).toBeNull();
  });
});

describe("brandFaviconUrl", () => {
  it("prefers the stored website", () => {
    expect(host(brandFaviconUrl("https://real.example", "other.ai"))).toBe("real.example");
  });

  it("falls back to a domain-shaped name when there is no website", () => {
    expect(host(brandFaviconUrl(undefined, "ploy.ai"))).toBe("ploy.ai");
    expect(host(brandFaviconUrl("   ", "Okara.ai"))).toBe("okara.ai");
  });

  it("returns null when neither resolves", () => {
    expect(brandFaviconUrl(null, "Karos Labs")).toBeNull();
  });

  it("keeps faviconUrl's own contract", () => {
    expect(faviconUrl("localhost")).toBeNull();
    expect(host(faviconUrl("acme.test"))).toBe("acme.test");
  });
});
