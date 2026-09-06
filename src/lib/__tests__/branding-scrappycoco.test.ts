import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const { instagramUsername, isScrappycocoConfigured, fetchSiteScreenshot, fetchInstagramBrandAssets } = await import(
  "../branding-scrappycoco"
);

describe("instagramUsername", () => {
  it("accepts the shapes a client actually types into the field", () => {
    for (const input of [
      "karoslabs",
      "@karoslabs",
      "https://instagram.com/karoslabs",
      "https://www.instagram.com/karoslabs/",
      "instagram.com/karoslabs?hl=en",
    ]) {
      expect(instagramUsername(input)).toBe("karoslabs");
    }
  });

  it("refuses anything that is not a handle rather than calling the API with it", () => {
    for (const input of [undefined, null, "", "   ", "not a handle", "https://example.com/page"]) {
      expect(instagramUsername(input)).toBeNull();
    }
  });
});

describe("without SCRAPPYCOCO_API_KEY", () => {
  const saved = process.env.SCRAPPYCOCO_API_KEY;
  beforeEach(() => {
    delete process.env.SCRAPPYCOCO_API_KEY;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.SCRAPPYCOCO_API_KEY = saved;
  });

  it("reports itself unconfigured and makes no network call", async () => {
    // Branding must stay fully functional without this key — it is an
    // enrichment, not a dependency. A fetch here would also be a real outbound
    // request from a unit test.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(isScrappycocoConfigured()).toBe(false);
    await expect(fetchSiteScreenshot("karoslabs.com")).resolves.toBeNull();
    await expect(fetchInstagramBrandAssets("karoslabs")).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("with a key but a failing service", () => {
  const saved = process.env.SCRAPPYCOCO_API_KEY;
  beforeEach(() => {
    process.env.SCRAPPYCOCO_API_KEY = "test-key";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SCRAPPYCOCO_API_KEY;
    else process.env.SCRAPPYCOCO_API_KEY = saved;
  });

  it("returns null instead of throwing, so a scraper outage cannot fail a run", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    await expect(fetchSiteScreenshot("karoslabs.com")).resolves.toBeNull();
    fetchSpy.mockRestore();
  });

  it("treats a non-2xx as no evidence rather than as data", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    await expect(fetchSiteScreenshot("karoslabs.com")).resolves.toBeNull();
    await expect(fetchInstagramBrandAssets("karoslabs")).resolves.toBeNull();
    fetchSpy.mockRestore();
  });

  it("sends the auth header and a fresh idempotency key per call", async () => {
    // The API requires `Idempotency-Key` on every billable POST, and reusing
    // one across different input is what makes an idempotent API hand back
    // somebody else's answer.
    const seen: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["X-API-Key"]).toBe("test-key");
      seen.push(headers["Idempotency-Key"]!);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    await fetchSiteScreenshot("karoslabs.com");
    await fetchSiteScreenshot("karoslabs.com");

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    fetchSpy.mockRestore();
  });

  it("requests the whole page, not just the first screen", async () => {
    // A viewport render answers "is this colour above the fold", which is a
    // different question: deel.com/the-pitch-by-deel paints its yellow and its
    // purple further down, and a first-screen render called both unused.
    let body: Record<string, unknown> = {};
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    await fetchSiteScreenshot("karoslabs.com");
    expect((body["input"] as Record<string, unknown>)["full_page"]).toBe(true);

    await fetchSiteScreenshot("karoslabs.com", false);
    expect((body["input"] as Record<string, unknown>)["full_page"]).toBe(false);
    fetchSpy.mockRestore();
  });

  it("never calls the API for a handle the client never set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(fetchInstagramBrandAssets(undefined)).resolves.toBeNull();
    await expect(fetchInstagramBrandAssets("  ")).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
