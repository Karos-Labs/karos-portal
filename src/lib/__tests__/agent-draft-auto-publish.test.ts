import { describe, expect, it } from "vitest";
import {
  agentDraftAutoPublishTarget,
  agentDraftManualPublishTarget,
} from "@/lib/agent-draft-auto-publish";

/**
 * `agentDraftAutoPublishTarget` backs BOTH publish doors a LinkedIn/X agent
 * draft can go out through today — the automatic one
 * (`ClientIntegration.agentAutoPublish`) and the manual one
 * (`publishAgentDraftNowAction`, the draft's own Publish Now button) — so
 * its narrowness IS the safety rail for both: company-page-only (the
 * client's single shared OAuth credential is one identity, not one per
 * seat), single-post-only ("one run produces one post" is the current rule
 * for both agents, and a multi-draft batch has no single post to choose),
 * and never Reddit (hard product rule, no posting path may ever exist for
 * it).
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
  it("returns the single post for a company-page LinkedIn batch, with the account title and draftRef a caller needs to log feedback", () => {
    const target = agentDraftAutoPublishTarget({ type: "note", content: LI_COMPANY_SINGLE });
    expect(target).toEqual({
      platform: "linkedin",
      text: "Most founders do not need a $250K CMO.",
      accountTitle: "Karos Labs — Company page",
      draftRef: "Karos Labs — Company page · Post 1 · Thought-leadership",
    });
  });

  it("returns null for a personal-seat LinkedIn batch (no per-seat credential to post with)", () => {
    expect(agentDraftAutoPublishTarget({ type: "note", content: LI_SEAT_SINGLE })).toBeNull();
  });

  it("returns null for a multi-account LinkedIn batch, even with a company page in it", () => {
    expect(agentDraftAutoPublishTarget({ type: "note", content: LI_TWO_ACCOUNTS })).toBeNull();
  });

  it("returns the single post for a company-page X batch, with accountTitle/draftRef", () => {
    const target = agentDraftAutoPublishTarget({ type: "note", content: X_COMPANY_SINGLE });
    expect(target).toEqual({
      platform: "twitter",
      text: "We shipped the drafts reader today.",
      accountTitle: "Company page @getkaros",
      draftRef: "Company page @getkaros · Avenue 1 · Build-in-public",
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
 * The host's Publish Now button (asset-card.tsx / asset-detail-modal.tsx)
 * asks THIS, never `ClientIntegration.agentAutoPublish` — button visibility
 * is technical eligibility (a recognised single-post target) PLUS a
 * connected, usable integration for its platform, full stop. The flag only
 * decides whether Approve fires the publish immediately; it must never hide
 * or show this button (product ruling, 2026-09-21 — see the flag's own doc
 * comment in lib/types.ts).
 */
describe("agentDraftManualPublishTarget", () => {
  it("returns the target when the platform has a connected integration — flag never asked", () => {
    expect(
      agentDraftManualPublishTarget({ type: "note", content: LI_COMPANY_SINGLE }, ["linkedin"]),
    ).not.toBeNull();
    expect(
      agentDraftManualPublishTarget({ type: "note", content: X_COMPANY_SINGLE }, ["twitter"]),
    ).not.toBeNull();
  });

  it("returns null when no platform is connected", () => {
    expect(
      agentDraftManualPublishTarget({ type: "note", content: LI_COMPANY_SINGLE }, undefined),
    ).toBeNull();
    expect(
      agentDraftManualPublishTarget({ type: "note", content: LI_COMPANY_SINGLE }, []),
    ).toBeNull();
  });

  it("returns null when the connected platform is the WRONG one for this draft", () => {
    // A LinkedIn batch with only X connected - the wrong door, so no button.
    expect(
      agentDraftManualPublishTarget({ type: "note", content: LI_COMPANY_SINGLE }, ["twitter"]),
    ).toBeNull();
  });

  it("returns null for every shape agentDraftAutoPublishTarget itself refuses, connected or not", () => {
    // Personal seat, multi-account batch, X thread, X reply, Reddit — none of
    // these has a single post to publish, so being connected changes nothing.
    for (const content of [LI_SEAT_SINGLE, LI_TWO_ACCOUNTS, X_COMPANY_THREAD, X_COMPANY_REPLY, REDDIT_V1]) {
      expect(
        agentDraftManualPublishTarget({ type: "note", content }, ["linkedin", "twitter"]),
      ).toBeNull();
    }
  });

  it("returns null for a non-note asset even with every platform connected", () => {
    expect(
      agentDraftManualPublishTarget(
        { type: "social_post", content: X_COMPANY_SINGLE },
        ["linkedin", "twitter"],
      ),
    ).toBeNull();
  });
});
