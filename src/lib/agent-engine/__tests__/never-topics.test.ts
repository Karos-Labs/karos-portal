import { beforeEach, expect, it, vi } from "vitest";

/**
 * ── TWO LISTS, ONE VET (SCRUM-468 bullet 4). ──
 *
 * A client who says "never write about our pricing" while reviewing a draft
 * lands in the middleware's `neverTopics`, which reaches the next prompt as an
 * instruction. The thing that can actually BLOCK a run — the forbidden-topics
 * guardrail — read `client.forbiddenTopics` and nothing else, so the topic the
 * client cared most about was the one topic nobody enforced.
 */

const { prefsMock } = vi.hoisted(() => ({ prefsMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../learning-feedback", () => ({ readLearningPreferences: prefsMock }));

import { effectiveForbiddenTopics } from "../never-topics";

const CLIENT = { agentsRepoSlug: "acme", forbiddenTopics: ["layoffs"] };

beforeEach(() => {
  prefsMock.mockReset().mockResolvedValue({ neverTopics: [], standingInstructions: [] });
});

it("adds what the client said in review to what somebody typed in the editor", async () => {
  prefsMock.mockResolvedValue({ neverTopics: ["our pricing"], standingInstructions: [] });
  expect(await effectiveForbiddenTopics(CLIENT)).toEqual(["layoffs", "our pricing"]);
});

it("counts a topic on both lists once, keeping the spelling somebody typed", async () => {
  // Two copies of one rule reach the vet as two rules and are counted twice in
  // the guardrail report.
  prefsMock.mockResolvedValue({ neverTopics: ["Layoffs"], standingInstructions: [] });
  expect(await effectiveForbiddenTopics(CLIENT)).toEqual(["layoffs"]);
});

it("leaves the portal's list exactly as it was when the loop has nothing to add", async () => {
  expect(await effectiveForbiddenTopics(CLIENT)).toEqual(["layoffs"]);
});

it("falls back to the portal's list when the control plane cannot be read", async () => {
  // Which is what every run has done until now, so an outage here costs a run
  // nothing it was not already missing.
  prefsMock.mockResolvedValue(undefined);
  expect(await effectiveForbiddenTopics(CLIENT)).toEqual(["layoffs"]);
});

it("is an empty list for a client with neither, rather than throwing", async () => {
  expect(await effectiveForbiddenTopics({ agentsRepoSlug: "acme", forbiddenTopics: undefined })).toEqual([]);
});

it("never writes anything back", async () => {
  // Deliberate, and the reason is in the module: one flat array cannot say
  // which row came from where, so a mirror either overwrites a staff-curated
  // list or makes a withdrawn never-topic permanent. A read at submit time
  // has neither failure.
  const client = { agentsRepoSlug: "acme", forbiddenTopics: ["layoffs"] };
  prefsMock.mockResolvedValue({ neverTopics: ["our pricing"], standingInstructions: [] });
  await effectiveForbiddenTopics(client);
  expect(client.forbiddenTopics).toEqual(["layoffs"]);
});
