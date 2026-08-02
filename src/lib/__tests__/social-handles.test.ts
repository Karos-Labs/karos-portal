import { describe, expect, it } from "vitest";
import { socialAccount, socialHandle, socialHandleValue } from "@/lib/social-handles";

/**
 * AF-4's shortening rule, asked of the shapes the field actually holds.
 *
 * `client.socialLinks` is free text written by four surfaces, so every case
 * below is a value this parser has to survive rather than a hypothetical — and
 * the ones that CANNOT be parsed matter just as much, because the panel still
 * has to render them.
 */

describe("a full link becomes the username", () => {
  it("shortens the plain profile URLs", () => {
    expect(socialHandle("instagram", "https://www.instagram.com/karoslabs/")).toBe("@karoslabs");
    expect(socialHandle("instagram", "instagram.com/karoslabs")).toBe("@karoslabs");
    expect(socialHandle("x", "https://x.com/karoslabs")).toBe("@karoslabs");
    expect(socialHandle("tiktok", "https://www.tiktok.com/@karoslabs")).toBe("@karoslabs");
    expect(socialHandle("facebook", "https://facebook.com/karos.labs")).toBe("@karos.labs");
    expect(socialHandle("youtube", "https://www.youtube.com/@karoslabs")).toBe("@karoslabs");
  });

  it("reads twitter.com as X, because the field still holds both", () => {
    const account = socialAccount("x", "https://twitter.com/karoslabs");
    expect(account?.handle).toBe("@karoslabs");
    // Rebuilt on the current domain — the stored row is old, the link should
    // not be.
    expect(account?.url).toBe("https://x.com/karoslabs");
  });

  it("keeps LinkedIn's /in/ and /company/ apart", () => {
    // The whole reason LinkedIn is in this list: both are "the profile", and a
    // company page rebuilt as /in/ is a 404 with somebody else's name on it.
    expect(socialAccount("linkedin", "https://www.linkedin.com/company/karos-labs/")).toEqual({
      handle: "@karos-labs",
      value: "karos-labs",
      url: "https://linkedin.com/company/karos-labs",
    });
    expect(socialAccount("linkedin", "https://www.linkedin.com/in/ada-lovelace/")).toEqual({
      handle: "@ada-lovelace",
      value: "ada-lovelace",
      url: "https://linkedin.com/in/ada-lovelace",
    });
  });

  it("drops the tracking junk a pasted link carries", () => {
    expect(socialHandle("instagram", "https://instagram.com/karoslabs?igsh=MXY4bTk")).toBe(
      "@karoslabs",
    );
    expect(socialHandle("x", "https://x.com/karoslabs#main")).toBe("@karoslabs");
  });
});

describe("a bare handle is left alone", () => {
  it("renders with exactly one @", () => {
    expect(socialHandle("instagram", "karoslabs")).toBe("@karoslabs");
    expect(socialHandle("instagram", "@karoslabs")).toBe("@karoslabs");
    // Somebody pasting "@@karoslabs" gets one back, not three.
    expect(socialHandle("instagram", "@@karoslabs")).toBe("@karoslabs");
  });

  it("still builds a profile URL from it", () => {
    expect(socialAccount("instagram", "@karoslabs")?.url).toBe("https://instagram.com/karoslabs");
    // The two platforms whose URLs carry the @ themselves.
    expect(socialAccount("tiktok", "karoslabs")?.url).toBe("https://tiktok.com/@karoslabs");
    expect(socialAccount("youtube", "karoslabs")?.url).toBe("https://youtube.com/@karoslabs");
    // A bare LinkedIn slug is a company page: that is what a client's LinkedIn
    // is, and /in/ would be guessing a person.
    expect(socialAccount("linkedin", "karos-labs")?.url).toBe(
      "https://linkedin.com/company/karos-labs",
    );
  });
});

describe("what cannot be parsed is not discarded", () => {
  it("returns nothing for empty text", () => {
    expect(socialAccount("instagram", "")).toBeNull();
    expect(socialAccount("instagram", "   ")).toBeNull();
    expect(socialAccount("instagram", "@")).toBeNull();
    // A bare host with no profile on it names no account.
    expect(socialAccount("instagram", "https://instagram.com/")).toBeNull();
  });

  it("opens a link on an unexpected host exactly as stored", () => {
    // A linktree, an agency's landing page, a regional domain — the client put
    // it there, so rebuilding it on the platform's domain from a segment that
    // may not be a handle would send them somewhere that does not exist.
    const account = socialAccount("instagram", "https://linktr.ee/karoslabs");
    expect(account?.url).toBe("https://linktr.ee/karoslabs");
    expect(account?.handle).toBe("@karoslabs");
  });

  it("gives the panel something to render either way", () => {
    // The display contract: unparseable text keeps its characters. The panel
    // renders a chip with no link rather than dropping the row.
    expect(socialHandle("instagram", "ask marketing for it")).toBe("@ask marketing for it");
    expect(socialHandle("instagram", "  spaced  ")).toBe("@spaced");
  });
});

describe("the save path stores the short form", () => {
  it("writes the handle, not the link", () => {
    expect(socialHandleValue("instagram", "https://www.instagram.com/karoslabs/")).toBe(
      "karoslabs",
    );
    expect(socialHandleValue("linkedin", "https://www.linkedin.com/company/karos-labs/")).toBe(
      "karos-labs",
    );
    // No leading @ in storage — the @ is display.
    expect(socialHandleValue("instagram", "@karoslabs")).toBe("karoslabs");
  });

  it("is idempotent, so re-saving a row does not erode it", () => {
    for (const raw of [
      "https://www.instagram.com/karoslabs/",
      "@karoslabs",
      "karoslabs",
    ]) {
      const once = socialHandleValue("instagram", raw);
      expect(socialHandleValue("instagram", once)).toBe(once);
    }
    const li = socialHandleValue("linkedin", "https://www.linkedin.com/in/ada-lovelace/");
    expect(socialHandleValue("linkedin", li)).toBe(li);
  });

  it("hands back text it could not parse, trimmed and otherwise whole", () => {
    // Normalising is not licence to discard what somebody typed.
    expect(socialHandleValue("instagram", "  ask marketing  ")).toBe("ask marketing");
    expect(socialHandleValue("instagram", "")).toBe("");
  });
});
