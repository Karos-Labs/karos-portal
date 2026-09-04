import { vi, describe, expect, it } from "vitest";

// Must be hoisted before any import that transitively pulls in server-only.
vi.mock("server-only", () => ({}));

const { observeSitePalette, describeObservedPalette, snapToObservedPalette } = await import("../branding-site-palette");

/**
 * The defect this exists for, from prep on 2026-09-03.
 *
 * `applyBrandingForClient` stored `primaryAccent: #6366f1` for karoslabs.com —
 * Tailwind `indigo-500`, a value that appears nowhere in that site's HTML or
 * CSS — plus `#dc602c` for an orange the site declares as `#ff6b2c`, and
 * `#ffffff` for a paper the site declares as `#f2f1ec`. Three of four scalars
 * invented. The client's own brand guidelines told them their brand was blue.
 *
 * The fixture below is that site's real shape: a shadcn-style theme where
 * `--primary` is an untouched framework blue and `--accent` carries the actual
 * brand orange.
 */
const HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="/_next/static/theme.css">
<link rel="preload" href="/img/hero.png">
</head><body style="background:#0A0C0F">hi</body></html>`;

const CSS = `
:root{--background:#1a1a1a;--foreground:#f2f1ec;--primary:#2f6bff;--accent:#ff6b2c;--surface-1:#242429}
.btn{background:#ff6b2c;color:#fff}
.card{background:#141619}
.a{color:#ff6b2c}.b{color:#ff6b2c}
`;

function fakeFetch(pages: Record<string, string>): typeof fetch {
  return (async (url: unknown) => {
    const key = String(url);
    const body = pages[key];
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

const PAGES = {
  "https://karoslabs.com/": HTML,
  "https://karoslabs.com/_next/static/theme.css": CSS,
};

describe("observeSitePalette", () => {
  it("reads the CSS custom properties the site declares, with their names", async () => {
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    const byHex = new Map(observed.map((c) => [c.hex, c]));

    expect(byHex.get("#ff6b2c")?.cssVars).toEqual(["--accent"]);
    expect(byHex.get("#2f6bff")?.cssVars).toEqual(["--primary"]);
    expect(byHex.get("#1a1a1a")?.cssVars).toEqual(["--background"]);
    expect(byHex.get("#242429")?.cssVars).toEqual(["--surface-1"]);
  });

  it("follows stylesheet links relative to the page", async () => {
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    // Nothing in the HTML declares these — they only exist in the stylesheet.
    expect(observed.map((c) => c.hex)).toContain("#141619");
  });

  it("normalizes shorthand hex and inline styles from the page itself", async () => {
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    expect(observed.map((c) => c.hex)).toContain("#0a0c0f");
  });

  it("ranks named colours above merely frequent ones", async () => {
    // `#ff6b2c` is both, but a colour with a custom property must outrank an
    // unnamed one however often the unnamed one appears: frequency measures
    // surface area, a name measures whether anyone decided it mattered.
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    const firstUnnamed = observed.findIndex((c) => c.cssVars.length === 0);
    const lastNamed = observed.map((c) => c.cssVars.length > 0).lastIndexOf(true);
    expect(lastNamed).toBeLessThan(firstUnnamed);
  });

  it("drops plain black and white from the ranking unless the site names them", async () => {
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    // `#fff` appears in `.btn` but is never declared as a custom property.
    expect(observed.map((c) => c.hex)).not.toContain("#ffffff");
  });

  it("returns nothing for an unreachable site instead of throwing", async () => {
    // Branding is a non-fatal side pipeline; a site that blocks us must not
    // fail a run, and must not trigger a confident "repair" against nothing.
    await expect(observeSitePalette("nope.example", fakeFetch({}))).resolves.toEqual([]);
    const boom = (async () => {
      throw new Error("DNS");
    }) as unknown as typeof fetch;
    await expect(observeSitePalette("nope.example", boom)).resolves.toEqual([]);
  });
});

describe("describeObservedPalette", () => {
  it("names the custom properties so the model can reason about role", async () => {
    const block = describeObservedPalette(await observeSitePalette("karoslabs.com", fakeFetch(PAGES)));
    expect(block).toContain("--accent: #ff6b2c");
    expect(block).toContain("--background: #1a1a1a");
    expect(block).toMatch(/MUST be one of the values listed here/);
  });

  it("is empty when nothing was observed, so the prompt gains no empty section", () => {
    expect(describeObservedPalette([])).toBe("");
  });
});

describe("snapToObservedPalette", () => {
  const observed = [
    { hex: "#ff6b2c", count: 4, cssVars: ["--accent"] },
    { hex: "#2f6bff", count: 2, cssVars: ["--primary"] },
    { hex: "#1a1a1a", count: 2, cssVars: ["--background"] },
    { hex: "#f2f1ec", count: 2, cssVars: ["--foreground"] },
  ];

  it("replaces a hallucinated hex with the nearest colour the site really has", () => {
    // The exact prep failure: #6366f1 is on neither the page nor the
    // stylesheet, and #dc602c is a near-miss for the real #ff6b2c.
    const snapped = snapToObservedPalette(
      [
        { hex: "#6366f1", dominanceRank: 1, role: "Primary CTA and interactive accent" },
        { hex: "#dc602c", dominanceRank: 2, role: "Secondary accent" },
      ],
      observed,
    );

    expect(snapped[0]!.hex).toBe("#2f6bff");
    expect(snapped[1]!.hex).toBe("#ff6b2c");
  });

  it("keeps the role and rank the model assigned — it only fixes the value", () => {
    // `resolveDominantColorsByRole` reads this text to decide accent vs
    // neutral. Rewriting it here would overrule a judgment this function is
    // not qualified to make.
    const snapped = snapToObservedPalette([{ hex: "#6366f1", dominanceRank: 1, role: "Page ground" }], observed);
    expect(snapped[0]).toMatchObject({ dominanceRank: 1, role: "Page ground" });
  });

  it("leaves an already-correct colour exactly alone", () => {
    const snapped = snapToObservedPalette([{ hex: "#ff6b2c", dominanceRank: 1, role: "Accent" }], observed);
    expect(snapped[0]!.hex).toBe("#ff6b2c");
  });

  it("normalizes shorthand before deciding whether it is present", () => {
    const snapped = snapToObservedPalette([{ hex: "#FF6B2C", dominanceRank: 1 }], observed);
    expect(snapped[0]!.hex).toBe("#ff6b2c");
  });

  it("changes nothing when there are no observations", () => {
    // An unreachable site must not cause a rewrite of a palette that may have
    // come from a logo file, which this function cannot see.
    const input = [{ hex: "#6366f1", dominanceRank: 1, role: "Accent" }];
    expect(snapToObservedPalette(input, [])).toEqual(input);
  });
});
