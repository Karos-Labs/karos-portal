/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * ── EVERY DOOR A POST GOES OUT OF DOES THE SAME THREE THINGS. ──
 *
 * SCRUM-493 / 04 B1. An asset becomes published four ways, and until this file
 * only one of them did the bookkeeping that follows a post:
 *
 *     door                              slot   X option   learning loop
 *     markAssetPostedAction             yes    yes        yes
 *     /api/publish (autopilot cron)     NO     NO         NO
 *     publishAssetNowAction             NO     NO         NO
 *     /api/analytics/sync (reconcile)   yes    NO         NO
 *
 * The learning column is the expensive one. A subject row is written by the
 * engine at draft and moved by the portal at review (that is the whole of the
 * B1 division of labour, and it is written into `config.subject_rows`' own
 * schema comment) — so a post that never reported back left its row `drafted`,
 * with no `posted_at`, for good. And `feedbackForPrompt` puts the last N
 * feedback rows in front of the next draft, so a log that only ever heard about
 * skips and edits told the next run that everything it writes gets changed or
 * dropped. D35 offers autopilot on Instagram, X and TikTok — the three
 * platforms the loop most needs to learn from.
 *
 * Two halves here, and the first is the one that matters in a year: a SOURCE
 * scan, because the defect was never that a limb was wrong. It was that a fifth
 * door could be added and nothing would say it forgot.
 */

describe("every publish door calls `afterAssetPosted`", () => {
  const ROOT = path.resolve(__dirname, "..", "..", "..");

  /** The calls that make an asset published, and the file each one lives in. */
  const DOORS = [
    { file: "src/lib/actions/asset-actions.ts", marks: /reconcileAssetPublished\(|markAssetPublished\(/g },
    { file: "src/app/api/publish/route.ts", marks: /markAssetPublished\(/g },
    { file: "src/app/api/analytics/sync/route.ts", marks: /reconcileAssetPublished\(/g },
  ] as const;

  it.each(DOORS)("$file marks a post live and calls afterAssetPosted", async ({ file, marks }) => {
    const source = await fs.readFile(path.join(ROOT, file), "utf8");
    const marked = source.match(marks) ?? [];
    expect(marked.length, `${file} no longer marks anything published — move this case with the call`).toBeGreaterThan(0);
    // The CALL, not the import: a door that keeps the import and loses the call
    // is exactly the regression this case is for.
    const calls = source.match(/afterAssetPosted\(/g) ?? [];
    expect(
      calls.length,
      `${file} marks an asset published ${marked.length} time(s) and calls afterAssetPosted ${calls.length} time(s). ` +
        `A post that reports nothing leaves its subject row \`drafted\` for good and teaches the next draft that ` +
        `nothing it writes goes out. Call afterAssetPosted(asset) after the asset is live — see src/lib/asset-posted.ts.`,
    ).toBeGreaterThanOrEqual(marked.length);
  });

  it("nothing else in the repo marks a post published behind this file's back", async () => {
    // The scan above only knows the doors that existed when it was written.
    // This one refuses a fifth: any other file calling either function has to
    // be added to DOORS above, in the diff that adds it.
    const known = new Set<string>(DOORS.map((d) => d.file));
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          await walk(rel);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        const source = await fs.readFile(path.join(ROOT, rel), "utf8");
        // The store's own definitions live in data.ts; it is the writer, not a door.
        if (rel === "src/lib/data.ts") continue;
        if (/\b(markAssetPublished|reconcileAssetPublished)\(/.test(source) && !known.has(rel)) found.push(rel);
      }
    };
    await walk("src");
    expect(
      found,
      `these files mark an asset published and are not in this file's DOORS list: ${found.join(", ")}. ` +
        `Add them there and make sure they call afterAssetPosted.`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// What the function itself does.
// ─────────────────────────────────────────────────────────────────────────

const { slotMock, clientMock, feedbackMock, xFeedbackMock } = vi.hoisted(() => ({
  slotMock: vi.fn(),
  clientMock: vi.fn(),
  feedbackMock: vi.fn(),
  xFeedbackMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ getClient: clientMock }));
vi.mock("@/lib/client-agent-slots", () => ({ syncSlotPostedForAsset: slotMock }));
vi.mock("@/lib/actions/x-agent-actions", () => ({ addXDraftFeedbackAction: xFeedbackMock }));
vi.mock("@/lib/agent-engine/learning-feedback", async () => {
  // The target resolver is pure and its rules are pinned by its own suite; only
  // the WRITE is mocked, so a change to what counts as an engine asset is felt
  // here rather than hidden behind a second copy of the rule.
  const real = await vi.importActual<typeof import("@/lib/agent-engine/learning-feedback")>(
    "@/lib/agent-engine/learning-feedback",
  );
  return { ...real, recordLearningFeedback: feedbackMock };
});

import { afterAssetPosted } from "@/lib/asset-posted";

const ENGINE_META = { agentEngineRunId: "run-7", agentEngineProductId: "x-agent" };

function asset(patch: Record<string, any> = {}): any {
  return { id: "a1", clientId: "c1", content: "the post as it went out", meta: { ...ENGINE_META }, ...patch };
}

beforeEach(() => {
  slotMock.mockReset().mockResolvedValue(undefined);
  xFeedbackMock.mockReset().mockResolvedValue(undefined);
  feedbackMock.mockReset().mockResolvedValue(true);
  clientMock.mockReset().mockResolvedValue({ id: "c1", agentsRepoSlug: "acme" });
});

describe("what follows a post", () => {
  it("stamps the slot and records `posted` for an engine draft that went out as written", async () => {
    await afterAssetPosted(asset(), { actor: "sam@karoslabs.com" });

    expect(slotMock).toHaveBeenCalledWith({ clientId: "c1", assetId: "a1" });
    expect(feedbackMock).toHaveBeenCalledTimes(1);
    expect(feedbackMock.mock.calls[0]![2]).toMatchObject({ action: "posted", actor: "sam@karoslabs.com" });
  });

  it("records the EDIT PAIR when the agent's own text was stashed and the content has moved", async () => {
    // The pair is the most valuable row in the log: the client showing, not
    // telling, how the draft fell short. `engineOriginalContent` is stashed by
    // the first edit of an engine draft and read here and nowhere else.
    await afterAssetPosted(asset({ meta: { ...ENGINE_META, engineOriginalContent: "what the agent wrote" } }));

    expect(feedbackMock.mock.calls[0]![2]).toMatchObject({
      action: "posted_with_edits",
      originalText: "what the agent wrote",
      finalText: "the post as it went out",
    });
  });

  it("records plain `posted` when the stash is identical to what went out", async () => {
    // Approving without changing a word stashes nothing and changes nothing;
    // calling that an edit would teach the agent it was rewritten when it was
    // not, which is the opposite of the lesson.
    await afterAssetPosted(asset({ meta: { ...ENGINE_META, engineOriginalContent: "the post as it went out" } }));

    expect(feedbackMock.mock.calls[0]![2]).toMatchObject({ action: "posted" });
  });

  it("writes no learning row for an asset that did not come from an engine run", async () => {
    // A hand-written asset has no run to file against, and inventing one would
    // put a row on somebody else's subject table.
    await afterAssetPosted(asset({ meta: {} }));

    expect(feedbackMock).not.toHaveBeenCalled();
    // The slot is still stamped: a hand-written post still fills its day.
    expect(slotMock).toHaveBeenCalled();
  });

  it("writes the X option row only for an asset that was picked from a batch", async () => {
    await afterAssetPosted(asset());
    expect(xFeedbackMock).not.toHaveBeenCalled();

    await afterAssetPosted(
      asset({ meta: { ...ENGINE_META, optionRef: "opt-3", xAccountTitle: "Acme", edited: true, originalText: "before" } }),
    );
    expect(xFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ draftRef: "opt-3", action: "posted_with_edits", finalText: "the post as it went out", originalText: "before" }),
    );
  });
});

describe("one limb failing costs the others nothing", () => {
  // The post is already live by the time any of this runs. A control plane that
  // is down must not also cost us the slot stamp, and a slot that will not
  // stamp must not cost us the lesson.
  it.each([
    ["the slot stamp", () => slotMock.mockRejectedValue(new Error("firestore unavailable"))],
    ["the X option row", () => xFeedbackMock.mockRejectedValue(new Error("write failed"))],
    ["the learning write", () => feedbackMock.mockRejectedValue(new Error("control plane down"))],
  ])("%s failing does not stop the rest, and does not throw", async (_label, breakIt) => {
    breakIt();
    const picked = asset({ meta: { ...ENGINE_META, optionRef: "opt-3", xAccountTitle: "Acme" } });

    await expect(afterAssetPosted(picked)).resolves.toBeUndefined();

    expect(slotMock).toHaveBeenCalled();
    expect(xFeedbackMock).toHaveBeenCalled();
    expect(feedbackMock).toHaveBeenCalled();
  });
});
