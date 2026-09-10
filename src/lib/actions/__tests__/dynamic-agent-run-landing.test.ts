/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ONE "RUN" BUTTON A CLIENT CAN PRESS — flow audit 2026-09, R2 (F1, F17).
 *
 * It used to end by throwing them out of the app: on success it pushed
 * `/jobs/{jobId}`, a staff-guarded route, so a CLIENT_USER was bounced
 * `/jobs/{id}` → `/dashboard` → `/clients/{id}` and landed on Home with no
 * acknowledgement. And on failure it returned the submit core's error verbatim,
 * so an internal configuration string ("AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN")
 * could be printed to a client.
 *
 * Two halves, tested where each lives:
 *
 *  · The SANITISER is server-side, and is exercised for real against
 *    `runDynamicAgentAction` with only its dependencies mocked — a filter
 *    applied in the browser would leak the string into the RSC payload
 *    regardless, so where it runs is the point.
 *  · The LANDING is a client component's state, which a static render cannot
 *    reach (there is no event loop to press the button with). What can be
 *    asserted, and is what actually broke, is that the navigation is gone and
 *    the surface says where the output goes instead.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");

const requireClientAccessMock = vi.fn();
vi.mock("@/lib/actions/_shared", () => ({
  requireAdmin: vi.fn(),
  requireClientAccess: (...args: unknown[]) => requireClientAccessMock(...args),
}));

const submitDynamicAgentJobMock = vi.fn();
vi.mock("@/lib/jobs/submit-custom", () => ({
  submitDynamicAgentJob: (...args: unknown[]) => submitDynamicAgentJobMock(...args),
}));

import { CLIENT_RUN_REFUSAL_MESSAGE } from "@/lib/custom-agent-launch";
import { CREDIT_DENIAL_PREFIX } from "@/lib/credits";
import { runDynamicAgentAction } from "../dynamic-agent-actions";

const CLIENT_USER = { uid: "u1", email: "c@acme.test", name: "Client", role: "CLIENT_USER" } as any;
const STAFF_USER = { uid: "u2", email: "s@karoslabs.test", name: "Staff", role: "KAROS_EMPLOYEE" } as any;

/** The exact string submit-custom.ts refuses with when the service is unset. */
const RAW_CONFIG_ERROR =
  "Agent service is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN).";

beforeEach(() => {
  requireClientAccessMock.mockReset().mockResolvedValue(CLIENT_USER);
  submitDynamicAgentJobMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("runDynamicAgentAction never hands a client the submit core's internals", () => {
  it("replaces a raw config error with the client-safe sentence", async () => {
    submitDynamicAgentJobMock.mockResolvedValue({ error: RAW_CONFIG_ERROR });

    const result = await runDynamicAgentAction("spec1", "c1", {});

    expect(result.error).toBe(CLIENT_RUN_REFUSAL_MESSAGE);
    expect(result.error).not.toContain("AGENT_SERVICE_URL");
    expect(result.error).not.toContain("AGENT_SERVICE_TOKEN");
  });

  it("passes a refusal written FOR the client through untouched", async () => {
    // The allowlist's whole purpose: a credit denial names an amount and a
    // remedy the client can act on, and collapsing it to the generic sentence
    // would be a fix that took the answer with it.
    // Built from the prefix the allowlist recognises, not a hand-typed
    // sentence — the denial's own house style has changed three times.
    const denial = `${CREDIT_DENIAL_PREFIX.insufficient_balance} 12 credits and you have 3.`;
    submitDynamicAgentJobMock.mockResolvedValue({ error: denial });

    expect((await runDynamicAgentAction("spec1", "c1", {})).error).toBe(denial);
  });

  it("leaves a STAFF caller's error alone, so an operator can still debug it", async () => {
    requireClientAccessMock.mockResolvedValue(STAFF_USER);
    submitDynamicAgentJobMock.mockResolvedValue({ error: RAW_CONFIG_ERROR });

    expect((await runDynamicAgentAction("spec1", "c1", {})).error).toBe(RAW_CONFIG_ERROR);
  });

  it("returns the job on the happy path, unchanged", async () => {
    submitDynamicAgentJobMock.mockResolvedValue({ jobId: "job-9" });

    expect(await runDynamicAgentAction("spec1", "c1", {})).toEqual({ jobId: "job-9" });
  });
});

/**
 * Comments out. This file's subject is a defect whose old shape has to be
 * NAMED in the component's own docstring ("it used to call router.push"), so a
 * raw source scan would read that explanation as the code still doing it.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("the run surface resolves in place instead of navigating", () => {
  const src = stripComments(
    readFileSync(join(process.cwd(), "src/components/dynamic-agent-run.tsx"), "utf8"),
  );

  it("no longer pushes the client at the staff-only job route", () => {
    expect(src).not.toContain("router.push");
    expect(src).not.toContain("/jobs/");
    expect(src).not.toContain("useRouter");
  });

  it("says where the output lands, the way the six lab intakes do", () => {
    // Not a raw job id ("Submitted, job {jobId}.") on a page the reader was
    // being navigated off — the archive, named through the one helper that
    // knows which archive route this reader can open.
    expect(src).toContain("clientArchiveLink");
    expect(src).toContain("Your run has started");
    expect(src).not.toContain("Submitted, job");
  });

  it("routes the press through the intake funnel", () => {
    // A rejection (lapsed session, cold container) used to escape the
    // transition with no result to read, leaving a dead button and no message.
    expect(src).toContain("intakeSave(");
    expect(src).toContain("INTAKE_ACTION_FAILED");
  });
});
