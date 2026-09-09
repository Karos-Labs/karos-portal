import { describe, expect, it } from "vitest";
import {
  REDDIT_V2_ENVELOPE_KIND,
  isRedditV2Envelope,
  parseRedditDrafts,
  type RedditV2Envelope,
} from "@/lib/reddit-drafts";
import {
  buildRedditV2Envelope,
  isRedditRunRecordArtifact,
  redditOutcomeFrom,
  redditStateDateFor,
  redditStateKindFor,
} from "@/lib/agent-service/reddit-state-capture";
import {
  REDDIT_RUNNER_V2_KEY,
  REDDIT_SETUP_V2_KEY,
  isRedditAgentIdentity,
  isSubAgent,
  isSupersededAgentKey,
  isUnlistedAgent,
} from "@/lib/custom-agent-launch";

/**
 * Reddit v2's own guarantees. Everything here is pure — the envelope assembler,
 * the parser, the state matcher, the key predicates — so none of it needs
 * Firestore or a webhook.
 */

const RUN = "clients/acme/outputs/reddit-agent-v2/2026-08-05-acme_dev-run-1/attempt-1";

describe("the v2 Reddit keys", () => {
  it("carry no -v2 suffix, which is the thing most likely to be got wrong", () => {
    // The natural guess is karos-reddit-runner-v2 / karos-reddit-setup-v2. The
    // manifest puts the generation in the PATH (products/building/reddit-agent-v2/)
    // and leaves the key plain. A wrong key matches nothing, so the agent is never
    // gated, never fed and never hidden — and nothing errors to say so.
    expect(REDDIT_RUNNER_V2_KEY).toBe("karos-reddit-runner");
    expect(REDDIT_SETUP_V2_KEY).toBe("karos-reddit-setup");
  });

  it("keeps v1 in the FAMILY but off every roster", () => {
    // Family = what gets gated and fed; a run of the fallback still needs its
    // intake. Unlisted = what gets offered. The two are different questions.
    expect(isRedditAgentIdentity("karos-reddit-agent")).toBe(true);
    expect(isSupersededAgentKey("karos-reddit-agent")).toBe(true);
    expect(isUnlistedAgent({ key: "karos-reddit-agent" })).toBe(true);
    // v1 is not a STEP of anything — it was replaced, not absorbed. Giving it a
    // parentKey to hide it would misdescribe what it is.
    expect(isSubAgent({ key: "karos-reddit-agent" })).toBe(false);
  });

  it("leaves the v2 runner listable and the setup hidden by its parentKey", () => {
    expect(isUnlistedAgent({ key: REDDIT_RUNNER_V2_KEY })).toBe(false);
    expect(
      isUnlistedAgent({ key: REDDIT_SETUP_V2_KEY, parentKey: REDDIT_RUNNER_V2_KEY }),
    ).toBe(true);
    // And the parent is the RUNNER, never v1: parenting a new step to a retired
    // agent would nest it under something being taken off the roster.
    expect(isSubAgent({ key: REDDIT_SETUP_V2_KEY, parentKey: REDDIT_RUNNER_V2_KEY })).toBe(true);
  });
});

describe("assembling the run's folders into one envelope", () => {
  const files = [
    {
      path: `${RUN}/client/01-answer/approach-1.md`,
      text: "The short answer is yes, and here is why.",
    },
    { path: `${RUN}/client/01-answer/approach-2.md`, text: "I ran into this last year." },
    {
      path: `${RUN}/client/01-answer/about.txt`,
      text: [
        "- **Thread:** [How do you handle onboarding?](https://www.reddit.com/r/SaaS/comments/abc/how/)",
        "- **Subreddit:** r/SaaS — value-only, no vendor pitches in comments",
        "- **Thread posted:** 4 hours ago, still active",
        "- **Why this thread:** nobody has answered the actual question",
        "- **Why this is safe here:** answering without naming the product",
        "- **Recommended:** approach 2",
      ].join("\n"),
    },
    { path: `${RUN}/client/02-answer/approach-1.md`, text: "Second thread reply." },
    {
      path: `${RUN}/client/02-answer/about.txt`,
      text: "- **Thread:** https://www.reddit.com/r/devops/comments/xyz/q/\nREWRITE REQUIRED: this subreddit bans AI-written comments\n- **Karma:** account is below the 100 karma this subreddit needs",
    },
  ];

  it("groups by thread folder and keeps the two approaches in order", () => {
    const env = buildRedditV2Envelope({ files, outcome: "delivered" });
    expect(env.kind).toBe(REDDIT_V2_ENVELOPE_KIND);
    expect(env.threads).toHaveLength(2);
    expect(env.threads[0].folder).toBe("01-answer");
    expect(env.threads[0].approaches.map((a) => a.id)).toEqual(["approach-1", "approach-2"]);
    expect(env.threads[0].approaches[1].text).toBe("I ran into this last year.");
    // A thread with only one approach is still a thread.
    expect(env.threads[1].approaches).toHaveLength(1);
  });

  it("reads the about.txt fields the client's safety depends on", () => {
    const env = buildRedditV2Envelope({ files, outcome: "delivered" });
    const [first, second] = env.threads;
    expect(first.threadUrl).toBe("https://www.reddit.com/r/SaaS/comments/abc/how/");
    expect(first.subreddit).toBe("r/SaaS");
    expect(first.verdict).toBe("value-only");
    expect(first.whySafe).toBe("answering without naming the product");
    expect(first.recommended).toBe("approach-2");
    // The two warnings whose absence risks the ACCOUNT, not the comment.
    expect(second.rewriteRequired).toBe(true);
    expect(second.karmaWarning).toContain("100 karma");
    expect(first.rewriteRequired).toBeUndefined();
  });

  it("sorts thread folders numerically, so 10 comes after 2", () => {
    const many = [2, 10, 1].flatMap((n) => [
      { path: `${RUN}/client/${String(n).padStart(2, "0")}-answer/approach-1.md`, text: `reply ${n}` },
    ]);
    const env = buildRedditV2Envelope({ files: many, outcome: "delivered" });
    expect(env.threads.map((t) => t.folder)).toEqual(["01-answer", "02-answer", "10-answer"]);
  });

  it("takes the outcome as given and never infers it from an empty folder set", () => {
    // The whole point. An empty thread list means EITHER "nothing was worth your
    // account's name" OR "we could not read Reddit at all" — and guessing would
    // eventually blame a client's niche for our own outage.
    expect(buildRedditV2Envelope({ files: [], outcome: "degraded" }).outcome).toBe("degraded");
    expect(buildRedditV2Envelope({ files: [], outcome: "held" }).outcome).toBe("held");
    expect(buildRedditV2Envelope({ files: [], outcome: "blocked_intake" }).outcome).toBe(
      "blocked_intake",
    );
  });
});

describe("reading the run's own outcome record", () => {
  it("takes the four outcomes and nothing else", () => {
    for (const o of ["delivered", "held", "blocked_intake", "degraded"]) {
      expect(redditOutcomeFrom(JSON.stringify({ outcome: o })).outcome).toBe(o);
    }
    expect(redditOutcomeFrom(JSON.stringify({ outcome: "exploded" })).outcome).toBeNull();
    expect(redditOutcomeFrom("not json").outcome).toBeNull();
    expect(redditOutcomeFrom("{}").outcome).toBeNull();
  });

  it("carries the considered count and the reason when the run gave them", () => {
    const read = redditOutcomeFrom(
      JSON.stringify({ outcome: "held", considered_count: 4, outcome_reason: "all four were stale" }),
    );
    expect(read.consideredCount).toBe(4);
    expect(read.outcomeNote).toBe("all four were stale");
  });

  it("recognises the run record but never a pinned copy of one", () => {
    expect(isRedditRunRecordArtifact(`${RUN}/internal/13-commit.json`)).toBe(true);
    expect(isRedditRunRecordArtifact(`${RUN}/internal/02-inputs/13-commit.json`)).toBe(false);
  });
});

describe("which artifacts are durable state", () => {
  it("recognises the client-wide files, the rules audit above all", () => {
    const cases: Array<[string, string]> = [
      ["clients/acme/skills/reddit-agent-v2/rules-audit.json", "rules-audit"],
      ["clients/acme/skills/reddit-agent-v2/reddit-ledger.json", "ledger"],
      ["clients/acme/skills/reddit-agent-v2/question-pools.json", "question-pools"],
      ["clients/acme/skills/reddit-agent-v2/scan-config.json", "scan-config"],
      ["clients/acme/skills/reddit-agent-v2/foundation.md", "foundation"],
    ];
    for (const [path, kind] of cases) {
      const hit = redditStateKindFor(path);
      expect(hit?.kind, path).toBe(kind);
      expect(hit?.account, path).toBeNull();
    }
  });

  it("keeps a per-account file attached to ITS account", () => {
    // One account's earned voice rules steering another account's replies is
    // exactly the "does not sound like me" the learning log exists to prevent.
    const log = redditStateKindFor(
      "clients/acme/skills/reddit-agent-v2/accounts/acme_dev/learning-log.md",
    );
    expect(log).toEqual({ kind: "learning-log", account: "acme_dev" });
    const mem = redditStateKindFor(
      "clients/acme/skills/reddit-agent-v2/accounts/other_acct/agent-memory.md",
    );
    expect(mem).toEqual({ kind: "agent-memory", account: "other_acct" });
  });

  it("never captures a run's PINNED COPY as the new state", () => {
    // Step 02 photocopies the inputs. Capturing one writes the PRE-run state back
    // over the POST-run state — silently reverting the ledger append and, far
    // worse, a rules row this run just re-verified. Nothing would show.
    expect(redditStateKindFor(`${RUN}/internal/02-inputs/rules-audit.json`)).toBeNull();
    expect(redditStateKindFor(`${RUN}/internal/02-pinned/reddit-ledger.json`)).toBeNull();
  });

  it("dates the research cache from its own folder, not the delivery clock", () => {
    // A scan costs ten to fifteen minutes of paced requests and is reused only if
    // it is from TODAY, so a date taken from a webhook retried past midnight either
    // re-buys the scan or reuses yesterday's as today's.
    const pastMidnight = new Date("2026-08-06T00:03:00Z").getTime();
    expect(
      redditStateDateFor(
        "clients/acme/skills/_shared/reddit-research-cache/2026-08-05/candidates.json",
        pastMidnight,
      ),
    ).toBe("2026-08-05");
    expect(redditStateDateFor("clients/acme/skills/reddit-agent-v2/foundation.md", pastMidnight)).toBe(
      "2026-08-06",
    );
  });

  it("ignores the client-facing deliverable", () => {
    for (const p of [`${RUN}/client/01-answer/approach-1.md`, `${RUN}/client/01-answer/about.txt`]) {
      expect(redditStateKindFor(p), p).toBeNull();
    }
  });
});

describe("the reader's end of the contract", () => {
  const envelope = (over: Partial<RedditV2Envelope> = {}): string =>
    JSON.stringify({
      kind: REDDIT_V2_ENVELOPE_KIND,
      outcome: "delivered",
      account: "u/acme-dev",
      mode: "warming",
      threads: [
        {
          folder: "01-answer",
          threadUrl: "https://www.reddit.com/r/SaaS/comments/abc/how/",
          subreddit: "r/SaaS",
          verdict: "value-only",
          approaches: [
            { id: "approach-1", text: "First way of answering." },
            { id: "approach-2", text: "Second way of answering." },
          ],
        },
      ],
      ...over,
    } satisfies RedditV2Envelope);

  it("sniffs an envelope without parsing the whole thing", () => {
    expect(isRedditV2Envelope(envelope())).toBe(true);
    expect(isRedditV2Envelope("# Reddit answer drafts\n\n## Account 1 · x")).toBe(false);
    expect(isRedditV2Envelope("")).toBe(false);
  });

  it("round-trips: what the webhook assembles is what the reader renders", () => {
    // The one test that would have caught a drift between the two sides, which is
    // the failure this shared module exists to prevent.
    const built = buildRedditV2Envelope({
      files: [
        { path: `${RUN}/client/01-answer/approach-1.md`, text: "One." },
        { path: `${RUN}/client/01-answer/approach-2.md`, text: "Two." },
        { path: `${RUN}/client/01-answer/about.txt`, text: "- **Subreddit:** r/SaaS — value-only" },
      ],
      outcome: "delivered",
      account: "u/acme-dev",
    });
    const batch = parseRedditDrafts(JSON.stringify(built));
    expect(batch?.outcome).toBe("delivered");
    const draft = batch?.accounts[0]?.drafts[0];
    expect(draft?.approaches?.map((a) => a.text)).toEqual(["One.", "Two."]);
    // `text` holds the first approach so every pre-existing render path still works.
    expect(draft?.text).toBe("One.");
    expect(draft?.subreddit).toBe("r/SaaS");
  });

  it("surfaces degraded EVEN WITH NO THREADS, so the UI can say the right thing", () => {
    const batch = parseRedditDrafts(envelope({ outcome: "degraded", threads: [] }));
    expect(batch).not.toBeNull();
    expect(batch?.outcome).toBe("degraded");
    expect(batch?.accounts[0]?.drafts).toEqual([]);
  });

  it("distinguishes held from degraded, which is the whole reason for the field", () => {
    expect(parseRedditDrafts(envelope({ outcome: "held", threads: [] }))?.outcome).toBe("held");
    expect(parseRedditDrafts(envelope({ outcome: "degraded", threads: [] }))?.outcome).toBe(
      "degraded",
    );
  });

  it("still reads a v1 markdown batch out of the archive", () => {
    // The spec said to abandon DRAFTS.md, and nothing WRITES it any more. But
    // assets already in a client's archive hold it, and dropping the path would
    // render every one of them as plain text with the pick and skip actions gone.
    const v1 = [
      "# Reddit answer drafts — Acme",
      "## Account 1 · Acme (u/acme-dev) · warming",
      "### Draft 1 · Thorough value",
      "- **Thread:** [Q](https://www.reddit.com/r/SaaS/comments/abc/q/)",
      "- **Subreddit:** r/SaaS — value-only",
      "> The v1 reply body.",
      "`120 chars`",
    ].join("\n");
    const batch = parseRedditDrafts(v1);
    expect(batch?.accounts[0]?.drafts[0]?.text).toBe("The v1 reply body.");
    // No outcome on a v1 batch — it had no such record, and inventing one would
    // make the UI claim a state the run never reported.
    expect(batch?.outcome).toBeUndefined();
    expect(batch?.accounts[0]?.drafts[0]?.approaches).toBeUndefined();
  });

  it("falls back rather than blanking a deliverable on a malformed envelope", () => {
    expect(parseRedditDrafts('{"kind":"reddit-drafts-v2","threads":')).toBeNull();
    expect(parseRedditDrafts('{"kind":"reddit-drafts-v2","threads":{}}')).toBeNull();
  });
});
