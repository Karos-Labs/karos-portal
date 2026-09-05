import { vi, describe, expect, it } from "vitest";

// Must be hoisted before any import that transitively pulls in server-only.
vi.mock("server-only", () => ({}));

const { observeSitePalette, describeObservedPalette, snapToObservedPalette, isUncorroboratedSlotColor } = await import("../branding-site-palette");

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
<link rel="icon" href="/icon.svg">
<link rel="preload" href="/img/hero.png">
</head><body style="background:#0A0C0F">hi</body></html>`;

/**
 * The site's shape as of 2026-09-05: a real `:root` theme plus FOUR demo
 * palettes for a theme switcher on the landing page. Pooled together the demo
 * scopes outnumber `:root`, which is how `#0b0b0d` — a scene ground — was
 * extracted as the brand's background over the real `#1a1a1a`.
 */
const CSS = `
:root{--background:#1a1a1a;--foreground:#f2f1ec;--primary:#2f6bff;--ring:#2f6bff;--accent:#ff6b2c;--surface-1:#242429}
.theme-cobalt{--background:#0b0b0d;--accent:#22d3ee;--scene-bg:#0b0b0d}
html.light .theme-cobalt{--background:#0b0b0d}
.btn{background:#ff6b2c;color:#fff}
.card{background:#141619}
.a{color:#ff6b2c}.b{color:#ff6b2c}
`;

/** karoslabs.com's real mark: the ground and the paper, and no blue anywhere. */
const ICON_SVG = `<svg viewBox="0 0 32 32"><rect fill="#1a1a1a" width="32" height="32"/><path fill="#f2f1ec" d="M4 4h8v8H4z"/></svg>`;

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
  "https://karoslabs.com/icon.svg": ICON_SVG,
};

describe("observeSitePalette", () => {
  it("reads the CSS custom properties the site declares, with their names", async () => {
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    const byHex = new Map(observed.map((c) => [c.hex, c]));

    expect(byHex.get("#ff6b2c")?.cssVars).toEqual(["--accent"]);
    expect(byHex.get("#2f6bff")?.cssVars).toEqual(["--primary", "--ring"]);
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

  it("ranks a brand-meaning name above a merely frequent colour", async () => {
    // `#ff6b2c` is both, but a colour whose custom property carries brand
    // meaning must outrank an unnamed one however often the unnamed one
    // appears: frequency measures surface area, a name measures whether
    // anyone decided it mattered.
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    const rank = (hex: string) => observed.findIndex((c) => c.hex === hex);
    expect(rank("#ff6b2c")).toBeLessThan(rank("#0a0c0f"));
    expect(rank("#242429")).toBeLessThan(rank("#0a0c0f"));
  });

  it("ranks an uncorroborated component-slot colour below everything real", async () => {
    // `#2f6bff` is named only by `--primary`/`--ring`, is absent from the mark
    // and from the markup, and a rendered sweep of the live site finds it
    // painted on zero elements. It is the sole source of the "Karos Labs is
    // blue" claim, so it must not sit among the brand's colours.
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    const blue = observed.find((c) => c.hex === "#2f6bff")!;
    expect(isUncorroboratedSlotColor(blue)).toBe(true);
    const rank = (hex: string) => observed.findIndex((c) => c.hex === hex);
    expect(rank("#2f6bff")).toBeGreaterThan(rank("#ff6b2c"));
    expect(rank("#2f6bff")).toBeGreaterThan(rank("#0a0c0f"));
  });

  it("keeps a slot-named colour the mark or the markup corroborates", async () => {
    // The rule must not fire on the many brands that genuinely put their colour
    // in `--primary`. Corroboration from any other source is enough to keep it.
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    const ground = observed.find((c) => c.hex === "#1a1a1a")!;
    expect(ground.cssVars).toEqual(["--background"]);
    expect(isUncorroboratedSlotColor(ground)).toBe(false);
  });

  it("reads the site's own icon mark and ranks it first", async () => {
    // The mark is the most deliberate colour decision a brand makes, and it is
    // the one source that says outright that karoslabs.com is not blue.
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    expect(observed.filter((c) => c.inLogo).map((c) => c.hex).sort()).toEqual(["#1a1a1a", "#f2f1ec"]);
    expect(observed.slice(0, 2).every((c) => c.inLogo)).toBe(true);
  });

  it("attributes a custom property to the scope that declared it", async () => {
    // The defect: `--background` is `#1a1a1a` in `:root` and `#0b0b0d` in a
    // demo theme. Pooled, the scene ground won and became the brand's.
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    const byHex = new Map(observed.map((c) => [c.hex, c]));

    expect(byHex.get("#1a1a1a")?.cssVars).toContain("--background");
    expect(byHex.get("#0b0b0d")?.cssVars).toEqual([]);
    expect(byHex.get("#0b0b0d")?.themeVars).toEqual(["--background", "--scene-bg"]);
    // `--accent` is orange in `:root` and cyan only in the demo scope.
    expect(byHex.get("#ff6b2c")?.cssVars).toEqual(["--accent"]);
    expect(byHex.get("#22d3ee")?.cssVars).toEqual([]);
  });

  it("ranks the served theme above alternate theme scopes", async () => {
    const observed = await observeSitePalette("karoslabs.com", fakeFetch(PAGES));
    const rank = (hex: string) => observed.findIndex((c) => c.hex === hex);
    expect(rank("#1a1a1a")).toBeLessThan(rank("#0b0b0d"));
    expect(rank("#ff6b2c")).toBeLessThan(rank("#22d3ee"));
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
    expect(block).toMatch(/MUST be one of the values listed here/);
  });

  it("separates the mark and the alternate themes from the served palette", async () => {
    const block = describeObservedPalette(await observeSitePalette("karoslabs.com", fakeFetch(PAGES)));
    expect(block).toMatch(/icon\/logo mark/);
    expect(block).toMatch(/alternate\/demo theme scopes/);
    // The demo ground must be presented as a different theme's colour, never
    // alongside `:root`'s as if the site had two backgrounds.
    const themeSection = block.slice(block.indexOf("alternate/demo theme scopes"));
    expect(themeSection).toContain("#0b0b0d");
    expect(block.slice(0, block.indexOf("alternate/demo theme scopes"))).not.toContain("#0b0b0d");
  });

  it("is empty when nothing was observed, so the prompt gains no empty section", () => {
    expect(describeObservedPalette([])).toBe("");
  });
});

describe("snapToObservedPalette", () => {
  const observed = [
    { hex: "#ff6b2c", count: 4, cssVars: ["--accent"], themeVars: [], inLogo: false, inMarkup: false },
    { hex: "#2f6bff", count: 2, cssVars: ["--primary"], themeVars: [], inLogo: false, inMarkup: false },
    { hex: "#1a1a1a", count: 2, cssVars: ["--background"], themeVars: [], inLogo: true, inMarkup: true },
    { hex: "#f2f1ec", count: 2, cssVars: ["--foreground"], themeVars: [], inLogo: true, inMarkup: false },
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
