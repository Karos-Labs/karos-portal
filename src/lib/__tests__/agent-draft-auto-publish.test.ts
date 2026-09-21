import { describe, expect, it } from "vitest";
import {
  agentDraftAutoPublishSuppressesPicker,
  agentDraftAutoPublishTarget,
} from "@/lib/agent-draft-auto-publish";

/**
 * The auto-publish opt-in (ClientIntegration.agentAutoPublish) only ever
 * fires through this function's say-so, so its narrowness IS the safety
 * rail: company-page-only (the client's single shared OAuth credential is
 * one identity, not one per seat), single-post-only ("one run produces one
 * post" is the current rule for both agents, and a multi-draft batch has no
 * single post to choose), and never Reddit (hard product rule, no posting
 * path may ever exist for it).
 */

const LI_COMPANY_SINGLE = `# LinkedIn drafts — Karos Labs

## Account 1 · Karos Labs — Company page
*Brand voice: measured, no hype.*

### Post 1 · Thought-leadership

> Most founders do not need a $250K CMO.

\`40 chars\`

- **Topic:** tl-001
`;

const LI_SEAT_SINGLE = `# LinkedIn drafts — Karos Labs

## Account 1 · Albert Kattan (seat)
*Personal voice.*

### Post 1 · Thought-leadership

> My own take on this.

\`22 chars\`
`;

const LI_TWO_ACCOUNTS = `# LinkedIn drafts — Karos Labs

## Account 1 · Karos Labs — Company page

### Post 1 · Thought-leadership

> Company post.

\`14 chars\`

## Account 2 · Albert Kattan (seat)

### Post 1 · Thought-leadership

> Seat post.

\`11 chars\`
`;

const X_COMPANY_SINGLE = `# Account 1 · Company page @getkaros

## Avenue 1 · Build-in-public

> We shipped the drafts reader today.

\`36 chars\`
`;

const X_COMPANY_THREAD = `# Account 1 · Company page @getkaros

## Avenue 1 · Build-in-public

**1/2**

> Part one.

\`10 chars\`

**2/2**

> Part two.

\`10 chars\`
`;

const X_COMPANY_REPLY = `# Account 1 · Company page @getkaros

## Avenue 1 · News-reaction

> Great point.

\`13 chars\`

- **In reply to:** https://x.com/someone/status/1234567890123456789
`;

const REDDIT_V1 = `# Reddit answer drafts

## Account 1 · Company page

### Reply 1

> A Reddit reply.
`;

describe("agentDraftAutoPublishTarget", () => {
  it("returns the single post for a company-page LinkedIn batch", () => {
    const target = agentDraftAutoPublishTarget({ type: "note", content: LI_COMPANY_SINGLE });
    expect(target).toEqual({
      platform: "linkedin",
      text: "Most founders do not need a $250K CMO.",
    });
  });

  it("returns null for a personal-seat LinkedIn batch (no per-seat credential to post with)", () => {
    expect(agentDraftAutoPublishTarget({ type: "note", content: LI_SEAT_SINGLE })).toBeNull();
  });

  it("returns null for a multi-account LinkedIn batch, even with a company page in it", () => {
    expect(agentDraftAutoPublishTarget({ type: "note", content: LI_TWO_ACCOUNTS })).toBeNull();
  });

  it("returns the single post for a company-page X batch", () => {
    const target = agentDraftAutoPublishTarget({ type: "note", content: X_COMPANY_SINGLE });
    expect(target).toEqual({
      platform: "twitter",
      text: "We shipped the drafts reader today.",
    });
  });

  it("returns null for an X thread (no single-post publish path)", () => {
    expect(agentDraftAutoPublishTarget({ type: "note", content: X_COMPANY_THREAD })).toBeNull();
  });

  it("returns null for an X reply (needs targeting the publisher doesn't do)", () => {
    expect(agentDraftAutoPublishTarget({ type: "note", content: X_COMPANY_REPLY })).toBeNull();
  });

  it("never claims a Reddit batch, even though its heading also starts with '# '", () => {
    expect(agentDraftAutoPublishTarget({ type: "note", content: REDDIT_V1 })).toBeNull();
  });

  it("returns null for a non-note asset type", () => {
    expect(
      agentDraftAutoPublishTarget({ type: "social_post", content: X_COMPANY_SINGLE }),
    ).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(agentDraftAutoPublishTarget({ type: "note", content: "" })).toBeNull();
  });
});

/**
 * The follow-up fix to PR #174: the asset detail modal ALWAYS renders its own
 * generic Approve bar for a draft, independently of whatever the LinkedIn/X
 * drafts reader renders inside it — so with the auto-publish door open, a
 * staff member (or a client; the modal is the only deliverable viewer they
 * can reach) clicking BOTH "Pick & post" and "Approve" posted the same
 * content twice. This is the ONE place that decision is made — it must fire
 * only when BOTH the flag is on for the right platform AND the draft itself
 * is the narrow shape the door actually targets.
 */
describe("agentDraftAutoPublishSuppressesPicker", () => {
  it("suppresses the picker when the platform's flag is on and the draft is eligible", () => {
    expect(
      agentDraftAutoPublishSuppressesPicker({ type: "note", content: LI_COMPANY_SINGLE }, ["linkedin"]),
    ).toBe(true);
    expect(
      agentDraftAutoPublishSuppressesPicker({ type: "note", content: X_COMPANY_SINGLE }, ["twitter"]),
    ).toBe(true);
  });

  it("keeps the picker when no platform has the flag on", () => {
    expect(
      agentDraftAutoPublishSuppressesPicker({ type: "note", content: LI_COMPANY_SINGLE }, undefined),
    ).toBe(false);
    expect(
      agentDraftAutoPublishSuppressesPicker({ type: "note", content: LI_COMPANY_SINGLE }, []),
    ).toBe(false);
  });

  it("keeps the picker when the flag is on for a DIFFERENT platform than this draft targets", () => {
    // A LinkedIn batch with only X's flag on - the wrong door is open, so this
    // one stays manual.
    expect(
      agentDraftAutoPublishSuppressesPicker({ type: "note", content: LI_COMPANY_SINGLE }, ["twitter"]),
    ).toBe(false);
  });

  it("keeps the picker for every shape agentDraftAutoPublishTarget itself refuses, flag or no flag", () => {
    // Personal seat, multi-account batch, X thread, X reply, Reddit — none of
    // these has a single post to auto-publish, so the flag being on changes
    // nothing: agentDraftAutoPublishTarget returning null is what stops it.
    for (const content of [LI_SEAT_SINGLE, LI_TWO_ACCOUNTS, X_COMPANY_THREAD, X_COMPANY_REPLY, REDDIT_V1]) {
      expect(
        agentDraftAutoPublishSuppressesPicker({ type: "note", content }, ["linkedin", "twitter"]),
      ).toBe(false);
    }
  });

  it("keeps the picker for a non-note asset even with every platform flagged on", () => {
    expect(
      agentDraftAutoPublishSuppressesPicker(
        { type: "social_post", content: X_COMPANY_SINGLE },
        ["linkedin", "twitter"],
      ),
    ).toBe(false);
  });
});
