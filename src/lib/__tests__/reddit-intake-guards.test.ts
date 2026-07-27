import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Reddit account form's `upsertAgentIntake` MERGES, so the action deletes
 * fields the client cleared. Deciding what "cleared" means is where a silent
 * data loss hid: keying the two subreddit-list fields on their PARSED length
 * turned an answer we failed to parse into a delete, and the off-limits list is
 * binding — losing it lets the next run draft for a subreddit the client was
 * banned in, with a success message and the typed text still on screen.
 *
 * The action writes through Firestore, so this pins the contract at the source
 * level, the same way agent-intake-gate.test.ts pins the refusal copy.
 */
const ACTION = "src/lib/actions/reddit-agent-actions.ts";

function source(): string {
  return readFileSync(join(process.cwd(), ACTION), "utf8");
}

describe("Reddit intake clear-on-blank", () => {
  it("keys every field's delete on the RAW input, never on a parse result", () => {
    const src = source();
    const block = src.match(/const drop: Array<[\s\S]*?await clearAgentIntakeFields/)?.[0];
    expect(block, "could not locate the drop block").toBeDefined();

    // Each of the five conditions tests raw text (or the normalized mode enum),
    // so an unreadable answer can never read as "the client cleared this".
    expect(block).toContain("!input.accountHistory.trim()");
    expect(block).toContain("!subredditsRaw");
    expect(block).toContain("!offLimitsRaw");
    expect(block).toContain("!input.disclosurePosture.trim()");
    expect(block).toContain("!mode");

    // The regression itself: a parsed-length test inside the drop block.
    expect(block).not.toMatch(/subreddits\.length === 0/);
    expect(block).not.toMatch(/offLimitsSubreddits\.length === 0/);
  });

  it("refuses a non-empty subreddit answer it could not read, rather than storing none", () => {
    const src = source();
    // Both guards must sit BEFORE the drop block, or the delete happens anyway.
    const guardAt = src.indexOf("subredditsRaw && subreddits.length === 0");
    const offLimitsGuardAt = src.indexOf("offLimitsRaw && offLimitsSubreddits.length === 0");
    const dropAt = src.indexOf("const drop: Array<");
    expect(guardAt, "no guard for an unreadable subreddit list").toBeGreaterThan(-1);
    expect(offLimitsGuardAt, "no guard for an unreadable off-limits list").toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(dropAt);
    expect(offLimitsGuardAt).toBeLessThan(dropAt);
  });
});
