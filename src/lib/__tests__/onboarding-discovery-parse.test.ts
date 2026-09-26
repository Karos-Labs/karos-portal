import { describe, expect, it } from "vitest";
import {
  extractSiteMeta,
  extractSocialProfiles,
  publicWebsiteUrl,
  socialProfileFromUrl,
} from "@/lib/onboarding-discovery-parse";

describe("socialProfileFromUrl", () => {
  it.each([
    ["https://www.instagram.com/acmehq/", "instagram", "acmehq"],
    ["https://instagram.com/acmehq?igsh=MXY4", "instagram", "acmehq"],
    ["https://www.linkedin.com/company/acme-inc/", "linkedin", "company/acme-inc"],
    ["https://il.linkedin.com/company/acme", "linkedin", "company/acme"],
    ["https://twitter.com/acme", "x", "acme"],
    ["https://x.com/acme/status/123", "x", "acme"],
    ["https://www.facebook.com/acme.official", "facebook", "acme.official"],
    ["https://www.tiktok.com/@acme", "tiktok", "acme"],
    ["https://www.youtube.com/@acme", "youtube", "acme"],
    ["https://www.youtube.com/channel/UC1234567890abcdefghij", "youtube", "channel/UC1234567890abcdefghij"],
  ])("%s", (url, platform, value) => {
    const got = socialProfileFromUrl(url);
    expect(got?.platform ?? null).toBe(platform);
    expect(got?.value ?? null).toBe(value);
  });

  it.each([
    "https://twitter.com/intent/tweet?text=hi",
    "https://www.facebook.com/sharer/sharer.php?u=x",
    "https://www.linkedin.com/shareArticle?url=x",
    "https://www.linkedin.com/feed/",
    "https://www.instagram.com/p/Cabc123/",
    "https://www.youtube.com/watch?v=abc",
    "https://www.tiktok.com/tag/marketing",
    "https://example.com/instagram",
    "not a url at all",
  ])("is not an account: %s", (url) => {
    expect(socialProfileFromUrl(url)).toBeNull();
  });
});

describe("extractSocialProfiles", () => {
  it("takes the first profile per platform and ignores share buttons", () => {
    const html = `
      <header><a href="https://twitter.com/intent/tweet?url=x">Share</a></header>
      <footer>
        <a href="https://www.instagram.com/acmehq/">IG</a>
        <a href='https://www.linkedin.com/company/acme/'>in</a>
        <a href="https://x.com/acme">X</a>
      </footer>
      <article><a href="https://x.com/someone_else">quoted tweet</a></article>`;
    expect(extractSocialProfiles(html)).toEqual({
      instagram: "acmehq",
      linkedin: "company/acme",
      x: "acme",
    });
  });

  it("finds nothing on a page with no profile links", () => {
    expect(extractSocialProfiles("<a href='/about'>About</a>")).toEqual({});
  });
});

describe("extractSiteMeta", () => {
  const html = `<html><head>
    <title>Acme &amp; Co | Payroll</title>
    <meta name="description" content="Payroll for small teams.">
    <meta property="og:site_name" content="Acme">
    <style>.x{color:red}</style><script>var secret = 1</script>
  </head><body><!-- hidden note --><h1>Pay people on time</h1></body></html>`;

  it("reads title, description, name and visible text only", () => {
    const meta = extractSiteMeta(html);
    expect(meta.title).toBe("Acme & Co | Payroll");
    expect(meta.description).toBe("Payroll for small teams.");
    expect(meta.siteName).toBe("Acme");
    expect(meta.text).toContain("Pay people on time");
    for (const hidden of ["secret", "color:red", "hidden note"]) expect(meta.text).not.toContain(hidden);
  });

  it("caps the text handed to the model", () => {
    expect(extractSiteMeta(`<p>${"word ".repeat(5000)}</p>`, "", "", 100).text.length).toBeLessThanOrEqual(100);
  });
});

describe("publicWebsiteUrl", () => {
  it.each(["acme.com", "https://www.acme.co.il/about", "http://acme.io"])("accepts %s", (v) => {
    expect(publicWebsiteUrl(v)).not.toBeNull();
  });

  it.each([
    "http://169.254.169.254/computeMetadata/v1/",
    "http://127.0.0.1",
    "http://[::1]/",
    "http://localhost:3000",
    "https://metadata.google.internal",
    "http://printer.local",
    "https://acme.com:8443",
    "https://user:pass@acme.com",
    "ftp://acme.com",
    "javascript:alert(1)",
    "",
  ])("refuses %s", (v) => {
    expect(publicWebsiteUrl(v)).toBeNull();
  });
});
