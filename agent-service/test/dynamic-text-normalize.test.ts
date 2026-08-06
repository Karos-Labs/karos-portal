import { describe, expect, it } from "vitest";
import { normalizeDashes, normalizeDashesDeep } from "../runner/src/dynamic/text-normalize.js";

/**
 * PARITY SUITE. The first describe below is a verbatim copy of the Portal's
 * own `src/lib/__tests__/text-utils.test.ts` > "normalizeDashes" block. It
 * exists so the mirrored copy in the runner cannot drift from the Portal's
 * implementation without a red test here — the guard the mirroring decision in
 * text-normalize.ts's header depends on. If a case is added Portal-side, add
 * it here too.
 */
describe("normalizeDashes — parity with the Portal's text-utils", () => {
  it("replaces an em dash with a plain hyphen", () => {
    expect(normalizeDashes("great work—really")).toBe("great work-really");
  });

  it("replaces a spaced double hyphen with a spaced single hyphen", () => {
    expect(normalizeDashes("great work -- really good")).toBe("great work - really good");
  });

  it("leaves a CLI flag (no trailing space) alone", () => {
    expect(normalizeDashes("run with --verbose enabled")).toBe("run with --verbose enabled");
  });

  it("leaves a markdown horizontal rule (three dashes) alone", () => {
    expect(normalizeDashes("above\n\n---\n\nbelow")).toBe("above\n\n---\n\nbelow");
  });

  it("does not touch a real shell separator inside a fenced code block", () => {
    const input = "Run this:\n```bash\nnpm run test -- --watch\n```\nThen check output.";
    expect(normalizeDashes(input)).toBe(input);
  });

  it("does not touch double hyphens inside an inline code span", () => {
    expect(normalizeDashes("use `foo -- bar` on the command line")).toBe(
      "use `foo -- bar` on the command line",
    );
  });

  it("handles multiple occurrences across a longer passage", () => {
    expect(normalizeDashes("First point — clear. Second point -- also clear.")).toBe(
      "First point - clear. Second point - also clear.",
    );
  });

  it("is idempotent", () => {
    const once = normalizeDashes("word -- word—word");
    expect(normalizeDashes(once)).toBe(once);
  });

  it("passes through empty/falsy input unchanged", () => {
    expect(normalizeDashes("")).toBe("");
  });
});

describe("normalizeDashesDeep", () => {
  it("normalizes a bare string output", () => {
    expect(normalizeDashesDeep("a — b")).toBe("a - b");
  });

  it("normalizes strings nested in objects and arrays", () => {
    expect(normalizeDashesDeep({ headline: "big — news", bullets: ["one -- two"] })).toEqual({
      headline: "big - news",
      bullets: ["one - two"],
    });
  });

  it("never rewrites an object KEY — keys are context variable names, not prose", () => {
    const out = normalizeDashesDeep({ "step—one": "value — here" }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["step—one"]);
    expect(out["step—one"]).toBe("value - here");
  });

  it("still protects code fences when they are nested inside a structure", () => {
    const input = { snippet: "```sh\nnpm t -- --watch\n```" };
    expect(normalizeDashesDeep(input)).toEqual(input);
  });

  it("leaves non-string primitives untouched", () => {
    expect(normalizeDashesDeep({ n: 5, b: true, z: null })).toEqual({ n: 5, b: true, z: null });
  });
});
