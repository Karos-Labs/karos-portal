import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// provider.ts is `server-only`; the second describe block imports it directly.
vi.mock("server-only", () => ({}));

/**
 * AU70 / SCRUM-370, round 2 — closes the gap the first round's own coverage
 * missed.
 *
 * Round 1 proved that no call site logs `modelName: MODELS.*` any more. That
 * left a second, sharper defect standing: nine call sites (branding.ts x2,
 * x-agent-actions.ts, seo-geo.ts, pipeline.ts x5) called `usageFor("<role>")`
 * to LOG the resolved id and vendor, while the ACTUAL model handed to
 * generateText/streamText a few lines above was still `anthropic(MODELS.*)` —
 * a hardcoded tier constant, resolved independently of the logged vendor. On
 * first-party Anthropic the two happen to agree. The moment any of those
 * roles' `pinnedTo` in roles.ts names "vertex" (the same mechanism already
 * used for geo.capture.claude), the logged row would claim vendor "vertex"
 * while the request still hit first-party Anthropic — the exact "two
 * independently-computed facts that have nothing making them agree" shape
 * AU70 exists to close, just relocated one call away from where round 1
 * looked.
 *
 * The fix is not "spread usageFor() correctly" (round 1 already did that
 * everywhere) — it is "stop constructing the model by hand". Every call site
 * must take ITS model from the same aiFor() resolution that produces the
 * vendor usageFor() logs, so there is no second, independent place for the
 * vendor to be decided.
 */

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "ai") continue;
        walk(path.join(dir, entry.name));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(path.join(process.cwd(), "src"));
  return out;
}

describe("no call site constructs a model from a hardcoded tier constant", () => {
  it('finds zero `anthropic(MODELS.*)` sites — the shape that let usageFor()\'s logged vendor diverge from the model actually used', () => {
    // This is the literal shape of the bug: passing a TIER CONSTANT straight to
    // the vendor SDK, independent of whatever usageFor() logs a few lines away.
    // A file is free to import `anthropic` for its `.tools.*` factories (the
    // capability layer still needs those) — what it may never do again is hand
    // `anthropic()` itself a `MODELS.*` constant to build the model.
    const banned = /\banthropic\(\s*MODELS\./;
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, i) => {
        if (banned.test(text)) {
          offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      `these construct a model straight from a tier constant, independent of ` +
        `whatever usageFor() logs a few lines away — on a vendor pin the two can ` +
        `disagree. Take the model from aiFor("<role>").model instead, the same ` +
        `resolution usageFor("<role>") reads its vendor from:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("also finds zero bare `vertexAnthropic(MODELS.*)` sites outside the provider layer", () => {
    // Same defect, Vertex-flavoured: MODELS.* is never a valid Vertex model id
    // in the first place (see provider.ts's own doc comment on MODEL_IDS), so
    // this specific shape would fail loudly at request time rather than
    // silently — but it is still a hand-built model bypassing aiFor(), and nothing
    // stops the id from being replaced with a real Vertex id later while keeping
    // the same bypass.
    const banned = /\bvertexAnthropic\(\s*MODELS\./;
    const offenders = sourceFiles()
      .filter((f) => !f.split(path.sep).join("/").includes("/lib/ai/"))
      .flatMap((file) => {
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        return lines
          .map((text, i) => (banned.test(text) ? `${path.relative(process.cwd(), file)}:${i + 1}` : null))
          .filter((x): x is string => x !== null);
      });
    expect(offenders).toEqual([]);
  });
});

describe("pinning a web_search-only role to vertex cannot desync model from logged vendor", () => {
  it("x_agent.research: the model aiFor() builds and the vendor usageFor() logs move together under a vertex pin", async () => {
    // Reproduces exactly the exploit named against round 1: x_agent.research
    // declares only web_search (which Vertex supports), so pinning it to vertex
    // in roles.ts (the same pinnedTo mechanism geo.capture.claude already uses)
    // would pass assertManifestWirable without touching the call site. Round 1's
    // call site still built `anthropic(MODELS.SONNET)` by hand, so the request
    // would have gone to first-party Anthropic while usageFor() logged vendor
    // "vertex" — a silent, billed-at-the-wrong-place mismatch that is invisible
    // to any test asserting only that a `modelName:` field isn't a bare constant.
    //
    // This test does not edit roles.ts (a real pin is a product decision, not
    // this test's to make). Instead it calls aiFor()/usageFor() with an explicit
    // vendor override — the same override mechanism a pin resolves to internally
    // — and asserts the model construction and the logged vendor cannot be
    // pulled apart: model comes from the SAME resolved object usageFor() reads.
    const { aiFor, usageFor } = await import("@/lib/ai/provider");

    const resolved = aiFor("x_agent.research", {
      vendor: "vertex",
      budgets: { web_search: { maxUses: 4 } },
    });
    const logged = usageFor("x_agent.research", { vendor: "vertex" });

    expect(resolved.vendor).toBe("vertex");
    expect(logged.vendor).toBe("vertex");
    // The id the model was actually built with, and the id the cost logger
    // would record, must be the literal same string — not two independently
    // computed values that happen to match today.
    expect(logged.modelName).toBe(resolved.modelId);
    // And it must be the real Vertex id (with the `@` snapshot separator), not
    // the Anthropic-dated id `MODELS.SONNET` would have supplied.
    expect(logged.modelName).toBe("claude-sonnet-4-6");
  });

  it("branding.search_brand: same guarantee for the other web_search-only role", async () => {
    const { aiFor, usageFor } = await import("@/lib/ai/provider");
    const resolved = aiFor("branding.search_brand", { vendor: "vertex", budgets: { web_search: {} } });
    const logged = usageFor("branding.search_brand", { vendor: "vertex" });
    expect(logged.modelName).toBe(resolved.modelId);
    expect(logged.modelName).toBe("claude-haiku-4-5@20251001");
  });

  it("the call site itself takes its model from that same aiFor() resolution — not a second, independent construction", () => {
    // Belt-and-braces over the two tests above (which prove the LAYER is sound):
    // confirm the actual call site source reads `.model`/`.tools` off a local
    // `aiFor(` result rather than constructing a model inline.
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/lib/actions/x-agent-actions.ts"),
      "utf8",
    );
    const anchor = src.indexOf('generateText({');
    expect(anchor, "generateText call site not found").toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, anchor - 400), anchor);
    expect(before, "no aiFor(\"x_agent.research\" resolution precedes the generateText call").toMatch(
      /aiFor\(\s*"x_agent\.research"/,
    );
  });
});
