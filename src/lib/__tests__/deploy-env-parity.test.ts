import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The two deploy configs must set the same environment variable NAMES.
 *
 * Both use `gcloud run deploy --set-env-vars`, which REPLACES the whole set
 * rather than merging. Anything a running service has and its deploy config
 * lacks is silently deleted on the next deploy, and nothing reports it.
 *
 * That has now happened twice on this file. The 2026-07-31 incident is
 * documented in cloudbuild.promote.yaml's own header; on 2026-08-22 a promote
 * dropped AGENT_ENGINE_PUBSUB_TOPIC, AGENT_ENGINE_URL, AGENT_ENGINE_AUDIENCE
 * and GOOGLE_CLOUD_PROJECT, which had been set by hand on the production
 * revision and written into no config. Losing the Pub/Sub topic is the worst
 * of them: `isAgentEnginePubSubConfigured()` goes false, so a control-plane
 * outage has nowhere to fall back to and dispatch fails outright instead of
 * degrading.
 *
 * A comment saying "keep the two in sync" is what existed before, and it did
 * not hold. This is the same instruction, enforced.
 *
 * NAMES only, never values — the whole point is that prep and production
 * carry different values for the same keys.
 */
function envNames(file: string): Set<string> {
  const text = readFileSync(resolve(process.cwd(), file), "utf8");
  // The deploy step's --set-env-vars argument. Comment lines mention the flag
  // too (cloudbuild.yaml explains the custom-delimiter escape hatch), so drop
  // those and take the longest remaining match — the real argument is one very
  // long line and no comment comes close.
  const line = text
    .split("\n")
    .filter((l) => l.includes("--set-env-vars=") && !l.trimStart().startsWith("#"))
    .sort((a, b) => b.length - a.length)[0];
  if (!line) throw new Error(`no --set-env-vars found in ${file}`);
  const names = new Set<string>();
  for (const match of line.matchAll(/([A-Z][A-Z0-9_]*)=/g)) {
    names.add(match[1]!);
  }
  return names;
}

describe("deploy config env parity", () => {
  it("prep and production set the same env var names", () => {
    const prep = envNames("cloudbuild.yaml");
    const prod = envNames("cloudbuild.promote.yaml");

    const missingInProd = [...prep].filter((n) => !prod.has(n)).sort();
    const missingInPrep = [...prod].filter((n) => !prep.has(n)).sort();

    expect(
      { missingInProd, missingInPrep },
      "--set-env-vars REPLACES the whole set, so a name in one config and not the other is deleted from that " +
        "environment on its next deploy. Add it to both (values may differ), or explain the asymmetry here.",
    ).toEqual({ missingInProd: [], missingInPrep: [] });
  });

  it("both configs carry the settings a dispatch cannot work without", () => {
    // Named explicitly rather than left to the parity check alone: parity
    // would still pass if a key were dropped from BOTH files at once, and
    // these four are the ones whose absence breaks dispatch silently.
    const required = [
      "AGENT_ENGINE_DISPATCH_ENABLED",
      "AGENT_ENGINE_PUBSUB_TOPIC",
      "AGENT_MIDDLEWARE_URL",
      "AGENT_MIDDLEWARE_AUDIENCE",
    ];
    for (const file of ["cloudbuild.yaml", "cloudbuild.promote.yaml"]) {
      const names = envNames(file);
      for (const key of required) {
        expect(names.has(key), `${file} must set ${key}`).toBe(true);
      }
    }
  });

  it("every substitution the deploy step references is declared", () => {
    // Cloud Build fails the whole build on an undeclared substitution, which
    // is a slow way to find a typo.
    for (const file of ["cloudbuild.yaml", "cloudbuild.promote.yaml"]) {
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      const declared = new Set(
        [...text.matchAll(/^ {2}(_[A-Z0-9_]+):/gm)].map((m) => m[1]!),
      );
      const used = new Set([...text.matchAll(/\$\{(_[A-Z0-9_]+)\}/g)].map((m) => m[1]!));
      const undeclared = [...used].filter((u) => !declared.has(u)).sort();
      expect(undeclared, `${file} references undeclared substitutions`).toEqual([]);
    }
  });

  it("the promote carries a real value for every var whose empty value silently disables something", () => {
    // A THIRD failure mode, distinct from the two above. The variable name is
    // present in --set-env-vars, so the parity check passes; what is empty is
    // the SUBSTITUTION DEFAULT behind it, and the promote passes no value for
    // it, so production gets the name bound to "".
    //
    // On 2026-08-23 that took karoslabs off agent-engine during a routine
    // promote. Nothing failed: empty is a legal value for this variable
    // meaning "no client is cut over", so the fleet quietly reverted to
    // agent-service and every health check stayed green.
    //
    // Only variables where empty means "off" belong here. A variable that is
    // genuinely optional, or whose value truly differs per deploy, does not.
    const mustNotBeEmpty = ["_AGENT_ENGINE_CUSTOM_AGENT_CLIENTS"];
    const text = readFileSync(resolve(process.cwd(), "cloudbuild.promote.yaml"), "utf8");
    for (const key of mustNotBeEmpty) {
      const match = text.match(new RegExp(`^ {2}${key}: *(.*)$`, "m"));
      expect(match, `cloudbuild.promote.yaml must declare ${key}`).not.toBeNull();
      const value = match![1]!.trim().replace(/^["']|["']$/g, "");
      expect(value, `${key} must not default to empty — empty silently disables it in production`).not.toBe("");
    }
  });
});
