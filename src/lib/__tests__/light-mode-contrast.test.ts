import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE LIGHT MODE'S TEXT COLOURS, MEASURED AGAINST THE GROUNDS THEY SIT ON.
 *
 * This exists because the previous fix was correct arithmetic against the
 * wrong surface. `--muted-2` carried the comment "4.7:1 on white", which was
 * true — and `--background` in light mode is `#f2f1ec`, not white, with most
 * muted text on that or on `--surface-2` (`#eceae2`). The same colour measures
 * **4.15** and **3.90** there: under 4.5 on both of the grounds it is actually
 * used on, while reading as fixed.
 *
 * So the ratios are recomputed here from `globals.css` itself, against **every
 * light ground**, rather than being asserted once in a comment. A token edited
 * to a value that passes on white and fails on paper fails this test.
 *
 * ## The orange is exempt as a fill, and only as a fill
 *
 * `--neon` is 2.51:1 on paper. That is fine for a button, a bar or a rule — a
 * fill does not have to be read. It is not fine for text, and it was set as
 * text in 179 places including links. `--neon-ink` is what `text-neon`
 * resolves to in light mode, and it is held to the text floor here. The same
 * reasoning `--focus` already carries: ink, not orange, because an orange ring
 * fails WCAG 1.4.11.
 */

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** Reads a custom property out of the `.light` block, which is where light-mode values live. */
function lightToken(name: string): string {
  const block = CSS.slice(CSS.indexOf(".light {"));
  const match = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!match) throw new Error(`${name} not found in the .light block — has it been renamed?`);
  return match[1]!.toLowerCase();
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Every ground a light-mode surface can be, read from the stylesheet.
 *
 * Four and not one, because "which background is this text on" is not a
 * question a token can answer — the same `--muted-2` appears on the page
 * ground, on a card and on both raised tones.
 */
const GROUNDS = ["--background", "--surface", "--surface-2", "--surface-3"] as const;

function worstGround(token: string): { ratio: number; ground: string } {
  const colour = lightToken(token);
  let worst = { ratio: Infinity, ground: "" };
  for (const ground of GROUNDS) {
    const ratio = contrast(colour, lightToken(ground));
    if (ratio < worst.ratio) worst = { ratio, ground };
  }
  return worst;
}

describe("light mode clears WCAG on the grounds it actually uses", () => {
  it("reads the four grounds out of the stylesheet, so an empty parse cannot pass", () => {
    // Anti-vacuity: `lightToken` throws on a miss, and this proves the four it
    // is about to measure against are real values rather than a lucky regex.
    for (const ground of GROUNDS) expect(lightToken(ground)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(["--foreground", "--muted", "--muted-2"])(
    "%s clears 4.5:1 for body text on every light ground",
    (token) => {
      const { ratio, ground } = worstGround(token);
      expect(ratio, `${token} is ${ratio.toFixed(2)}:1 on ${ground}`).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("--muted-3 clears the 3:1 floor it is the decorative tier for", () => {
    // Held to a lower bar on purpose — it is the least prominent tone — but to
    // a bar. It measured 2.87 on --surface-2, under even this.
    const { ratio, ground } = worstGround("--muted-3");
    expect(ratio, `--muted-3 is ${ratio.toFixed(2)}:1 on ${ground}`).toBeGreaterThanOrEqual(3);
  });

  it("--neon-ink is readable, which is the whole reason it exists", () => {
    const { ratio, ground } = worstGround("--neon-ink");
    expect(ratio, `--neon-ink is ${ratio.toFixed(2)}:1 on ${ground}`).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the muted ladder running dark to light", () => {
    // Not decoration: the first attempt at this fix darkened `--muted-2` alone
    // and inverted the ladder, so the SECONDARY tone was darker than the body
    // tone. Every ratio still passed. Contrast alone cannot see that, which is
    // why the ordering is its own assertion.
    const luminance = (token: string) => relativeLuminance(lightToken(token));
    expect(luminance("--foreground")).toBeLessThan(luminance("--muted"));
    expect(luminance("--muted")).toBeLessThan(luminance("--muted-2"));
    expect(luminance("--muted-2")).toBeLessThan(luminance("--muted-3"));
  });

  it("does not hold the fill orange to a text ratio, and states why", () => {
    // The premise of the exemption, asserted rather than assumed: --neon really
    // is unreadable as text on paper. If it ever became readable this test
    // would fail and the exemption below could go.
    expect(worstGround("--neon").ratio).toBeLessThan(4.5);
    // …and the exemption is only safe because text never resolves to it.
    expect(CSS).toMatch(/\.light \.text-neon[\s\S]{0,120}color:\s*var\(--neon-ink\)/);
  });

  it("keeps the orange as a fill — the rule changes text only", () => {
    // A `.light { --neon: … }` override would have fixed the contrast and
    // repainted every button, bar and rule in the product. The brand note in
    // this stylesheet's own header says not to re-theme without a guidelines
    // change, and this is how both hold at once.
    expect(lightToken("--neon")).toBe("#ff6b2c");
  });
});
