/* eslint-disable @typescript-eslint/no-explicit-any */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #39, THE OTHER HALF: the fence on `/api/clients/[id]/*`, where the data is
 * actually served.
 *
 * The last round fenced the `/clients/[id]` PAGES with `canViewClient` and
 * proved it in `client-access-guard.test.ts`. Six of the seven API routes under
 * the same id carried no staff test at all — each had a single CLIENT_USER
 * branch and nothing else — so an employee who was 404'd on
 * `/clients/C/settings` could still read that client's context documents, open a
 * copilot over their whole workspace, pull their insights briefing and render
 * their full intelligence report, and could replace or delete their logo. A rule
 * enforced on the page and assumed in the API is the shape this campaign keeps
 * finding.
 *
 * Every handler is driven for real, with only the data layer, the session, the
 * model SDK and Storage mocked, and each one is asked the three questions that
 * matter:
 *
 *   1. the refused actor IS refused — with the route's OWN not-found shape, so a
 *      refusal never confirms that the client exists,
 *   2. the legitimate actors still work — an admin, an employee assigned on the
 *      CLIENT document, and an employee assigned on the USER document, because
 *      an over-tight fence breaks Karos's own staff, and
 *   3. nothing happened on the way out: a refused actor triggers no Storage
 *      write, no Firestore write and — on the two routes that charge — no charge.
 *
 * The third is the ORDER property. It is asked as "did the refused actor reach
 * the charge", by spying on the charge itself, rather than as "does a fence
 * appear before a charge in the source" — that second question is the one this
 * campaign has already been caught by.
 */

const CLIENT = {
  id: "c1",
  name: "Acme",
  status: "active",
  createdAt: 0,
  logoUrl: "https://cdn.test/old.png",
  logoStoragePath: "clients/c1/logos/old.png",
  assignedEmployeeIds: ["u-emp-1"],
};

const ADMIN = { uid: "u-admin", role: "KAROS_ADMIN", clientId: null, createdAt: 0 };
/** Assigned on the CLIENT document (`assignedEmployeeIds`). */
const ASSIGNED_ON_CLIENT = { uid: "u-emp-1", role: "KAROS_EMPLOYEE", clientId: null, createdAt: 0 };
/** Assigned on the USER document (`assignedClientIds`) — what the team page writes. */
const ASSIGNED_ON_USER = {
  uid: "u-emp-3",
  role: "KAROS_EMPLOYEE",
  clientId: null,
  assignedClientIds: ["c1"],
  createdAt: 0,
};
/** Neither document records the relationship. This is the actor the fence exists for. */
const UNASSIGNED = { uid: "u-emp-2", role: "KAROS_EMPLOYEE", clientId: null, createdAt: 0 };
/** The client whose workspace this is — must keep working on the routes they use. */
const OWN_CLIENT_USER = { uid: "u-client", role: "CLIENT_USER", clientId: "c1", createdAt: 0 };
/** A client logged into a DIFFERENT workspace — must never reach c1's data. */
const OTHER_CLIENT_USER = { uid: "u-client-2", role: "CLIENT_USER", clientId: "c2", createdAt: 0 };

const LEGITIMATE_STAFF = [
  ["an admin", ADMIN],
  ["an employee assigned on the client document", ASSIGNED_ON_CLIENT],
  ["an employee assigned on the user document", ASSIGNED_ON_USER],
] as const;

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
// The REAL auth module apart from the two session readers, so `isStaff` — which
// the insights route branches on before it charges — is the app's own function
// and not a second copy of it written in this file.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: vi.fn(), requireUser: vi.fn() };
});
vi.mock("@/lib/storage", () => ({ uploadBytes: vi.fn(), deleteObject: vi.fn() }));
vi.mock("@/lib/agent-roster", () => ({
  getClientCustomAgents: vi.fn(),
  buildAgentCatalog: vi.fn(() => []),
}));
vi.mock("@/lib/client-model-charge", () => ({
  chargeClientModelCall: vi.fn(),
  refundClientModelCall: vi.fn(),
  refundOnce: vi.fn(() => async () => {}),
}));
vi.mock("@/lib/simulation-engine", () => ({
  buildSimulationPersonas: vi.fn(),
  runSimulation: vi.fn(),
}));
vi.mock("ai", () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  generateObject: vi.fn(),
  tool: (t: unknown) => t,
  isLoopFinished: () => () => false,
  stepCountIs: () => () => false,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: Object.assign((id: string) => ({ id }), {
    tools: { webSearch_20250305: () => ({}) },
  }),
}));
vi.mock("@/services/logger", () => ({
  logger: { logUsage: vi.fn(), logGenerationFailure: vi.fn() },
}));

import { streamText } from "ai";
import * as data from "@/lib/data";
import * as clientAgentData from "@/lib/data-client-agents";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { getClientCustomAgents } from "@/lib/agent-roster";
import { chargeClientModelCall } from "@/lib/client-model-charge";
import { uploadBytes, deleteObject } from "@/lib/storage";
import { buildSimulationPersonas, runSimulation } from "@/lib/simulation-engine";

/** Both session readers, so a route is driven as this actor whichever it calls. */
function as(user: unknown) {
  vi.mocked(getCurrentUser).mockResolvedValue(user as any);
  vi.mocked(requireUser).mockResolvedValue(user as any);
}

const params = { params: Promise.resolve({ id: "c1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(data.getClient).mockResolvedValue(CLIENT as any);
  vi.mocked(data.listContextItems).mockResolvedValue([]);
  vi.mocked(data.createContextItem).mockResolvedValue("ci1");
  vi.mocked(data.updateClient).mockResolvedValue(undefined);
  vi.mocked(data.listCustomAgents).mockResolvedValue([]);
  vi.mocked(clientAgentData.listClientAgents).mockResolvedValue([]);
  vi.mocked(getClientCustomAgents).mockResolvedValue([{ id: "a1", name: "X agent" }] as any);
  vi.mocked(uploadBytes).mockResolvedValue({ url: "https://cdn.test/new.png", path: "p" } as any);
  vi.mocked(deleteObject).mockResolvedValue(undefined as any);
  vi.mocked(chargeClientModelCall).mockResolvedValue({ denied: null, chargedAt: null } as any);
});

/* ─────────────────────────── agents/mentionable ─────────────────────────── */

describe("GET /api/clients/[id]/agents/mentionable", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/clients/[id]/agents/mentionable/route");
    return GET(new Request("http://t/x"), params);
  };

  it("404s an employee neither document assigns, with the siblings' not-found shape", async () => {
    as(UNASSIGNED);
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Client not found" });
  });

  it("gives a client that does not exist the same answer", async () => {
    // This route used to hand a missing client an empty roster and a 200. If the
    // refusal above were a 404 and this were a 200, the pair would tell an
    // unassigned employee which client ids are real.
    as(UNASSIGNED);
    vi.mocked(data.getClient).mockResolvedValue(null);
    const refusedReal = await call();
    as(ADMIN);
    const missing = await call();
    expect(missing.status).toBe(refusedReal.status);
    await expect(missing.json()).resolves.toEqual(await refusedReal.json());
  });

  it.each(LEGITIMATE_STAFF)("still serves the mention list to %s", async (_label, user) => {
    as(user);
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      // `platform` is AF-20's mark, resolved off the agent itself rather than
      // off an umbrella nobody has bound yet — the rule and its refusals live
      // in copilot-mentionable-roster.test.ts. This suite is about the fence.
      agents: [{ id: "a1", displayName: "X agent", icon: "Bot", platform: "x" }],
    });
  });

  it("still serves the client whose workspace it is", async () => {
    as(OWN_CLIENT_USER);
    expect((await call()).status).toBe(200);
  });
});

/* ──────────────────────────────── context ──────────────────────────────── */

describe("GET /api/clients/[id]/context", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/clients/[id]/context/route");
    return GET(new Request("http://t/x"), params);
  };

  it("404s an employee neither document assigns, and reads no context items", async () => {
    as(UNASSIGNED);
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Client not found" });
    expect(data.listContextItems).not.toHaveBeenCalled();
  });

  it.each(LEGITIMATE_STAFF)("still lists context items for %s", async (_label, user) => {
    as(user);
    vi.mocked(data.listContextItems).mockResolvedValue([
      { id: "i1", clientId: "c1", kind: "doc", name: "brief.pdf", createdAt: 1 },
    ] as any);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
  });

  it("still lists them for the client whose workspace it is", async () => {
    as(OWN_CLIENT_USER);
    expect((await call()).status).toBe(200);
  });
});

describe("POST /api/clients/[id]/context", () => {
  const call = async () => {
    const { POST } = await import("@/app/api/clients/[id]/context/route");
    const form = new FormData();
    form.set("file", new File(["hello"], "brief.txt", { type: "text/plain" }));
    return POST(new Request("http://t/x", { method: "POST", body: form }), params);
  };

  it("404s an employee neither document assigns, and writes nothing", async () => {
    as(UNASSIGNED);
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Client not found" });
    // The write half of the fence: no Storage object, no Firestore document.
    expect(uploadBytes).not.toHaveBeenCalled();
    expect(data.createContextItem).not.toHaveBeenCalled();
  });

  it.each(LEGITIMATE_STAFF)("still accepts an upload from %s", async (_label, user) => {
    as(user);
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: "ci1" });
    expect(data.createContextItem).toHaveBeenCalledTimes(1);
  });
});

/* ───────────────────────────────── logo ───────────────────────────────── */

describe("POST /api/clients/[id]/logo", () => {
  const call = async () => {
    const { POST } = await import("@/app/api/clients/[id]/logo/route");
    const form = new FormData();
    form.set("file", new File(["png"], "logo.png", { type: "image/png" }));
    return POST(new Request("http://t/x", { method: "POST", body: form }), params);
  };

  it("404s an employee neither document assigns, and touches neither Storage nor the client", async () => {
    as(UNASSIGNED);
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Client not found" });
    expect(uploadBytes).not.toHaveBeenCalled();
    // The previous logo is deleted from Storage on the way through — damage that
    // would outlive the request, so the fence has to sit above it.
    expect(deleteObject).not.toHaveBeenCalled();
    expect(data.updateClient).not.toHaveBeenCalled();
  });

  it.each(LEGITIMATE_STAFF)("still replaces the logo for %s", async (_label, user) => {
    as(user);
    const res = await call();
    expect(res.status).toBe(200);
    expect(data.updateClient).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ logoUrl: "https://cdn.test/new.png" }),
    );
  });

  // Portal revamp, Account Center Profile tab: a client manages their own
  // "company picture" now — admitted through the same canViewClient fence
  // staff use, not a role carve-out, so a client from another workspace still
  // 404s exactly like the unassigned employee above.
  it("lets the client whose workspace it is replace their own logo", async () => {
    as(OWN_CLIENT_USER);
    const res = await call();
    expect(res.status).toBe(200);
    expect(data.updateClient).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ logoUrl: "https://cdn.test/new.png" }),
    );
  });

  it("404s a client logged into a different workspace, and touches neither Storage nor the client", async () => {
    as(OTHER_CLIENT_USER);
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Client not found" });
    expect(uploadBytes).not.toHaveBeenCalled();
    expect(data.updateClient).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/clients/[id]/logo", () => {
  const call = async () => {
    const { DELETE } = await import("@/app/api/clients/[id]/logo/route");
    return DELETE(new Request("http://t/x", { method: "DELETE" }), params);
  };

  it("404s an employee neither document assigns, and deletes nothing", async () => {
    as(UNASSIGNED);
    const res = await call();
    expect(res.status).toBe(404);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(data.updateClient).not.toHaveBeenCalled();
  });

  it.each(LEGITIMATE_STAFF)("still clears the logo for %s", async (_label, user) => {
    as(user);
    const res = await call();
    expect(res.status).toBe(200);
    expect(deleteObject).toHaveBeenCalledWith("clients/c1/logos/old.png");
    expect(data.updateClient).toHaveBeenCalledTimes(1);
  });

  it("lets the client whose workspace it is clear their own logo", async () => {
    as(OWN_CLIENT_USER);
    const res = await call();
    expect(res.status).toBe(200);
    expect(deleteObject).toHaveBeenCalledWith("clients/c1/logos/old.png");
  });

  it("404s a client logged into a different workspace, and deletes nothing", async () => {
    as(OTHER_CLIENT_USER);
    const res = await call();
    expect(res.status).toBe(404);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(data.updateClient).not.toHaveBeenCalled();
  });
});

/* ──────────────────────────────── report ──────────────────────────────── */

describe("GET /api/clients/[id]/report", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/clients/[id]/report/route");
    return GET(new Request("http://t/x"), params);
  };

  beforeEach(() => {
    vi.mocked(data.getClientReport).mockResolvedValue({
      clientId: "c1",
      reportHtml: "<h1>Acme intelligence report</h1>",
    } as any);
  });

  it("refuses an employee neither document assigns with THIS route's own shape", async () => {
    // Plain text, not the siblings' JSON: this handler serves text/html and
    // already answers "no report here" with a bare body, so the refusal reuses
    // that response byte for byte and the two cases stay indistinguishable. The
    // expectation is READ OFF the no-report answer rather than written out here,
    // so changing that copy cannot silently split the two apart.
    as(ADMIN);
    vi.mocked(data.getClientReport).mockResolvedValue(null as any);
    const noReport = await call();

    as(UNASSIGNED);
    vi.mocked(data.getClientReport).mockResolvedValue({ clientId: "c1", reportHtml: "<h1>x</h1>" } as any);
    const refused = await call();

    expect(refused.status).toBe(404);
    expect(refused.status).toBe(noReport.status);
    await expect(refused.text()).resolves.toBe(await noReport.text());
  });

  it("never reads the report it refuses to serve", async () => {
    as(UNASSIGNED);
    await call();
    expect(data.getClientReport).not.toHaveBeenCalled();
  });

  it.each(LEGITIMATE_STAFF)("still renders the report for %s", async (_label, user) => {
    as(user);
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("Acme intelligence report");
  });

  it("still renders it for the client whose report it is", async () => {
    as(OWN_CLIENT_USER);
    expect((await call()).status).toBe(200);
  });
});

/* ─────────────────────────────── insights ─────────────────────────────── */

describe("POST /api/clients/[id]/insights", () => {
  /** `?force=1` is the path that charges — see the route's own note.
   *  POST, not GET (2026-08): a GET here was a forgeable cross-site trigger
   *  for a charging request — see the route's own note. */
  const call = async (force = true) => {
    const { POST } = await import("@/app/api/clients/[id]/insights/route");
    return POST(new Request(`http://t/x${force ? "?force=1" : ""}`, { method: "POST" }), params);
  };

  beforeEach(() => {
    vi.mocked(data.listClientMarketingAnalytics).mockResolvedValue([]);
    vi.mocked(data.listClientIntegrations).mockResolvedValue([]);
    vi.mocked(data.getClientInsightsCache).mockResolvedValue(null);
    // One asset and no measured engagement puts the handler on its content-pipeline
    // branch, which reaches a model — and therefore the charge.
    vi.mocked(data.listAssets).mockResolvedValue([
      { id: "a1", title: "Launch post", type: "social_post", status: "draft", createdAt: Date.now() },
    ] as any);
    vi.mocked(streamText).mockReturnValue({
      toTextStreamResponse: () => new Response("briefing", { status: 200 }),
    } as any);
  });

  it("404s an employee neither document assigns", async () => {
    as(UNASSIGNED);
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Client not found" });
  });

  it("never charges, and never calls a model, for an actor it refuses", async () => {
    // THE ORDER PROPERTY, asked as a fact about what the refused actor reached.
    as(UNASSIGNED);
    await call();
    expect(chargeClientModelCall).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  it.each(LEGITIMATE_STAFF)("still briefs %s, and still reaches the charge", async (_label, user) => {
    as(user);
    const res = await call();
    expect(res.status).toBe(200);
    // The charge site is downstream of the fence, so a legitimate actor reaching
    // it is what proves the fence did not close over Karos's own staff. (Staff
    // pay nothing — `chargeClientModelCall` is the thing that knows that.)
    expect(chargeClientModelCall).toHaveBeenCalledTimes(1);
    expect(streamText).toHaveBeenCalledTimes(1);
  });
});

/* ───────────────────────────────── chat ───────────────────────────────── */

describe("POST /api/clients/[id]/chat", () => {
  const call = async () => {
    const { POST } = await import("@/app/api/clients/[id]/chat/route");
    return POST(
      new Request("http://t/x", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
      params,
    );
  };

  it("404s an employee neither document assigns", async () => {
    as(UNASSIGNED);
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Client not found" });
  });

  it("never charges the client for an actor it refuses", async () => {
    // `chargeClientModelCall` opens a Firestore transaction against the client's
    // balance. A refused actor must not reach a write of any kind, which is a
    // fact about position — asked here as "was it reached", not "does a fence
    // appear earlier in the file".
    as(UNASSIGNED);
    await call();
    expect(chargeClientModelCall).not.toHaveBeenCalled();
  });

  it.each(LEGITIMATE_STAFF)("lets %s through to the charge", async (_label, user) => {
    as(user);
    // Deliberately NOT asserting a finished response: this handler builds a
    // 1200-line prompt and a full tool suite past this point, and mocking all of
    // it would test the copilot rather than the fence. Reaching the charge — the
    // statement immediately after the fence — is exactly the claim this test
    // makes, and it is the claim that fails if the fence over-refuses.
    await call().catch(() => null);
    expect(chargeClientModelCall).toHaveBeenCalledTimes(1);
  });
});

/* ──────────────────────────────── simulate ──────────────────────────────── */

describe("POST /api/clients/[id]/simulate", () => {
  const ASSET = { id: "as1", clientId: "c1", title: "Post", content: "Body", type: "social_post" };
  const call = async () => {
    const { POST } = await import("@/app/api/clients/[id]/simulate/route");
    return POST(
      new Request("http://t/x", { method: "POST", body: JSON.stringify({ assetId: "as1" }) }),
      params,
    );
  };

  beforeEach(() => {
    vi.mocked(data.getAsset).mockResolvedValue(ASSET as any);
    vi.mocked(buildSimulationPersonas).mockResolvedValue([{ name: "Ops lead" }] as any);
    vi.mocked(runSimulation).mockResolvedValue([{ persona: "Ops lead", verdict: "ok" }] as any);
  });

  it("404s an employee neither document assigns, and never charges them", async () => {
    as(UNASSIGNED);
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Client not found" });
    expect(chargeClientModelCall).not.toHaveBeenCalled();
  });

  it("refuses a role that is none of the three", async () => {
    // The fence used to be keyed to `role === "KAROS_EMPLOYEE"`, which let any
    // other role walk past it. `canViewClient` defaults to false, so asking it
    // unconditionally is what makes this route fail closed.
    as({ uid: "u-x", role: "SOMETHING_NEW", clientId: null, createdAt: 0 });
    expect((await call()).status).toBe(404);
  });

  it.each(LEGITIMATE_STAFF)("still simulates for %s", async (_label, user) => {
    as(user);
    const res = await call();
    expect(res.status).toBe(200);
    expect(runSimulation).toHaveBeenCalledTimes(1);
  });
});

/* ───────────────────── the guard that outlives these tests ───────────────────── */

/**
 * WHAT WOULD HAVE CAUGHT THE ORIGINAL FAILURE: not a list of routes in a test
 * file — the six unfenced routes existed while the pages' own sweep was green —
 * but the filesystem. Every `route.ts` under `/api/clients/[id]` is discovered
 * on disk and must call the shared predicate at least once per handler it
 * exports, so a route added tomorrow is a failure here until it does.
 *
 * WHAT IT DOES NOT CLAIM, because the name would otherwise promise more than the
 * assertion: this is a source scan. It proves each file CALLS `canViewClient` as
 * many times as it exports handlers; it cannot prove a given handler's call is on
 * the path its own request takes, and it can be satisfied by two calls in one
 * handler and none in another. The behavioural blocks above are what prove that,
 * per handler, for the nine handlers that exist today. The scan's job is to make
 * the tenth impossible to add silently — which is why the per-handler count
 * matters and why the routes spell the check out instead of sharing a local
 * helper (a helper called from one handler would satisfy a file-level scan).
 */
/**
 * Next accepts `route.ts|tsx|js|jsx` as a Route Handler (`pageExtensions`
 * defaults to all four). Both scans below matched the literal string
 * "route.ts", so an unfenced `route.tsx` dropped into either tree left the
 * whole suite green — the one silent way to add the handler these guards exist
 * to make impossible to add silently.
 */
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx)$/;

describe("every route file under /api/clients/[id] calls the fence once per handler", () => {
  const API_DIR = join(process.cwd(), "src/app/api/clients/[id]");

  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...routeFiles(abs));
      else if (ROUTE_FILE.test(entry.name)) out.push(abs);
    }
    return out;
  }

  const files = routeFiles(API_DIR);

  it("found the routes it is about to check", () => {
    // A floor that only catches "the scan found nothing", deliberately well
    // BELOW today's count. It sat at exactly 7 with exactly 7 routes on disk,
    // which would have turned the suite red for deleting the dead `report`
    // route — a canary must not block the change it was written alongside.
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files.map((f) => [f.slice(process.cwd().length + 1), f] as const))(
    "%s",
    (_rel, abs) => {
      const src = readFileSync(abs, "utf8");
      const handlers = [
        ...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\s*\(/g),
      ].map((m) => m[1]);
      // A file with no handler is not a route; if this ever trips, the regex has
      // drifted from how handlers are declared and the count below means nothing.
      expect(handlers.length).toBeGreaterThan(0);

      // The CALL, not the mention: an import line carries the identifier too, and
      // asserting the bare name is how the pages' sweep once passed on a route
      // whose guard had been deleted.
      const calls = [...src.matchAll(/\bcanViewClient\s*\(/g)].length;
      expect(calls, `${handlers.join("/")} declared, ${calls} canViewClient call(s)`)
        .toBeGreaterThanOrEqual(handlers.length);
    },
  );
});

/* ─────────────── the same guard, keyed to the argument not the folder ─────────────── */

/**
 * WHY THIS EXISTS ON TOP OF THE SCAN ABOVE. The directory scan certified
 * `/api/clients/[id]` while FOUR routes outside that folder took a client id
 * from the request and asked nothing: `tasks/generate-swarm` (took the client's
 * AI lock, spent 5 of their credits and wrote tasks to their board),
 * `assets/bulk-upload` (signed an upload URL into their bucket and created
 * assets), `auth/social/[provider]` (signed the OAuth state the callback trusts,
 * so the integration landed on a client the actor was never assigned) and the
 * shared `authorizeAssetMedia` behind both `assets/[id]` routes. A guard keyed
 * to a FOLDER is a guard a new folder walks around; this one is keyed to the
 * property that actually matters — the handler accepts a client id — so the
 * only way past it is to be classified, and each classification is checked.
 *
 * EVERY route.ts under `src/app/api` must appear below exactly once. A new file
 * fails this until someone files it, and filing it in the wrong bucket fails
 * too, because the buckets assert their own claim rather than take it:
 *
 *   fenced  → calls `canViewClient` at least once per exported handler
 *   cron    → calls `requireCronSecret` (machine caller; iterates all clients
 *             by design, so a per-client fence would be meaningless)
 *   signed  → verifies an HMAC or a signed OAuth state, so the client id it
 *             acts on arrives proven rather than asserted by the caller
 *   self    → MUST NOT read a client id out of the request at all; the check is
 *             mechanical, so mis-filing a client-scoped route here is a failure
 *
 * The `self` bucket is the load-bearing one and the reason this can be trusted:
 * an exemption justified by a human sentence would have admitted all four of the
 * routes above.
 */
describe("every API route that takes a client id asks the fence", () => {
  const API_ROOT = join(process.cwd(), "src/app/api");

  const CLASSIFIED: Record<string, "fenced" | "cron" | "signed" | "self"> = {
    "agent-service/reconcile": "cron",
    "agent-service/webhook": "signed",
    "analytics/sync": "cron",
    "assets/[id]/download": "fenced",
    "assets/[id]/media": "fenced",
    "assets/bulk-upload": "fenced",
    "auth/session": "self",
    "auth/social/[provider]": "fenced",
    "auth/social/[provider]/callback": "signed",
    "cleanup-logs": "cron",
    "clients/[id]/agents/mentionable": "fenced",
    "clients/[id]/chat": "fenced",
    "clients/[id]/context": "fenced",
    "clients/[id]/downloads": "fenced",
    "clients/[id]/insights": "fenced",
    "clients/[id]/logo": "fenced",
    "clients/[id]/report": "fenced",
    "clients/[id]/simulate": "fenced",
    "credits/reconcile": "cron",
    // AF-19. Iterates every client with the digest switched on and mails their
    // own calendar day; the client ids come from the collection, never from the
    // request, which is the shape this bucket exists for.
    "daily-digest": "cron",
    "ingest/fireflies": "signed",
    // Filed "self" on the first pass and rejected by the mechanical check
    // below — it takes `?clientId=` and signs it into an OAuth state. Sixth
    // instance of the same shape in this campaign, found by the guard rather
    // than by a reader, which is the whole argument for keying on the argument.
    "integrations/linkedin/employee/auth": "fenced",
    "integrations/linkedin/employee/callback": "signed",
    "intel-report-schedule": "cron",
    mcp: "signed",
    publish: "cron",
    "run-scheduled": "cron",
    runway: "cron",
    scheduler: "cron",
    "tasks/generate-swarm": "fenced",
    "telemetry/track": "self",
    "users/avatar": "self",
    "users/resume": "self",
  };

  /**
   * A client id that came off the REQUEST, which is the thing that needs a
   * fence — as opposed to one read out of a document the route already loaded
   * (`job.clientId`, `run.clientId`, `asset.clientId`), which does not.
   */
  const FROM_REQUEST = [
    /searchParams\.get\(\s*["'`]clientId["'`]/,
    /\bparams\b[\s\S]{0,120}?\bclients\/\[id\]/,
    /\bbody\s*[.?]\s*clientId\b/,
    /\bbody\s*:\s*\{[^}]*\bclientId\b/,
    /formData\.get\(\s*["'`]clientId["'`]/,
  ];

  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...routeFiles(abs));
      else if (ROUTE_FILE.test(entry.name)) out.push(abs);
    }
    return out;
  }

  const discovered = routeFiles(API_ROOT)
    .map((f) =>
      f.slice(API_ROOT.length + 1).split(sep).join("/").replace(/\/route\.(ts|tsx|js|jsx)$/, ""),
    )
    .sort();

  /** The handler file for a route, whichever of the four extensions it uses. */
  function routeFileFor(route: string): string {
    const dir = join(API_ROOT, route);
    const name = readdirSync(dir).find((e) => ROUTE_FILE.test(e));
    if (!name) throw new Error(`no route file in ${route}`);
    return join(dir, name);
  }

  it("the inventory matches the filesystem exactly, in both directions", () => {
    // Both directions on purpose. A missing entry is a route nobody classified;
    // a stale entry is a bucket still vouching for a file that no longer exists,
    // which is how a list like this quietly stops describing the tree.
    expect(discovered).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it.each(discovered.map((r) => [r] as const))("%s", (route) => {
    const bucket = CLASSIFIED[route];
    const src = readFileSync(routeFileFor(route), "utf8");
    const handlers = [
      ...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\s*\(/g),
    ].map((m) => m[1]);
    expect(handlers.length, "no handler found — the regex has drifted").toBeGreaterThan(0);

    if (bucket === "fenced") {
      // The route file itself, or the one shared authorizer it delegates to.
      // Named explicitly rather than "any imported helper": a fence you have to
      // name is a fence somebody chose.
      const delegates = /\bauthorizeAssetMedia\s*\(/.test(src);
      const calls = [...src.matchAll(/\bcanViewClient\s*\(/g)].length;
      if (!delegates) {
        expect(calls, `${handlers.join("/")} declared, ${calls} canViewClient call(s)`)
          .toBeGreaterThanOrEqual(handlers.length);
      } else {
        const shared = readFileSync(join(process.cwd(), "src/lib/asset-media.ts"), "utf8");
        expect(shared, "the delegated authorizer stopped asking the fence")
          .toMatch(/\bcanViewClient\s*\(/);
      }
    }

    if (bucket === "cron") {
      expect(src, "filed as cron but nothing checks the shared secret")
        .toMatch(/\brequireCronSecret\s*\(/);
    }

    if (bucket === "signed") {
      expect(
        /\bverifyOAuthState\s*\(/.test(src) ||
          /\bcheckWebhookSecret\s*\(/.test(src) ||
          /\bverifyWebhookSignature\s*\(/.test(src) ||
          /signatureHeader\s*:/.test(src) ||
          /\bBearer\b/.test(src),
        "filed as signed but verifies no signature, state or bearer token",
      ).toBe(true);
    }

    if (bucket === "self") {
      // The mechanical half of the exemption: a route that never reads a client
      // id off the request cannot leak one client's data to another's actor.
      const reads = FROM_REQUEST.filter((re) => re.test(src));
      expect(
        reads.length,
        `filed as self-scoped but takes a client id from the request (${reads.length} pattern(s) matched) — it needs the fence, not an exemption`,
      ).toBe(0);
    }
  });
});
