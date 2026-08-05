import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LINKEDIN_IDENTITY_FIELD_KEY,
  BATCH_SIZE_FIELD_KEY,
  agentKeyMatchesClientSlug,
  isInternalAgentIdentity,
  isLinkedInAgentIdentity,
  listableAgentKeys,
  launchProfileFor,
  linkedInSeatIdentityToken,
  perClientAgentSlug,
  withLinkedInIdentityOptions,
} from "@/lib/custom-agent-launch";
import {
  coveredDirectionRequests,
  isLiCommitArtifact,
  liStateDateFor,
  liStateKindFor,
} from "@/lib/agent-service/linkedin-state-capture";
import { parseLiDrafts } from "@/lib/li-drafts";

/**
 * The LinkedIn v2 hookup's own guarantees. Everything here is pure — the state
 * capture, the launch profiles, the parser, the key predicates — so none of it
 * needs Firestore; the server module (`linkedin-agent-context.ts`) is asserted
 * through its source where a value has to agree with this side of the RSC
 * boundary.
 */

const WRITER = "karos-linkedin-writer-v2";
const SETUP = "karos-linkedin-setup-v2";
const MANAGER = "karos-linkedin-manager-v2";

describe("the v2 agent keys", () => {
  it("are all recognised as LinkedIn agents, and so is the e10 generation", () => {
    for (const key of [WRITER, SETUP, MANAGER]) {
      expect(isLinkedInAgentIdentity(key), key).toBe(true);
    }
    // The fallback stays recognised: it is disabled, not deleted, and a run of it
    // must still be gated and fed.
    expect(isLinkedInAgentIdentity("karos-linkedin-company-karoslabs")).toBe(true);
    expect(isLinkedInAgentIdentity("karos-linkedin-agent")).toBe(true);
    expect(isLinkedInAgentIdentity("karos-x-agent-v2")).toBe(false);
  });

  it("keeps the client-safe twin in step with the server predicate", () => {
    // The two live on opposite sides of the RSC boundary (one is `server-only`),
    // so they cannot import each other. If they disagree, a card offers a brief
    // whose data the server never attaches — or the reverse.
    const src = readFileSync(
      join(process.cwd(), "src/lib/agent-service/linkedin-agent-context.ts"),
      "utf8",
    );
    for (const key of [WRITER, SETUP, MANAGER]) {
      expect(src, `the server predicate does not know ${key}`).toContain(`"${key}"`);
    }
  });

  it("is bound to NO client, which is the whole point of the v2 rebuild", () => {
    // v1 emitted a company-page skill per client, so a fix had to be hand-applied
    // to every copy. v2 has one generic writer, so the keys carry no slug and the
    // per-client binding must not claim them — a v2 key that read as bound would
    // be offered to exactly one client and hidden from every other.
    for (const key of [WRITER, SETUP, MANAGER]) {
      expect(perClientAgentSlug(key), key).toBeNull();
      expect(agentKeyMatchesClientSlug(key, "hankypanky")).toBe(true);
      expect(agentKeyMatchesClientSlug(key, null)).toBe(true);
    }
    // While the e10 instance stays bound to its own client.
    expect(perClientAgentSlug("karos-linkedin-company-karoslabs")).toBe("karoslabs");
    expect(agentKeyMatchesClientSlug("karos-linkedin-company-karoslabs", "hankypanky")).toBe(false);
  });
});

describe("the LinkedIn agent is ONE agent on the portal", () => {
  it("treats the setup and the manager as another agent's machinery", () => {
    // Running a lab skill needs a customAgents doc, because that doc carries
    // entrySkillDir. That is a runtime requirement and not a claim that the skill
    // is a product — conflating the two put three cards on the agents page for
    // what is one agent to a client.
    expect(isInternalAgentIdentity(SETUP)).toBe(true);
    expect(isInternalAgentIdentity(MANAGER)).toBe(true);
    // The writer IS the agent, so it is never hidden.
    expect(isInternalAgentIdentity(WRITER)).toBe(false);
    for (const key of ["karos-x-agent-v2", "karos-reddit-agent", "karos-linkedin-company-karoslabs"]) {
      expect(isInternalAgentIdentity(key), key).toBe(false);
    }
  });

  it("leaves exactly one LinkedIn agent listable", () => {
    const roster = [
      { key: SETUP },
      { key: WRITER },
      { key: MANAGER },
      { key: "karos-x-agent-v2" },
    ];
    expect(listableAgentKeys(roster).map((a) => a.key)).toEqual([WRITER, "karos-x-agent-v2"]);
  });

  it("is filtered on every surface that lists agents, staff included", () => {
    // The manager is quiet BY CONSTRUCTION — the writer's instructions run its
    // pass before drafting — so a card for it offers a run nobody would choose.
    // Asked of the sources because these are server components and route
    // handlers: a fifth roster added later has to opt in here or it ships the
    // regression this test was written for.
    const SURFACES = [
      "src/app/(app)/clients/[id]/agents/page.tsx",
      "src/app/(app)/dashboard/page.tsx",
      "src/app/api/clients/[id]/agents/mentionable/route.ts",
      // The intake page's own agent resolution: the LinkedIn family has three
      // docs and only one is the agent a person means.
      "src/lib/agent-intake-views.ts",
    ];
    for (const file of SURFACES) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src, `${file} lists agents without filtering the internal ones`).toContain(
        "isInternalAgentIdentity",
      );
    }
  });

  it("does NOT hide them by un-granting, which would break the runs", () => {
    // A client-fired run is refused unless the agent is granted
    // (isCustomAgentGrantedToClient in the submit core), and the LinkedIn agent's
    // own surface fires setup on the client's behalf. So the grant stays and the
    // LISTING goes — the two were never the same question, and the enable script
    // grants all three on purpose.
    const script = readFileSync(
      join(process.cwd(), "scripts/enable-linkedin-v2-prep.ts"),
      "utf8",
    );
    for (const key of [SETUP, WRITER, MANAGER]) {
      expect(script, `${key} is not granted by the enable script`).toContain(key);
    }
  });
});

describe("the writer's brief", () => {
  const profile = launchProfileFor({ key: WRITER, name: "LinkedIn agent" });

  it("asks which identity to post as, and defaults to one post", () => {
    const identity = profile.fields.find((f) => f.key === LINKEDIN_IDENTITY_FIELD_KEY);
    expect(identity, "no identity field on the writer's brief").toBeDefined();
    expect(identity?.defaultValue).toBe("company");
    // The product default is ONE post per run (Daniel, 2026-08-04: "it's one post
    // per time"). The selector exists because the lab contract says the portal MAY
    // raise it, not because a bigger default was wanted.
    const size = profile.fields.find((f) => f.key === BATCH_SIZE_FIELD_KEY);
    expect(size?.defaultValue).toBe("1");
  });

  it("does not claim a native asset in its deliverables", () => {
    // v2 ships text posts. e10's brief promised "one company-page post draft with
    // its native asset (carousel, document, or image)", which after the format
    // relaxation would be a promise the run deliberately does not keep.
    const said = profile.deliverables.join(" ").toLowerCase();
    for (const word of ["carousel", "native asset", "image", "document"]) {
      expect(said, `the writer's deliverables still promise a ${word}`).not.toContain(word);
    }
  });

  it("matches before the loose /linkedin/ brief", () => {
    // A regex on /linkedin/ would otherwise hand the v2 writer the founder-led
    // brief, which asks for an executive and a point of view — inputs v2 BUILDS
    // and must never collect.
    expect(profile.eyebrow).toBe("LinkedIn post");
    expect(launchProfileFor({ key: SETUP, name: "LinkedIn setup" }).eyebrow).toBe("LinkedIn setup");
    expect(launchProfileFor({ key: MANAGER, name: "LinkedIn manager" }).eyebrow).toBe(
      "LinkedIn plan and topics",
    );
  });
});

describe("who is offered as an identity", () => {
  const profile = launchProfileFor({ key: WRITER, name: "LinkedIn agent" });
  const optionsOf = (p: ReturnType<typeof launchProfileFor>) =>
    p.fields.find((f) => f.key === LINKEDIN_IDENTITY_FIELD_KEY)?.options ?? [];

  it("lists the company page plus every seat whose voice is built", () => {
    const withSeats = withLinkedInIdentityOptions(profile, [
      { id: "s1", name: "Albert Kattan", voiceReady: true },
      { id: "s2", name: "Lola Tamman", voiceReady: true },
    ]);
    expect(optionsOf(withSeats)).toEqual([
      { value: "company", label: "The company page" },
      { value: linkedInSeatIdentityToken("s1"), label: "Albert Kattan" },
      { value: linkedInSeatIdentityToken("s2"), label: "Lola Tamman" },
    ]);
  });

  it("leaves a seat with no voice OUT rather than in and disabled", () => {
    // The agent refuses a seat run with no voice card, and so do both submit
    // cores. An option that can only ever refuse is a control that lies; the way
    // to make that person selectable is their own setup, offered on their card.
    const partial = withLinkedInIdentityOptions(profile, [
      { id: "s1", name: "Albert Kattan", voiceReady: true },
      { id: "s2", name: "Not set up yet", voiceReady: false },
      { id: "s3", name: "No flag at all" },
    ]);
    expect(optionsOf(partial).map((o) => o.label)).toEqual(["The company page", "Albert Kattan"]);
  });

  it("leaves a profile with no identity field untouched", () => {
    const other = launchProfileFor({ key: "karos-x-agent-v2", name: "X Agent" });
    expect(withLinkedInIdentityOptions(other, [{ id: "s1", name: "A", voiceReady: true }])).toBe(
      other,
    );
  });
});

describe("which artifacts are durable state", () => {
  it("recognises each contract file", () => {
    const cases: Array<[string, string]> = [
      ["clients/karoslabs/skills/_shared/linkedin-ledger.json", "ledger"],
      ["clients/karoslabs/skills/linkedin-agent-v2/company-page/topic-catalog.yaml", "topic-catalog"],
      ["clients/karoslabs/internal/linkedin-agent/AGENT-MEMORY.md", "agent-memory"],
      ["clients/karoslabs/skills/_shared/LINKEDIN-FOUNDATION.md", "foundation"],
      ["clients/karoslabs/skills/_shared/linkedin-voice-card-company.json", "voice-card-company"],
      [
        "clients/karoslabs/outputs/linkedin-agent-v2/2026-08-04-manager-run-1/attempt-1/internal/05-plan.json",
        "manager-plan",
      ],
      [
        "clients/karoslabs/skills/_shared/linkedin-research-cache/2026-08-04/candidates.json",
        "research-cache",
      ],
    ];
    for (const [path, kind] of cases) {
      expect(liStateKindFor(path), path).toBe(kind);
    }
  });

  it("never captures a run's PINNED COPY of a state file as the new state", () => {
    // Writer step 02 copies everything it will read into internal/02-inputs/ and
    // then reads only those copies. Capturing one would write what the run READ
    // back over what it WROTE — silently reverting the ledger append that run just
    // made, which is the worst failure available here because nothing would show.
    expect(
      liStateKindFor(
        "clients/karoslabs/outputs/linkedin-agent-v2/2026-08-04-company-run-1/attempt-1/internal/02-inputs/linkedin-ledger.json",
      ),
    ).toBeNull();
    expect(
      isLiCommitArtifact(
        "clients/karoslabs/outputs/.../internal/02-inputs/12-commit.json",
      ),
    ).toBe(false);
  });

  it("does not mistake a writer run's 05 step for the manager's plan", () => {
    expect(
      liStateKindFor(
        "clients/karoslabs/outputs/linkedin-agent-v2/2026-08-04-company-run-1/attempt-1/internal/05-slots.json",
      ),
    ).toBeNull();
    // Same number, wrong run kind: the writer has no 05-plan, and a file named
    // like one outside a manager folder is not the standing plan.
    expect(liStateKindFor("outputs/whatever/internal/05-plan.json")).toBeNull();
  });

  it("ignores everything else, including the deliverable", () => {
    for (const path of [
      "clients/karoslabs/outputs/linkedin-agent-v2/2026-08-04-company-run-1/attempt-1/client/DRAFTS.md",
      "clients/karoslabs/outputs/linkedin-agent-v2/2026-08-04-company-run-1/attempt-1/client/01-post/post.md",
      "clients/karoslabs/internal/linkedin-agent/company-updates.md",
      "clients/karoslabs/profile/brand-voice.md",
    ]) {
      expect(liStateKindFor(path), path).toBeNull();
    }
  });

  it("dates the research cache from its own folder, not from the delivery clock", () => {
    // The manager's reuse rule is a comparison against TODAY. Dating a cache by
    // when its webhook landed is wrong exactly when a delivery is retried across
    // midnight, and being wrong here means either re-buying a pull or reusing
    // yesterday's as today's.
    const midnightCrossing = new Date("2026-08-05T00:04:00Z").getTime();
    expect(
      liStateDateFor(
        "clients/karoslabs/skills/_shared/linkedin-research-cache/2026-08-04/candidates.json",
        midnightCrossing,
      ),
    ).toBe("2026-08-04");
    // And falls back to the clock when the path carries no date at all.
    expect(liStateDateFor("clients/karoslabs/skills/_shared/linkedin-ledger.json", midnightCrossing)).toBe(
      "2026-08-05",
    );
  });
});

describe("closing a direction request", () => {
  it("reads the requests a run reported covering", () => {
    expect(
      coveredDirectionRequests(
        JSON.stringify({ direction_requests_covered: ["build up to the launch", " pricing "] }),
      ),
    ).toEqual(["build up to the launch", "pricing"]);
  });

  it("accepts the object shape a model also produces", () => {
    expect(
      coveredDirectionRequests(
        JSON.stringify({
          direction_requests_covered: [{ request: "one" }, { text: "two" }, { nope: "three" }],
        }),
      ),
    ).toEqual(["one", "two"]);
  });

  it("closes NOTHING on junk, an absent field, or unparseable JSON", () => {
    // A row left open is re-offered next run, which is the harmless direction: the
    // client asked for it and gets it again. Closing one they did not get covered
    // loses a standing steer with nothing to show they ever asked.
    for (const input of ["", "not json", "{}", '{"direction_requests_covered":"all of them"}', "[]"]) {
      expect(coveredDirectionRequests(input), input).toEqual([]);
    }
  });
});

describe("the drafts reader", () => {
  const batch = `# LinkedIn drafts — Karos Labs

## Account 1 · Karos Labs — Company page

### Post 1 · Thought leadership

> Agents do the grunt work.
> The craft stays human.

\`412 chars\`

- **Topic:** the pricing-transparency catalog row
- **Suggested date:** 2026-08-05
- **Source:** profile/product-information.md
`;

  it("reads the suggested date the calendar step produced", () => {
    const parsed = parseLiDrafts(batch);
    const draft = parsed?.accounts[0]?.drafts[0];
    expect(draft?.suggestedDate).toBe("2026-08-05");
    expect(draft?.text).toBe("Agents do the grunt work.\nThe craft stays human.");
    expect(draft?.chars).toBe("412 chars");
    // No media is normal now: v2 sources no visual, so an empty list is the
    // expected state rather than a parse failure.
    expect(draft?.mediaNames).toEqual([]);
  });

  it("still parses a batch with no suggested date", () => {
    const parsed = parseLiDrafts(batch.replace("- **Suggested date:** 2026-08-05\n", ""));
    expect(parsed?.accounts[0]?.drafts[0]?.suggestedDate).toBeUndefined();
    expect(parsed?.accounts[0]?.drafts[0]?.text).toContain("Agents do the grunt work.");
  });

  it("still carries a client-supplied asset when there is one", () => {
    // The one case that fills the media list: an asset the CLIENT dropped ships
    // with its post, and a URL cannot carry a file.
    const parsed = parseLiDrafts(
      batch.replace("- **Source:**", "- **Media:** their-chart.png\n- **Source:**"),
    );
    expect(parsed?.accounts[0]?.drafts[0]?.mediaNames).toEqual(["their-chart.png"]);
  });
});

describe("the instructions doc", () => {
  const doc = readFileSync(join(process.cwd(), "docs/linkedin-agent-portal.md"), "utf8");

  it("tells the writer that the combined file IS each identity's voice card", () => {
    // Without this line a seat run looks for linkedin-voice-card-<slug>.json,
    // does not find it, and honestly reports blocked_intake. The one-file layout
    // and this instruction are one change; the doc is where the pairing is stated.
    expect(doc).toContain("ARE those identities' voice cards");
    expect(doc).toContain("do NOT report blocked_intake");
  });

  it("pins the DRAFTS.md structure the parser requires", () => {
    expect(doc).toContain("# LinkedIn drafts — <client name>");
    expect(doc).toContain('the title must contain "Company page"');
    expect(doc).toContain("**Suggested date:**");
  });

  it("names the direction-request receipt the webhook closes rows on", () => {
    expect(doc).toContain("direction_requests_covered");
  });

  it("states that text posts ship and no visual is sourced", () => {
    expect(doc).toContain("text posts ship");
    expect(doc).toContain("Do not source an image");
  });
});
