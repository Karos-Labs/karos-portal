import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The client-facing cancel path, pinned from source.
 *
 * Same reason as copilot-tool-access.test.ts and shell-chrome.test.ts: the
 * action is a server module whose import graph reaches the Admin SDK and the
 * control is a React component, so neither can be imported into a node test
 * run. What these assert is the ORDER and the SHAPE — the two properties that
 * were wrong and that a unit test of the pieces would not have caught.
 */

const src = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

const action = src("lib/actions/external-job-actions.ts");
const control = src("components/custom-agents.tsx");
const detailPage = src("app/(app)/clients/[id]/agents/[agentId]/page.tsx");

/**
 * The slice of `source` that starts at `from` and stops at the next top-level
 * declaration — brace-matching a TSX body with a regex is not worth the trouble
 * and a slightly generous window still localizes every assertion below.
 */
function sliceFrom(source: string, from: string): string {
  const start = source.indexOf(from);
  if (start < 0) return "";
  const rest = source.slice(start + from.length);
  const end = rest.search(/\n(?:export |(?:async )?function |const [A-Z])/);
  return from + (end < 0 ? rest : rest.slice(0, end));
}

describe("cancelClientAgentJobAction — authorize before answering about existence", () => {
  const body = sliceFrom(action, "export async function cancelClientAgentJobAction");

  it("was located", () => {
    expect(body).not.toBe("");
  });

  it("authorizes before it can reveal that a job is not a managed run", () => {
    const authAt = body.indexOf("requireClientAccess");
    const externalAt = body.indexOf("!job.external");
    expect(authAt).toBeGreaterThan(-1);
    expect(externalAt).toBeGreaterThan(-1);
    // The old order returned "Not a managed job." for an unknown id and only
    // THEN authorized, so missing and foreign answered differently — an
    // existence oracle over a global id space.
    expect(authAt).toBeLessThan(externalAt);
  });

  it("gives missing, foreign and non-managed jobs ONE identical answer", () => {
    // Three returns, one constant. A second literal here is the defect back.
    const notFoundReturns = body.match(/return \{ error: NOT_FOUND \}/g) ?? [];
    expect(notFoundReturns.length).toBe(3);
    // The precise "Not a managed job." line survives only on the STAFF path
    // (requestJobCancellation, reached by the requireStaff action), where
    // telling a staff member exactly what is wrong reveals nothing.
    expect(body).not.toMatch(/Not a managed job\./);
  });

  it("keeps 'Unauthorized' distinct — a dead session is the caller's own state", () => {
    expect(body).toMatch(/message === "Unauthorized"/);
  });
});

describe("CancelRunControl", () => {
  const body = sliceFrom(control, "export function CancelRunControl");

  it("was located", () => {
    expect(body).not.toBe("");
  });

  it("catches a throwing action instead of losing the route to the error boundary", () => {
    // requireClientAccess throws; so does a failed server-action round trip.
    const tryAt = body.indexOf("try {");
    const callAt = body.indexOf("cancelClientAgentJobAction(");
    const catchAt = body.indexOf("} catch");
    expect(tryAt).toBeGreaterThan(-1);
    expect(tryAt).toBeLessThan(callAt);
    expect(catchAt).toBeGreaterThan(callAt);
    // The row already renders `error`, so the failure has somewhere to land.
    expect(body).toMatch(/setError\(e instanceof Error \? e\.message/);
  });

  it("only promises a refund when the viewer was actually charged", () => {
    expect(body).toMatch(/refunds/);
    expect(body).toMatch(/refunds \?[\s\S]{0,120}Credits for it are returned/);
  });
});

describe("legacy agent banner attribution (F31)", () => {
  const block = sliceFrom(detailPage, "const legacyRun = umbrella");

  it("was located", () => {
    expect(block).not.toBe("");
  });

  it("claims only a run this viewer started", () => {
    // "Making your next post now", with a Cancel promising credits back, was
    // matching ANY in-flight run on the agent — including a cron fire from a
    // schedule staff set, which charges the client nothing.
    expect(block).toMatch(/job\.createdBy === user\.uid/);
  });

  it("still excludes launch runs", () => {
    expect(block).toMatch(/job\.runType !== "launch"/);
  });

  it("hands the banner a refund flag derived from billability", () => {
    expect(detailPage).toMatch(/refunds: spendable !== undefined/);
  });
});
