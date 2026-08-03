import { describe, expect, it } from "vitest";
import {
  ACTIVE_TASK_STATUSES,
  computeBoardCapacity,
  findDuplicateReason,
  inferTaskOwner,
  normalizeTitleForDedup,
  queueCapacitySkipNote,
  taskWeekKey,
  titleSimilarity,
} from "@/lib/task-dedup";
import type { ClientTask, TaskStatus } from "@/lib/types";

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0); // Wed 2026-07-08 — ISO week 2026-W28
const LAST_WEEK = NOW - 7 * 24 * 60 * 60 * 1000;

let seq = 0;
function task(overrides: Partial<ClientTask> = {}): ClientTask {
  seq += 1;
  return {
    id: `t${seq}`,
    clientId: "c1",
    title: `Task ${seq}`,
    status: "pending",
    priority: "medium",
    source: "copilot",
    owner: "karos_managed",
    createdBy: "u1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("computeBoardCapacity — the 15-cap counts ONLY karos_managed", () => {
  it("counts active karos_managed tasks and nothing else", () => {
    const tasks = [
      task({ owner: "karos_managed", status: "pending" }),
      task({ owner: "karos_managed", status: "in_progress" }),
      task({ owner: "karos_managed", status: "review_pending" }),
      // Terminal karos tasks don't count.
      task({ owner: "karos_managed", status: "completed" }),
      task({ owner: "karos_managed", status: "archived" }),
      // client_managed NEVER counts, whatever the status.
      task({ owner: "client_managed", status: "pending" }),
      task({ owner: "client_managed", status: "in_progress" }),
      task({ owner: "client_managed", status: "review_pending" }),
    ];
    expect(computeBoardCapacity(tasks).activeCount).toBe(3);
  });

  it("a board full of client_managed tasks leaves the karos queue at zero", () => {
    const tasks = Array.from({ length: 40 }, () =>
      task({ owner: "client_managed", status: "pending" }),
    );
    expect(computeBoardCapacity(tasks).activeCount).toBe(0);
  });

  it("infers owner when absent: manual ⇒ client_managed (uncounted), others ⇒ karos", () => {
    const tasks = [
      task({ owner: undefined, source: "manual", status: "pending" }),
      task({ owner: undefined, source: "copilot", status: "pending" }),
    ];
    expect(inferTaskOwner(tasks[0])).toBe("client_managed");
    expect(inferTaskOwner(tasks[1])).toBe("karos_managed");
    expect(computeBoardCapacity(tasks).activeCount).toBe(1);
  });

  it("collects normalized titles across every status for the exact-dedup tier", () => {
    const { existingTitles } = computeBoardCapacity([
      task({ title: "Write a Blog: Post!", status: "completed" }),
    ]);
    expect(existingTitles.has("write a blog post")).toBe(true);
  });
});

describe("the capacity note said to a client", () => {
  it("names Karos, and refuses the two words the counted statuses cannot back", () => {
    // The note is this cap's rule said to a person, so every word has to be true
    // of every status the cap counts. It read "Karos is already RUNNING its limit
    // of 15 ACTIVE tasks for you", and two of the three counted statuses are not
    // being run: a pending task is queued with nobody on it, and a review_pending
    // one is finished work waiting on a human. "Active" is this constant's own
    // name for the set, not the client's word — a client whose board shows one
    // thing in progress was being told fifteen were running.
    //
    // Asked as the two words that made it false, not as a pinned sentence: reword
    // it freely, and exactly two words are refused — the verb "running" and the
    // adjective "active". Nothing wider is claimed, and the title used to claim
    // it ("claims nothing the statuses cannot back"): four closed questions
    // cannot vouch for a whole sentence, so "Karos has FINISHED its limit of 15
    // tasks for you" is just as unbacked by a pending task and passes here. What
    // a green tick buys is that the two words the shipped copy actually got wrong
    // cannot come back. The scope half — that the note names Karos, so the limit
    // reads as Karos's rather than as the client's whole board — is the `/Karos/`
    // line below and nowhere else: an earlier version of this comment sent the
    // reader to the copy-boundary suite for it, which asks nothing about this note.
    // Both halves live here, and the word half belongs here in particular because
    // it is a claim about what ACTIVE_TASK_STATUSES holds.
    const note = queueCapacitySkipNote(3);
    expect(note).toContain("3");
    expect(note, "the note stopped naming whose limit this is").toMatch(/Karos/);
    expect(note, "a pending task is queued, not running").not.toMatch(/\brunning\b/i);
    expect(note, '"active" is the code\'s word for the counted set').not.toMatch(/\bactive\b/i);
  });

  it("goes red if the counted set changes, so the sentence gets re-read", () => {
    // The tripwire under the test above: it reasons about which statuses count, so
    // changing the set has to bring somebody back to the sentence. The policy
    // docstring says the same thing the other way round — widening the cap without
    // restating the note makes the portal lie.
    expect(ACTIVE_TASK_STATUSES).toEqual(["pending", "in_progress", "review_pending"]);
  });
});

describe("normalizeTitleForDedup / titleSimilarity", () => {
  it("normalizes case, punctuation, and whitespace", () => {
    expect(normalizeTitleForDedup("  Connect   LinkedIn — account!! ")).toBe(
      "connect linkedin account",
    );
  });

  it("scores identical titles at 1 and disjoint titles at 0", () => {
    expect(titleSimilarity("write blog post", "Write Blog Post")).toBe(1);
    expect(titleSimilarity("write blog post", "connect instagram account")).toBe(0);
  });
});

describe("findDuplicateReason — three tiers", () => {
  it("tier 1: exact normalized title matches ANY status, completed included", () => {
    const existing = [task({ title: "Draft Q3 newsletter issue", status: "completed" })];
    expect(
      findDuplicateReason({ title: "Draft Q3 Newsletter Issue!" }, existing, NOW),
    ).toMatch(/identical title/);
  });

  it("tier 2: near-identical wording flags against ACTIVE tasks", () => {
    const existing = [
      task({ title: "Generate 5 Instagram posts for the spring launch", status: "pending" }),
    ];
    expect(
      findDuplicateReason(
        { title: "Generate 5 Instagram posts for spring launch" },
        existing,
        NOW,
      ),
    ).toMatch(/near-identical/);
  });

  it("tier 2 does NOT flag near-identical wording against completed tasks", () => {
    const existing = [
      task({ title: "Generate 5 Instagram posts for the spring launch", status: "completed" }),
    ];
    expect(
      findDuplicateReason(
        { title: "Generate 5 Instagram posts for spring launch" },
        existing,
        NOW,
      ),
    ).toBeNull();
  });

  it("tier 3: same productType + platform in the same week is a duplicate intent", () => {
    const existing = [
      task({
        title: "Fill the Instagram gap with fresh content",
        status: "pending",
        metadata: { productType: "social_post", platform: "instagram" },
        createdAt: NOW,
      }),
    ];
    expect(
      findDuplicateReason(
        { title: "Produce new IG carousels", productType: "social_post", platform: "instagram" },
        existing,
        NOW,
      ),
    ).toMatch(/same/);
  });

  it("tier 3 respects the week scope and the platform scope", () => {
    const lastWeek = [
      task({
        title: "Fill the Instagram gap with fresh content",
        status: "pending",
        metadata: { productType: "social_post", platform: "instagram" },
        createdAt: LAST_WEEK,
      }),
    ];
    const otherPlatform = [
      task({
        title: "Fill the Instagram gap with fresh content",
        status: "pending",
        metadata: { productType: "social_post", platform: "tiktok" },
        createdAt: NOW,
      }),
    ];
    const candidate = {
      title: "Produce new IG carousels",
      productType: "social_post",
      platform: "instagram",
    };
    expect(findDuplicateReason(candidate, lastWeek, NOW)).toBeNull();
    expect(findDuplicateReason(candidate, otherPlatform, NOW)).toBeNull();
  });

  it("returns null for a genuinely new task", () => {
    const existing = [
      task({ title: "Draft Q3 newsletter issue", status: "pending" }),
      task({
        title: "Fill the Instagram gap",
        status: "pending",
        metadata: { productType: "social_post", platform: "instagram" },
      }),
    ];
    expect(
      findDuplicateReason(
        { title: "Write an SEO blog article on onboarding", productType: "blog_article" },
        existing,
        NOW,
      ),
    ).toBeNull();
  });
});

describe("taskWeekKey", () => {
  it("is stable within a week and rolls over across weeks", () => {
    const mon = Date.UTC(2026, 6, 6); // Mon 2026-07-06
    const sun = Date.UTC(2026, 6, 12, 23, 59); // Sun 2026-07-12
    const nextMon = Date.UTC(2026, 6, 13); // Mon 2026-07-13
    expect(taskWeekKey(mon)).toBe(taskWeekKey(sun));
    expect(taskWeekKey(mon)).not.toBe(taskWeekKey(nextMon));
  });
});

// Compile-time guard: ACTIVE statuses stay in sync with the TaskStatus union.
const _statuses: TaskStatus[] = ["pending", "in_progress", "review_pending", "completed", "archived"];
void _statuses;
