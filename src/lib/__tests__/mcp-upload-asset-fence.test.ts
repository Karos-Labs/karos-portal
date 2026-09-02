/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE DRAFT-ONLY FENCE ON THE ONE SURFACE WHERE THE AGENT TYPES ITS OWN OUTPUT.
 *
 * `upload_asset` is called BY A RUNNING AGENT, and its `type` argument is that
 * agent's own choice. The asset type decides whether the product offers to
 * publish — `PUBLISHABLE_PLATFORMS` is keyed by it — so a Reddit reply typed
 * `social_post` is offered to twitter, linkedin and tiktok. Reddit is
 * draft-only by hard product rule: a human posts the reply from their own
 * account, and no posting code path exists or may be added.
 *
 * `platforms-publishable.test.ts` pins the fence's DERIVATION by source text —
 * that the call happens, and with which arguments. This file asks the two things
 * a source pin cannot: what the handler DOES, and what it does when a read fails.
 *
 * TWO DEFECTS THIS COVERS, both found by review rather than by these tests:
 *
 *  1. `identity` used to lead with the caller-supplied `title`, so any upload
 *     whose title merely mentioned Reddit was downgraded to a slot-less note —
 *     losing its publish targets and its scheduling slot, permanently, because
 *     nothing in the product can re-type or delete an asset.
 *  2. The job read was `.catch(() => null)`, so a transient failure made a
 *     SERVICE caller indistinguishable from a staff one: `identity` went empty
 *     and only the deliverable's text answered — for the exact actor the fence
 *     exists to constrain.
 */

/**
 * A real batch in the shape `parseRedditDrafts` recognises: the heading it keys
 * on, an `## Account N · …` section, a `###` formula, and the reply as a
 * blockquote. Written out rather than approximated — the first version of this
 * fixture used plausible-looking headings, parsed as nothing, and the two tests
 * that depend on the TEXT half of the fence failed for that reason alone.
 */
const REDDIT_BATCH = [
  "# Reddit answer drafts",
  "",
  "## Account 1 · u/karos_team · r/marketing",
  "",
  "### Someone asked how to pick an agency",
  "",
  "> Here is the reply we would post, in our own voice, from our own account.",
  "",
].join("\n");

const PLAIN_POST = "Three things shipped this quarter, and what they change for you.";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/storage", () => ({ uploadBytes: vi.fn() }));
vi.mock("./auth", () => ({ canStaffAccessClient: vi.fn(() => true) }));
vi.mock("@/lib/mcp/auth", () => ({ canStaffAccessClient: vi.fn(() => true) }));

import * as data from "@/lib/data";
import { MCP_TOOLS } from "@/lib/mcp/tools";

const CLIENT = { id: "c1", name: "Acme", status: "active", createdAt: 0 };

const SERVICE = { kind: "service", clientId: "c1", jobId: "j1" } as any;
const STAFF = {
  kind: "staff",
  user: { uid: "u1", role: "KAROS_ADMIN", clientId: null, createdAt: 0 },
} as any;

const upload = MCP_TOOLS.find((t) => t.name === "upload_asset")!;

/** The type the handler actually wrote, read off the createAsset call. */
function writtenType(): string {
  const calls = vi.mocked(data.createAsset).mock.calls;
  expect(calls.length, "no asset was created").toBeGreaterThan(0);
  return (calls[0]![0] as any).type;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(data.getClient).mockResolvedValue(CLIENT as any);
  vi.mocked(data.createAsset).mockResolvedValue("a-new" as any);
  vi.mocked(data.getJob).mockResolvedValue({
    id: "j1",
    clientId: "c1",
    agentName: "Content agent",
    title: "Weekly social batch",
  } as any);
  vi.mocked(data.getCustomAgent).mockResolvedValue(null as any);
});

describe("a running agent cannot type its own Reddit reply as publishable", () => {
  it("fences it on the agent key, which no caller supplies", async () => {
    vi.mocked(data.getJob).mockResolvedValue({
      id: "j1",
      clientId: "c1",
      agentName: "Content agent",
      title: "Weekly batch",
      customAgentId: "ca-reddit",
    } as any);
    vi.mocked(data.getCustomAgent).mockResolvedValue({
      id: "ca-reddit",
      key: "karos-reddit-agent",
      name: "Reddit agent",
    } as any);

    await upload.handler(
      { clientId: "c1", type: "social_post", title: "Weekly batch", content: PLAIN_POST },
      SERVICE,
    );
    // Asked for social_post; the agent key says Reddit, so it lands draft-only.
    expect(writtenType()).toBe("note");
  });

  it("fences it on the deliverable's own text when there is no agent key", async () => {
    await upload.handler(
      { clientId: "c1", type: "social_post", title: "Weekly batch", content: REDDIT_BATCH },
      SERVICE,
    );
    expect(writtenType()).toBe("note");
  });

  it("still lets an ordinary social post through", async () => {
    await upload.handler(
      { clientId: "c1", type: "social_post", title: "Q3 launch", content: PLAIN_POST },
      SERVICE,
    );
    expect(writtenType()).toBe("social_post");
  });
});

describe("the caller's own title does not steer a fence with no undo", () => {
  /**
   * The regression this file exists for. A wrongly-fenced asset is permanent:
   * `updateAssetAction` cannot change a type and no per-asset delete exists, so
   * an over-match costs the deliverable, not "one staff edit".
   */
  it("does not downgrade a post whose title merely mentions Reddit", async () => {
    await upload.handler(
      {
        clientId: "c1",
        type: "social_post",
        title: "Reddit AMA recap - 5 takeaways",
        content: PLAIN_POST,
      },
      SERVICE,
    );
    expect(writtenType()).toBe("social_post");
  });

  it("does not downgrade a staff upload whose title mentions Reddit either", async () => {
    await upload.handler(
      {
        clientId: "c1",
        type: "social_post",
        title: "Reddit AMA recap - 5 takeaways",
        content: PLAIN_POST,
      },
      STAFF,
    );
    expect(writtenType()).toBe("social_post");
  });

  /** A staff member pasting a real Reddit batch is still fenced, by the text. */
  it("still fences a real Reddit batch pasted by staff", async () => {
    await upload.handler(
      { clientId: "c1", type: "social_post", title: "Replies", content: REDDIT_BATCH },
      STAFF,
    );
    expect(writtenType()).toBe("note");
  });
});

describe("a service caller whose run record cannot be read is refused", () => {
  /**
   * FAIL CLOSED. `.catch(() => null)` made an unreadable job look exactly like a
   * staff caller — no identity at all — for the running agent itself. Refused
   * rather than fenced-to-note, because a refusal is retryable and a wrong type
   * is permanent.
   */
  it("refuses when the job read throws", async () => {
    vi.mocked(data.getJob).mockRejectedValue(new Error("firestore unavailable"));
    await expect(
      upload.handler(
        { clientId: "c1", type: "social_post", title: "Batch", content: PLAIN_POST },
        SERVICE,
      ),
    ).rejects.toThrow(/retry the upload/i);
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  it("refuses when the job is missing, which is the same fail-open", async () => {
    // `getJob` RESOLVES null for a document that is not there, so a fix that only
    // caught the throwing half would have left this one open.
    vi.mocked(data.getJob).mockResolvedValue(null as any);
    await expect(
      upload.handler(
        { clientId: "c1", type: "social_post", title: "Batch", content: PLAIN_POST },
        SERVICE,
      ),
    ).rejects.toThrow(/retry the upload/i);
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  it("says nothing about the run's internals in the refusal", async () => {
    vi.mocked(data.getJob).mockRejectedValue(new Error("firestore: PERMISSION_DENIED on jobs/j1"));
    const err = await upload
      .handler({ clientId: "c1", type: "social_post", title: "B", content: PLAIN_POST }, SERVICE)
      .catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/PERMISSION_DENIED|firestore/i);
  });

  it("a missing CUSTOM AGENT is not a refusal — a catalog run has none", async () => {
    vi.mocked(data.getJob).mockResolvedValue({
      id: "j1",
      clientId: "c1",
      agentName: "Content agent",
      title: "Weekly batch",
      customAgentId: "ca-gone",
    } as any);
    vi.mocked(data.getCustomAgent).mockResolvedValue(null as any);
    await upload.handler(
      { clientId: "c1", type: "social_post", title: "Q3", content: PLAIN_POST },
      SERVICE,
    );
    expect(writtenType()).toBe("social_post");
  });

  it("a staff caller needs no run record at all", async () => {
    vi.mocked(data.getJob).mockRejectedValue(new Error("should never be called"));
    await upload.handler(
      { clientId: "c1", type: "social_post", title: "Q3", content: PLAIN_POST },
      STAFF,
    );
    expect(writtenType()).toBe("social_post");
    expect(data.getJob).not.toHaveBeenCalled();
  });
});
