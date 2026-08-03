import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  isStringDelimiter,
  matchingBrace,
  skipStringLiteral,
  stripComments,
} from "./source-scan";
import type { CustomAgent } from "@/lib/types";

/**
 * WHERE A CONTROL THAT OFFERS A CLIENT A RUN IS ALLOWED TO GO (#92, #114).
 *
 * `/clients/<id>/agents` is a ROSTER. Its client branch says so in its own
 * comment — "No Run button anywhere: a client's run gesture lives only inside a
 * detail page" — and CD-I1 moved every STAFF run gesture off it too. The QA
 * sweep has recorded a control promising a run over that page more than once;
 * the latest was the empty state of the Workspace activity tab, which is the
 * first thing a brand-new client ever sees on it (#92).
 *
 * The fix for it was not another edit. `intakePageAction` already
 * resolves a destination AND the words allowed over it, dropping the verb when
 * nothing it can reach honours one, so the timeline asks that. What this file
 * adds is the part a fifth control would walk past:
 *
 *  1. THE TIMELINE'S CONTROL IS THE RESOLVER'S, asserted on the ELEMENT — its
 *     href and its label come from the same call and nothing else is rendered
 *     inside it. (That the resolver's LABELS never promise a run is asserted
 *     once, in agent-intake-navigation.test.ts, and is deliberately not
 *     re-asserted here.)
 *  2. A FILESYSTEM SWEEP of every .tsx under src/: any anchor or Link pointing
 *     at a client's agent roster must render no run verb. Derived from the tree
 *     rather than from a list of the controls known today, so the next one is
 *     scanned the day it is written.
 *  3. THE INTAKE PAGES' GRANT RUNG (#114) — the refusal, and the fact that the
 *     header control's destination can only be obtained through it.
 *
 * WHAT (2) CANNOT SEE, stated rather than implied. It reads LITERAL element
 * text. A control whose label arrives in a variable is invisible to it — which
 * is exactly the shape the resolver produces, and is why (1) exists to pin that
 * variable to the resolver. A fifth control that hard-codes a roster href and
 * computes its label from some third source passes both, and only a reader
 * catches it.
 *
 * SCOPE of (2) is the CLIENT-scoped roster, `/clients/<…>/agents`. The staff hub
 * at `/agents` is a different route and is not swept here.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const D = vi.hoisted(() => ({ listCustomAgents: vi.fn() }));
vi.mock("@/lib/data", () => D);

const { requireIntakeAgentAccess } = await import("@/lib/agent-intake-views");

const REPO = path.resolve(__dirname, "../..", "..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const TIMELINE = "src/components/activity-timeline.tsx";

/* ─────────────────────── JSX element scanning ───────────────────────────── */
/*
 * A LOCAL copy of the element walk agent-intake-navigation.test.ts uses, kept
 * local because that file is not this change's to edit and a shared home for it
 * would leave two copies anyway. The primitives underneath (string skipping,
 * brace matching, comment stripping) ARE shared — those are the ones whose
 * private copies went wrong before.
 */

/**
 * The index of the `>` that ends the opening tag starting at `at`, or -1.
 * Braces and string literals are skipped whole, so a `>` inside `{a > b}` or
 * inside a className cannot end the tag early.
 */
function openingTagEnd(code: string, at: number): number {
  for (let i = at; i < code.length; i++) {
    const ch = code[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(code, i);
      continue;
    }
    if (ch === "{") {
      const brace = matchingBrace(code, i);
      if (brace < 0) return -1;
      i = brace;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

/** Every `href=` value on one opening tag, delimiter-matched. */
function hrefValues(tag: string): string[] {
  const out: string[] = [];
  for (const m of tag.matchAll(/\bhref\s*=\s*/g)) {
    const at = m.index + m[0].length;
    if (tag[at] === "{") {
      const close = matchingBrace(tag, at);
      out.push(close > at ? tag.slice(at, close + 1) : tag.slice(at));
      continue;
    }
    if (isStringDelimiter(tag[at])) {
      const close = skipStringLiteral(tag, at);
      out.push(close > at ? tag.slice(at, close + 1) : tag.slice(at));
      continue;
    }
    out.push(tag.slice(at));
  }
  return out;
}

interface Element {
  name: string;
  tag: string;
  body: string;
}

/** Every `<a>` and `<Link>` element in `code`, with its opening tag and children. */
function linkElements(code: string): Element[] {
  const out: Element[] = [];
  for (const m of code.matchAll(/<(a|Link)(?=[\s/>])/g)) {
    const name = m[1]!;
    const gt = openingTagEnd(code, m.index);
    if (gt < 0) continue;
    // Self-closing (`<Link … />`) has no children to read; the href still counts,
    // with an empty body, so it cannot hide a label by having none.
    const selfClosing = code[gt - 1] === "/";
    const end = selfClosing ? gt : code.indexOf(`</${name}>`, gt);
    out.push({
      name,
      tag: code.slice(m.index, gt + 1),
      body: end < 0 || selfClosing ? "" : code.slice(gt + 1, end),
    });
  }
  return out;
}

/**
 * An element body with its nested JSX tags removed, so what remains is what a
 * reader sees: literal text plus any `{expression}` verbatim.
 *
 * Tags are removed through the same delimiter-aware walk, not `/<[^>]*>/`, so a
 * `>` inside an attribute cannot cut a tag short and leave attribute soup in the
 * "rendered text" a verb is then looked for in.
 */
function renderedText(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "<") {
      const gt = openingTagEnd(body, i);
      if (gt < 0) {
        out += body[i];
        continue;
      }
      i = gt;
      out += " ";
      continue;
    }
    out += body[i]!;
  }
  return out;
}

/** Does this href value land on a client's agent roster, `/clients/<…>/agents`? */
function isClientRosterHref(value: string): boolean {
  return /\/clients\/[^`"'\s]*\/agents(?=[`"'?#])/.test(value);
}

/** The word the roster cannot honour — the same notion the resolver is held to. */
const RUN_VERB = /\brun\b/i;

/** Every .tsx file under src/, excluding the test directory itself. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".tsx")) acc.push(path.relative(REPO, full));
  }
  return acc;
}

interface RosterControl {
  file: string;
  tag: string;
  text: string;
}

function rosterControlsIn(rel: string): RosterControl[] {
  const code = stripComments(read(rel));
  return linkElements(code)
    .filter((el) => hrefValues(el.tag).some(isClientRosterHref))
    .map((el) => ({ file: rel, tag: el.tag, text: renderedText(el.body) }));
}

/* ───────────── #92: the timeline's control is the resolver's ────────────── */

describe("#92 — the activity tab's empty state", () => {
  it("renders the resolved label inside the anchor carrying the resolved href", () => {
    // BOTH HALVES ON ONE ELEMENT. Asking the file for `intakePageAction(` alone
    // would pass with the resolver called and its answer thrown away, and asking
    // only for `{runControl.label}` would pass with `/clients/${clientId}/agents`
    // hard-coded back onto the anchor under it — which is #92 with a resolver
    // bolted on the front, and is the exact state its three siblings were caught
    // in on the intake pages.
    const code = stripComments(read(TIMELINE));
    const controls = linkElements(code).filter((el) => el.body.includes("{runControl.label}"));
    expect(controls.length, `${TIMELINE}: nothing renders {runControl.label}`).toBe(1);
    const control = controls[0]!;
    expect(hrefValues(control.tag), TIMELINE).toEqual(["{runControl.href}"]);
    // Nothing else inside it: an arrow glyph or a second word beside the label
    // is a promise the resolver did not make and cannot withdraw.
    expect(control.body.trim(), TIMELINE).toBe("{runControl.label}");
  });

  it("has no hand-built roster link left anywhere in the file", () => {
    // The href above is the resolver's, but the file could still carry a second
    // control the first assertion never looks at.
    const hardCoded = rosterControlsIn(TIMELINE);
    expect(hardCoded.map((c) => c.tag), TIMELINE).toEqual([]);
  });
});

/* ─────────── the sweep: derived from the tree, not from a list ──────────── */

describe("no control offers a client a run on the roster", () => {
  const files = sourceFiles(path.join(REPO, "src"));

  it("reads a source tree, and reaches the file this cluster fixed", () => {
    // Non-vacuity for the WALK. A sweep that silently found no files would
    // assert nothing at all, which is the failure mode a green run hides.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(TIMELINE);
  });

  it("recognises the shape it is looking for", () => {
    // Non-vacuity for the SCANNER, planted into the very text it reads: this is
    // #92 verbatim, and the sweep must report it. Without this a broken walker
    // (a tag it fails to close, an href form it cannot read) reports an empty
    // list over the whole tree and the suite goes green on nothing.
    const planted = [
      "<Link",
      '  href={`/clients/${clientId}/agents`}',
      '  className="text-xs"',
      ">",
      "  Run an agent",
      '  <Icon name="ArrowRight" className="h-3 w-3" />',
      "</Link>",
    ].join("\n");
    const found = linkElements(planted).filter((el) => hrefValues(el.tag).some(isClientRosterHref));
    expect(found.length).toBe(1);
    expect(renderedText(found[0]!.body)).toMatch(RUN_VERB);
  });

  it("finds the roster controls that do exist", () => {
    // Non-vacuity for the SWEEP over the real tree: the roster is linked from
    // several honest places, so an empty result means the scan stopped working
    // rather than that the tree is clean.
    const all = files.flatMap(rosterControlsIn);
    expect(all.length).toBeGreaterThan(0);
  });

  it("lets none of them promise a run", () => {
    const offenders = files
      .flatMap(rosterControlsIn)
      .filter((c) => RUN_VERB.test(c.text))
      .map((c) => `${c.file}: "${c.text.trim()}"`);
    expect(
      offenders,
      "a control linking /clients/<id>/agents promises a run the roster has none of — " +
        "resolve it through intakePageAction instead",
    ).toEqual([]);
  });
});

/* ──────────────── #114: the intake pages' grant rung ────────────────────── */

function agent(over: Partial<CustomAgent> & Pick<CustomAgent, "id" | "key">): CustomAgent {
  return {
    name: over.key,
    description: "",
    icon: "Bot",
    color: "#fff",
    entrySkillDir: "products/live/x-agent",
    skillRoots: [],
    includeClientSkills: false,
    instructions: "",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as CustomAgent;
}

describe("#114 — a client may only open an intake page for an agent they have", () => {
  const X = agent({ id: "x1", key: "karos-x-agent-v2" });
  const LI_ACME = agent({ id: "li-acme", key: "karos-linkedin-company-acme" });

  const ask = (over: Partial<Parameters<typeof requireIntakeAgentAccess>[0]> = {}) =>
    requireIntakeAgentAccess({
      family: "x",
      isStaff: false,
      clientSlug: "acme",
      grantedAgentIds: ["x1"],
      runs: [],
      ...over,
    });

  it("refuses a client with no granted agent of that family and no run history", async () => {
    D.listCustomAgents.mockResolvedValue([X]);
    // The one case the family had no rung for: URL-typing onto a form for an
    // agent this client does not have. Same refusal as the detail route.
    await expect(ask({ grantedAgentIds: [] })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(ask({ grantedAgentIds: null })).rejects.toThrow("NEXT_NOT_FOUND");
    // Granted, but the lab disabled it — not an agent they have.
    D.listCustomAgents.mockResolvedValue([agent({ id: "x1", key: "karos-x-agent-v2", enabled: false })]);
    await expect(ask()).rejects.toThrow("NEXT_NOT_FOUND");
    // Granted an agent of a DIFFERENT family: the X page is still not theirs.
    D.listCustomAgents.mockResolvedValue([LI_ACME]);
    await expect(ask({ grantedAgentIds: ["li-acme"] })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("admits a granted client, and hands back the page their control points at", async () => {
    D.listCustomAgents.mockResolvedValue([X]);
    await expect(ask()).resolves.toBe("x1");
  });

  it("admits a client this family has already run for, though it was withdrawn", async () => {
    // The detail route's second rung (`|| hasDelivered`), at family grain — the
    // agent detail page links INTO these forms, so a client who can open that
    // page must not meet a 404 here.
    D.listCustomAgents.mockResolvedValue([]);
    await expect(ask({ grantedAgentIds: [], runs: [{ id: "job1" }] })).resolves.toBeNull();
  });

  it("never refuses staff, whose gate is requireVisibleClient", async () => {
    D.listCustomAgents.mockResolvedValue([]);
    await expect(ask({ isStaff: true, grantedAgentIds: [] })).resolves.toBeNull();
  });

  it("admits a granted client whose instance is bound elsewhere, without a destination", async () => {
    // The two rungs are deliberately different sets: the GATE ignores the
    // per-client instance filter (being coarser cannot 404 anyone), while the
    // PAGE ID keeps it so the control can never point at another client's
    // instance. Null here is a fallback to the roster, not a refusal — if this
    // ever throws, a legitimate client has lost their own intake form.
    D.listCustomAgents.mockResolvedValue([LI_ACME]);
    await expect(
      ask({ family: "linkedin", clientSlug: "other-co", grantedAgentIds: ["li-acme"] }),
    ).resolves.toBeNull();
  });

  it("is the only way the three pages get their control's destination", async () => {
    // MECHANICAL rather than written: the header control's href comes from
    // `intakePageAction({ clientId: id, isStaff, agentId })` (pinned in
    // agent-intake-navigation.test.ts), and this pins where `agentId` comes
    // from. A page cannot render the control without having passed the refusal.
    for (const family of ["x", "linkedin", "reddit"] as const) {
      const rel = `src/app/(app)/clients/[id]/${family}-agent/page.tsx`;
      const code = stripComments(read(rel));
      expect(code, rel).toContain("const agentId = await requireIntakeAgentAccess({");
      expect(code, rel).toContain(`family: "${family}",`);
      expect(code, rel).toContain("runs: view.runs,");
    }
  });
});
