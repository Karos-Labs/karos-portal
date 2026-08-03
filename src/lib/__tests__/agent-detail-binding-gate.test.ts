import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentKeyMatchesClientSlug } from "@/lib/custom-agent-launch";
import { stripComments } from "./source-scan";

/**
 * #132 — THREE SIBLINGS FILTER, THE DESTINATION DID NOT.
 *
 * A per-client agent instance runs an entry skill baked under ONE client's lab
 * folder, so the pair is fixed. The roster (both branches), the settings page
 * and `agentsWithDeliveredWork` all drop an instance belonging to another
 * client. `/clients/A/agents/<instance-of-B>` did not: it resolved, and rendered
 * A's status strip, setup facts, intake panes, schedule controls and run
 * gesture around an agent that can only ever draft for B. For a CLIENT it
 * resolved whenever the agent had been granted or had ever delivered.
 *
 * The submit core refuses the pair at run time, so this was never about what
 * could be GENERATED — it is about what the page tells a client is theirs, and
 * about a client being able to learn which instances the lab holds by probing
 * ids.
 *
 * An RSC page cannot be driven here (nothing in this suite imports one — the
 * import graph reaches the Admin SDK), so this is the same pairing
 * `client-access-guard` uses for the pages it fences: the PREDICATE is proved
 * behaviourally, and the page's use of it is proved from the filesystem, over
 * every surface of the same shape rather than over a list typed here.
 */

const SRC = join(process.cwd(), "src");
const CLIENTS_DIR = join(SRC, "app/(app)/clients/[id]");

/* ───────────────────────── the rule this page now asks ───────────────────────── */

describe("the binding a per-client instance carries", () => {
  const INSTANCE = "karos-linkedin-company-acme";

  it("refuses the instance of one client for another", () => {
    expect(agentKeyMatchesClientSlug(INSTANCE, "bravo")).toBe(false);
  });

  it("refuses it for a client with no lab folder at all", () => {
    // The client the finding describes: `/clients/A/agents/<instance-of-B>`
    // where A has no slug. "No folder" must not read as "every folder".
    expect(agentKeyMatchesClientSlug(INSTANCE, null)).toBe(false);
    expect(agentKeyMatchesClientSlug(INSTANCE, undefined)).toBe(false);
    expect(agentKeyMatchesClientSlug(INSTANCE, "")).toBe(false);
  });

  it("still passes the instance for its own client, and every unbound agent", () => {
    // The other direction: a gate that refused everything would satisfy the two
    // assertions above and take every agent page down with it.
    expect(agentKeyMatchesClientSlug(INSTANCE, "acme")).toBe(true);
    for (const key of ["karos-x-agent", "karos-reddit-agent", "karos-instagram-agent"]) {
      expect(agentKeyMatchesClientSlug(key, "bravo"), key).toBe(true);
      expect(agentKeyMatchesClientSlug(key, null), key).toBe(true);
    }
  });
});

/* ─────────────── every client surface that resolves an agent asks it ─────────────── */

/**
 * KEYED TO THE SHAPE. A list of the three siblings would have certified exactly
 * the three that were already right. The property is "this surface resolves a
 * custom agent for the client in the URL" — every file under `/clients/[id]`
 * that reads the agent catalogue must also carry the binding filter, so the
 * next such route is a failure here until it does.
 */
describe("every surface under /clients/[id] that resolves an agent filters on the binding", () => {
  function pageFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...pageFiles(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  /** Reads the custom-agent catalogue: by id, or the whole enabled list. */
  const RESOLVES_AGENT = [
    /\bgetCustomAgent\s*\(/,
    /\blistCustomAgents\s*\(/,
    /\bgetClientCustomAgents\s*\(/,
  ];

  const surfaces = pageFiles(CLIENTS_DIR)
    .map((abs) => ({ rel: abs.slice(SRC.length + 1), src: stripComments(readFileSync(abs, "utf8")) }))
    .filter((f) => RESOLVES_AGENT.some((re) => re.test(f.src)));

  it("found the surfaces it is about to check", () => {
    // Non-vacuity: an empty list would make the rule below hold over nothing,
    // which is what a directory rename looks like from in here.
    expect(surfaces.map((s) => s.rel).sort()).toEqual([
      "app/(app)/clients/[id]/agents/[agentId]/page.tsx",
      "app/(app)/clients/[id]/agents/page.tsx",
      "app/(app)/clients/[id]/settings/page.tsx",
    ]);
  });

  it.each(surfaces.map((s) => [s.rel, s.src] as const))("%s", (rel, src) => {
    // ONE FILTER PER RESOLUTION, not "the file mentions it somewhere". The
    // roster reads the catalogue twice — once in its client branch and once in
    // its staff branch — and a file-level answer is satisfied by either one
    // alone. That is the same shape as a two-handler route with one guard, and
    // it is how the second unfiltered list regressed here before.
    //
    // The CALL, not the mention: the import line carries the identifier, which
    // is how a sweep passes over a filter that has been deleted.
    const resolutions = RESOLVES_AGENT.reduce(
      (total, re) => total + [...src.matchAll(new RegExp(re.source, "g"))].length,
      0,
    );
    const filters = [...src.matchAll(/\bagentKeyMatchesClientSlug\s*\(/g)].length;
    expect(resolutions, `${rel}: matched as a surface but resolves nothing`).toBeGreaterThan(0);
    expect(
      filters,
      `${rel}: ${resolutions} agent-catalogue read(s), ${filters} binding filter(s)`,
    ).toBeGreaterThanOrEqual(resolutions);
  });
});

/* ─────────────────────── the destination's own refusal ─────────────────────── */

describe("the agent detail route refuses the pair rather than rendering it", () => {
  const rel = "app/(app)/clients/[id]/agents/[agentId]/page.tsx";
  const src = stripComments(readFileSync(join(SRC, rel), "utf8"));

  it("refuses with notFound(), the shape its sibling client gate uses", () => {
    // A distinct refusal here would answer "does this instance exist" for every
    // key a client guessed, which is the thing the client gate below it exists
    // to avoid. Matched as one statement — the predicate and the refusal
    // together — because either alone proves nothing about the other.
    expect(src).toMatch(
      /if\s*\(\s*!agentKeyMatchesClientSlug\s*\(\s*agent\.key\s*,\s*client\.agentsRepoSlug\s*\)\s*\)\s*notFound\s*\(\s*\)\s*;/,
    );
  });

  it("asks it against the resolved client, not the id in the URL", () => {
    // `client` comes from requireVisibleClient; the raw `id` param would fence
    // on a string the caller supplied.
    expect(src).not.toMatch(/agentKeyMatchesClientSlug\s*\(\s*agent\.key\s*,\s*id\b/);
  });

  it("refuses before it builds anything for the pair", () => {
    // Position, and the reason it matters here rather than for a write: the
    // intake panes and the setup facts are reads of the OTHER client's
    // configuration, assembled into this client's RSC payload.
    const gate = src.search(/!agentKeyMatchesClientSlug/);
    const panes = src.search(/\bagentIntakePane\s*\(\s*id\b/);
    const setup = src.search(/\bbuildAgentSetup\s*\(/);
    expect(gate, "the gate is missing").toBeGreaterThan(-1);
    expect(panes, "the intake pane call is missing").toBeGreaterThan(-1);
    expect(setup, "the setup call is missing").toBeGreaterThan(-1);
    // Both compared against a gate proved present above, so two absences
    // cannot pass this as -1 < 0.
    expect(gate).toBeLessThan(panes);
    expect(gate).toBeLessThan(setup);
  });
});
