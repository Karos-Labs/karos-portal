/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_CATEGORY_MAX_LENGTH,
  clientCategoryLabel,
  clientCategoryValue,
} from "@/lib/utils";

/**
 * ONE FIELD FOR THE CLIENT'S CATEGORY (CD-L).
 *
 * `category` and `industry` were the same fact wearing two field names, and the
 * split was not cosmetic. The client typed a category into the chip in their own
 * sidebar; staff typed an industry into the Clients-page dialog; and the
 * copilot, the intel pipeline, the swarm, branding, the SEO/GEO question bank
 * and the X agent's brief all read only the staff one. A client who set their
 * own category watched their agents brief themselves on a value they could
 * neither see nor change.
 *
 * `category` is the field. `industry` is its legacy spelling: never written,
 * never deleted, and read in exactly ONE place — `clientCategoryValue`, as the
 * fallback for a document that predates the rename. A read-time fallback rather
 * than a migration, which is how this codebase carries a renamed field.
 *
 * THREE THINGS ARE ASKED HERE, and the middle one is the reason the file exists:
 *
 *  1. WHAT THE HELPER ANSWERS, behaviourally.
 *  2. THAT IT IS THE ONLY READER, asked of the SOURCE. The old arrangement was
 *     not one mistake, it was a dozen readers each reaching for whichever name
 *     was in front of them, so a rule that only fixes today's dozen is a rule
 *     that comes apart at the thirteenth. This scan makes the next raw reader
 *     fail CI instead of quietly re-opening the split.
 *  3. THAT EVERY WRITER CLAMPS, driven for real rather than read off source —
 *     the cap is what makes the chip's one-line contract a property of the
 *     stored value, and a second editor that skipped it would give the same
 *     field two ceilings again.
 */

/* ── 1. what the helper answers ───────────────────────────────────────────── */

describe("clientCategoryValue", () => {
  it("prefers the field the editors write", () => {
    // Both stored is the ordinary case for a client who has been edited since
    // the rename: the current field wins and the legacy one is simply ignored.
    expect(clientCategoryValue({ category: "Martech", industry: "SaaS" })).toBe("Martech");
  });

  it("falls back to the legacy spelling when nothing has been written yet", () => {
    expect(clientCategoryValue({ industry: "SaaS" })).toBe("SaaS");
    expect(clientCategoryValue({ category: undefined, industry: "SaaS" })).toBe("SaaS");
  });

  it("treats a BLANK category as absent, not as an answer", () => {
    // A cleared input stores `""`, and an empty string that shadowed a legacy
    // value would blank a client's chip and empty every pipeline brief with it.
    expect(clientCategoryValue({ category: "", industry: "SaaS" })).toBe("SaaS");
    expect(clientCategoryValue({ category: "   ", industry: "SaaS" })).toBe("SaaS");
    expect(clientCategoryValue({ category: "\n\t ", industry: "SaaS" })).toBe("SaaS");
  });

  it("answers null when neither name holds anything", () => {
    // NULL, not "" — every caller either tests it or supplies its own default
    // ("business", "marketing", "this category", "general"), and an empty string
    // is truthy enough often enough to slip one of those defaults.
    expect(clientCategoryValue({})).toBeNull();
    expect(clientCategoryValue({ category: "", industry: "" })).toBeNull();
    expect(clientCategoryValue({ category: "  ", industry: "  " })).toBeNull();
  });

  it("trims whatever it returns, from either name", () => {
    expect(clientCategoryValue({ category: "  Martech  " })).toBe("Martech");
    expect(clientCategoryValue({ industry: "  SaaS\n" })).toBe("SaaS");
  });

  it("hands back an over-long LEGACY value whole, which is not a bug", () => {
    // THE CONSEQUENCE OF THE CAP, stated where somebody will read it. Everything
    // written from here on is clamped to 28, but a legacy `industry` was typed
    // with no ceiling at all. It keeps coming back whole and keeps rendering —
    // `clientCategoryLabel` is what shortens it for the chip — until somebody
    // opens either editor, at which point it is stored clamped. That
    // convergence-on-edit is the intent: nothing rewrites a client's document on
    // our schedule, and no value is lost before a person has chosen a shorter
    // one. The pipeline prompts get the longer sentence until that happens.
    const legacy = "Independent technology news and media analysis"; // 45 chars
    expect(legacy.length).toBeGreaterThan(CLIENT_CATEGORY_MAX_LENGTH);
    expect(clientCategoryValue({ industry: legacy })).toBe(legacy);
    // The chip is where it is shortened, and only there.
    expect(clientCategoryLabel(clientCategoryValue({ industry: legacy })).length).toBe(
      CLIENT_CATEGORY_MAX_LENGTH,
    );
  });
});

/* ── 2. that it is the only reader ────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(f)) out.push(f);
  }
  return out;
}

/** Every module the app ships. Tests are excluded — they may name the field. */
const MODULES = walk(SRC).filter((f) => !f.includes("__tests__"));

/**
 * Somewhere the field's name may legally appear, recognised by WHAT THE
 * EXPRESSION IS rather than by which file it sits in — a path allowlist would
 * bless the next reader that happens to land in the same module.
 *
 *  • THE HELPER'S OWN BODY. `clientCategoryValue` is the fallback; it has to
 *    read the field it falls back to. Keyed on the enclosing function's name,
 *    so moving the helper to another module keeps it exempt and adding a second
 *    reader beside it does not.
 *
 * A `delete patch.industry` used to be the second legal shape: `updateClientAction`
 * took a whole `Partial<Client>` from a staff caller and had to strip the legacy
 * key by name. The action is an allowlist now (2026-09) — `industry` is simply
 * not a field it accepts — so the strip, and the excuse for it, are gone. The
 * helper's own body is the ONLY reader left.
 */
function legalUse(access: ts.Node, sf: ts.SourceFile): string | null {
  for (let q: ts.Node | undefined = access; q; q = q.parent) {
    if (
      (ts.isFunctionDeclaration(q) || ts.isMethodDeclaration(q)) &&
      q.name?.getText(sf) === "clientCategoryValue"
    ) {
      return "the fallback helper itself";
    }
  }
  return null;
}

interface Reader {
  rel: string;
  line: number;
  text: string;
}

const SCAN = (() => {
  const flagged: Reader[] = [];
  const excused: Array<Reader & { why: string }> = [];
  for (const abs of MODULES) {
    const sf = ts.createSourceFile(
      abs,
      readFileSync(abs, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (n: ts.Node) => {
      // `x.industry` and `x["industry"]` are the same read spelled two ways.
      const isRead =
        (ts.isPropertyAccessExpression(n) && n.name.getText(sf) === "industry") ||
        (ts.isElementAccessExpression(n) &&
          ts.isStringLiteralLike(n.argumentExpression) &&
          n.argumentExpression.text === "industry");
      if (isRead) {
        const found: Reader = {
          rel: abs.slice(SRC.length + 1),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          text: n.getText(sf).replace(/\s+/g, " ").slice(0, 80),
        };
        const why = legalUse(n, sf);
        if (why) excused.push({ ...found, why });
        else flagged.push(found);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return { flagged, excused };
})();

describe("the legacy field has exactly one reader", () => {
  it("scanned the tree it claims to, and found the one legal use", () => {
    // NON-VACUITY, both halves, because a scan that silently reads nothing
    // reports green forever. The walk must find the app's modules AND the one
    // shape it deliberately excuses must actually be present — if the helper
    // were renamed, this is what says so rather than the negative below
    // passing by finding nothing at all.
    expect(MODULES.length, "the source walk found almost nothing").toBeGreaterThan(300);
    const reasons = new Set(SCAN.excused.map((e) => e.why));
    expect(reasons).toEqual(new Set(["the fallback helper itself"]));
  });

  it("has no OTHER reader of `.industry` anywhere in src", () => {
    // THE RULE. A new reader of the raw field re-opens the split this closed:
    // it would read the legacy value while the client's own editor writes the
    // current one, and the two would drift apart again exactly the way they did
    // before. `clientCategoryValue` answers the question for everybody.
    const bad = SCAN.flagged.map((r) => `${r.rel}:${r.line} — ${r.text}`);
    expect(bad, "read the category through clientCategoryValue(client) instead").toEqual([]);
  });

  it("can still fail — planted into the very text it scans", () => {
    // The scan is only worth its green tick if it reports the shape when the
    // shape is there. Asked of the same helpers, over source built here, so this
    // is a statement about the walk and not about a file that might change.
    const planted = ts.createSourceFile(
      "planted.ts",
      "const brief = client.industry ?? '';\nconst other = c['industry'];\n",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const hits: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        (ts.isPropertyAccessExpression(n) && n.name.getText(planted) === "industry") ||
        (ts.isElementAccessExpression(n) &&
          ts.isStringLiteralLike(n.argumentExpression) &&
          n.argumentExpression.text === "industry")
      ) {
        if (!legalUse(n, planted)) hits.push(n.getText(planted));
      }
      n.forEachChild(visit);
    };
    visit(planted);
    expect(hits).toEqual(["client.industry", "c['industry']"]);
  });
});

/* ── 3. that every writer clamps ──────────────────────────────────────────── */

const STAFF = { uid: "u-admin", role: "KAROS_ADMIN", clientId: null, createdAt: 0 };

/** 32 characters — the real category this cap was measured against. */
const TOO_LONG = "Global Startup Pitch Competition";
/** Written out rather than computed, so the expectation is not the code again. */
const CLAMPED = "Global Startup Pitch Competi";

describe("every writer stores the category clamped, and none writes the old name", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load() {
    const created: Array<Record<string, unknown>> = [];
    const updateClient = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {});
    vi.doMock("server-only", () => ({}));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));
    vi.doMock("next/server", () => ({ after: () => {} }));
    vi.doMock("@/lib/branding", () => ({ applyBrandingForClient: async () => {} }));
    vi.doMock("@/lib/auth", () => ({ requireUser: async () => STAFF }));
    vi.doMock("@/lib/actions/_shared", () => ({
      requireStaff: async () => STAFF,
      logGenerationFailure: async () => {},
    }));
    vi.doMock("@/lib/data", () => ({
      createClient: async (doc: Record<string, unknown>) => {
        created.push(doc);
        return "c-new";
      },
      updateClient,
      deleteClientCascade: async () => {},
      getClientByKeyId: async () => null,
      getClientOwnerEmail: async () => "",
      tryAcquireAiProcessingLock: async () => false,
      releaseAiProcessingLock: async () => {},
    }));
    const mod = await import("@/lib/actions/client-actions");
    return { created, updateClient, mod };
  }

  it("clamps what the staff dialog sends, and stores it under `category`", async () => {
    const { updateClient, mod } = await load();
    await mod.updateClientAction("c1", { name: "Acme", category: TOO_LONG });
    const patch = updateClient.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.category).toBe(CLAMPED);
    expect((patch.category as string).length).toBe(CLIENT_CATEGORY_MAX_LENGTH);
    // Truncated, never ellipsised: storage keeps characters, not typography.
    expect(patch.category).not.toContain("…");
  });

  it("refuses the legacy key outright rather than mapping it", async () => {
    // NOT redirected onto `category`. This action takes a whole
    // `Partial<Client>` from a staff caller, so a stale caller still sending
    // `industry` must not silently overwrite a category it never named — and the
    // stored legacy value must survive, because it is what the fallback reads.
    const { updateClient, mod } = await load();
    await mod.updateClientAction("c1", { name: "Acme", industry: "Payments" } as any);
    const patch = updateClient.mock.calls[0][1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("industry");
    expect(patch).not.toHaveProperty("category");
    expect(patch.name, "the rest of the patch still lands").toBe("Acme");
  });

  it("creates a client into `category`, clamped, never into the legacy name", async () => {
    const { created, mod } = await load();
    await mod.createClientAction({ name: "Acme", category: TOO_LONG });
    expect(created[0].category).toBe(CLAMPED);
    expect(created[0]).not.toHaveProperty("industry");
  });
});
