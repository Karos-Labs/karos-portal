import { describe, expect, it } from "vitest";
import { agentDraftAutoPublishTarget } from "@/lib/agent-draft-auto-publish";

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
