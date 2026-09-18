import { describe, expect, it } from "vitest";
import type { Client } from "@/lib/types";
import { isTopicApprovalMode, topicApprovalForRun } from "../agent-engine/topic-approval";

const IG = "instagram-agent";
const client = (topicApproval?: Client["topicApproval"]) => ({ topicApproval }) as Pick<Client, "topicApproval">;

/**
 * G3 / D18: "a manual run means the client picks the topic first; a calendar run
 * is autopilot, because the client is not there. It is a switch, defaulting to
 * auto on calendar-linked runs."
 */
describe("topicApprovalForRun", () => {
  describe("the default, which is what every client gets", () => {
    it("pauses a manual run", () => {
      expect(topicApprovalForRun(client(), IG, "manual")).toEqual({ approveTopicFirst: true });
    });

    it("does not pause a calendar fire — nobody is there to answer", () => {
      expect(topicApprovalForRun(client(), IG, "scheduled")).toEqual({});
    });

    it("treats an absent runType as manual, not as scheduled", () => {
      // `scheduled` is stamped by the cron and by nothing else. Anything that
      // arrives without a run type came from a person, and the failure that
      // matters is generating visuals nobody asked for — not one extra pause.
      expect(topicApprovalForRun(client(), IG, undefined)).toEqual({ approveTopicFirst: true });
    });

    it("reads an explicit \"default\" the same as an absent one", () => {
      expect(topicApprovalForRun(client("default"), IG, "scheduled")).toEqual({});
      expect(topicApprovalForRun(client("default"), IG, "manual")).toEqual({ approveTopicFirst: true });
    });
  });

  describe("the switch", () => {
    it("always: pauses even a calendar fire", () => {
      expect(topicApprovalForRun(client("always"), IG, "scheduled")).toEqual({ approveTopicFirst: true });
    });

    it("never: skips the pause even on a manual run", () => {
      expect(topicApprovalForRun(client("never"), IG, "manual")).toEqual({});
    });

    it("ignores a stored value that is not one of the three, falling back to the default", () => {
      // Matches `agentBand`: an unrecognised word cannot be acted on, and
      // letting it suppress a gate the decisions log asked for is the worst of
      // the three readings.
      expect(topicApprovalForRun({ topicApproval: "yes please" } as never, IG, "manual")).toEqual({ approveTopicFirst: true });
    });
  });

  describe("which products carry a topic gate", () => {
    it("sends nothing for a product with no topic pause point", () => {
      // The engine's pause exists in instagram-agent. Sending the field to a
      // product that cannot honour it would be a flag nothing reads.
      expect(topicApprovalForRun(client("always"), "x-agent", "manual")).toEqual({});
      expect(topicApprovalForRun(client("always"), "seo-geo-agent-v2", "manual")).toEqual({});
    });

    it("sends nothing when there is no product id at all", () => {
      expect(topicApprovalForRun(client("always"), undefined, "manual")).toEqual({});
    });
  });

  /**
   * The wire convention, asserted rather than assumed: `slotStage` and this
   * field both state only the non-default, so an engine that receives nothing
   * has one reading instead of two.
   */
  it("never sends approveTopicFirst: false", () => {
    for (const mode of ["default", "always", "never"] as const) {
      for (const runType of ["manual", "scheduled", undefined] as const) {
        const out = topicApprovalForRun(client(mode), IG, runType);
        expect(Object.hasOwn(out, "approveTopicFirst") ? out.approveTopicFirst : true).toBe(true);
      }
    }
  });
});

describe("isTopicApprovalMode", () => {
  it("accepts the three words and nothing else", () => {
    expect(["default", "always", "never"].every(isTopicApprovalMode)).toBe(true);
    for (const junk of ["", "DEFAULT", "auto", "true", true, 1, null, undefined, {}]) {
      expect(isTopicApprovalMode(junk)).toBe(false);
    }
  });
});
