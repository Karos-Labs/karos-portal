import { describe, expect, it, vi } from "vitest";

/**
 * A CLIENT READS THE ASSET BODY, SO IT MUST NOT NAME OUR MACHINERY.
 *
 * The landing materializer shipped three separate sentences that did:
 *
 *   "The engine's own checks did not all pass; review before sharing."
 *   "…no site bundle was uploaded (GCS_ARTIFACTS_BUCKET not configured on agent-engine)."
 *   "Site source (12 files) uploaded to gs://karoscmo-prod-agent-artifacts/…"
 *
 * The first names our engine and phrases an instruction as our anxiety rather
 * than the client's next step. The second names an environment variable and a
 * service for a misconfiguration on OUR side, which is exactly the thing
 * AF-14 says is not the client's to attend to. The third prints a storage path
 * they cannot open.
 *
 * ## Why no existing guard caught it
 *
 * `client-copy-boundary` has two channels that should have covered this and
 * neither could:
 *
 *   - **Channel 5** walks out from Next.js render entry points and follows
 *     imports. This copy is written by a SERVER JOB into the database and read
 *     as data much later, so no render entry point ever imports it.
 *   - **The database channel** tracks `createAsset.title` as client-facing —
 *     but it finds string LITERALS passed to a tracked field, and
 *     `createAsset.content` is always a computed join. Adding `content` to its
 *     list makes the channel's own anti-vacuity check fail, correctly: there
 *     is no literal to find.
 *
 * So this is a BEHAVIOURAL guard instead of a source scan. It calls the
 * materializer and reads the `content` it actually produces, which is immune
 * to how the string was assembled — the exact weakness that let three
 * sentences through.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/storage", () => ({ uploadBytes: vi.fn() }));

import { materializeLandingPageSite, type LandingPageSiteDeliverable } from "@/lib/agent-engine/materialize";
import type { Job } from "@/lib/types";

/**
 * Words that belong to us, not to the client.
 *
 * A deny-list of internal NOUNS, deliberately — not an attempt to judge tone.
 * "Does this sentence name a thing only we can see?" is decidable; "is this
 * sentence client-appropriate?" is not, and a guard that tries to decide the
 * second is the heuristic-that-is-really-a-note this codebase keeps catching.
 */
const INTERNAL_VOCABULARY = [
  "agent-engine",
  "GCS_",
  "gs://",
  "Firestore",
  "pubsub",
  "tooling_error",
  "the engine's",
  "the engine ",
  "workflow step",
  "not configured",
];

function job(): Job {
  return { id: "job-1", clientId: "c1", agentEngineProductId: "landing-builder-agent" } as Job;
}

function offences(content: string): string[] {
  return INTERNAL_VOCABULARY.filter((w) => content.toLowerCase().includes(w.toLowerCase()));
}

describe("the landing page body a client reads", () => {
  it("says what to do, without naming the engine, when the build needs a human", async () => {
    const result = await materializeLandingPageSite(job(), {
      title: "Acme",
      status: "needs_human",
      liveUrl: "https://karos-acme.web.app",
    } as LandingPageSiteDeliverable);

    expect(offences(result.content)).toEqual([]);
    // It must still TELL them something — silence would be the other failure.
    expect(result.content).toMatch(/read before you share/i);
  });

  it("does not name an environment variable when our own storage is misconfigured", async () => {
    const result = await materializeLandingPageSite(job(), { title: "Acme" } as LandingPageSiteDeliverable);

    expect(offences(result.content)).toEqual([]);
    expect(result.content).toMatch(/build completed/i);
    // The diagnostic is not lost — it moves to where staff read it.
    expect(String(result.meta["buildNote"])).toMatch(/GCS_ARTIFACTS_BUCKET/);
  });

  it("does not print a storage path to a client on a v1 deliverable", async () => {
    const result = await materializeLandingPageSite(job(), {
      title: "Acme",
      gcsPrefix: "gs://karoscmo-prod-agent-artifacts/runs/abc",
      fileCount: 12,
    } as LandingPageSiteDeliverable);

    expect(offences(result.content)).toEqual([]);
    expect(result.content).toContain("12 files");
    // Still available to staff.
    expect(result.meta["gcsPrefix"]).toBe("gs://karoscmo-prod-agent-artifacts/runs/abc");
  });

  it("leaves the parts a client genuinely needs in the body", async () => {
    const result = await materializeLandingPageSite(job(), {
      title: "Acme",
      status: "ok",
      liveUrl: "https://karos-acme.web.app",
      previewUrl: "https://karos-acme--preview.web.app",
      description: "A landing page for Acme's spring launch.",
    } as LandingPageSiteDeliverable);

    expect(result.content).toContain("https://karos-acme.web.app");
    expect(result.content).toContain("A landing page for Acme's spring launch.");
    expect(offences(result.content)).toEqual([]);
  });

  it("would fail if any of the three original sentences came back", () => {
    // Anti-vacuity: the rule has to be able to refuse. These are the exact
    // strings that shipped.
    expect(offences("The engine's own checks did not all pass; review before sharing.")).not.toEqual([]);
    expect(offences("no site bundle was uploaded (GCS_ARTIFACTS_BUCKET not configured on agent-engine).")).not.toEqual([]);
    expect(offences("Site source (12 files) uploaded to gs://karoscmo-prod-agent-artifacts/runs/abc")).not.toEqual([]);
  });
});
