import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The row pulls `rosterRowVerb` from `client-agent-rows`, which is `server-only`
// for its data reads. The verb itself is pure; the same stub every other suite
// in this directory uses lets the component render under node.
vi.mock("server-only", () => ({}));

const { ClientAgentRosterRow } = await import("@/components/client-agents/roster-row");
const { rosterStatus } = await import("@/lib/client-agents");

/**
 * D09's band, as the client's roster row actually paints it (SCRUM-497).
 *
 * The band is a fact about the PRODUCT and the status word is a fact about this
 * client's use of it, so the two have to be able to coexist on one row: a beta
 * agent that is producing every day must read "Live" AND "Beta". The failure
 * this file exists to catch is the other shape — a second badge that contradicts
 * the first, which is what "Live · Coming soon" on one card would have been.
 */
type RowProps = Parameters<typeof ClientAgentRosterRow>[0];

/** A live agent's row, with whatever this case is actually about overlaid. */
const row = (over: Partial<RowProps>) => {
  const props: RowProps = {
    href: "/clients/c1/agents/a1",
    identity: "karos-tiktok-content-design TikTok content design",
    displayName: "TikTok content design",
    blurb: "Give it nothing.",
    status: rosterStatus({ launchState: "live" }),
    now: 1_757_000_000_000,
    ...over,
  };
  return renderToStaticMarkup(<ClientAgentRosterRow {...props} />);
};

describe("the band badge", () => {
  it("paints Beta beside a live agent, without touching its status word", () => {
    const html = row({ band: "beta" });
    expect(html).toContain("Beta");
    // The status word is untouched: a beta agent that is producing is Live, and
    // saying otherwise would disown the work in the client's Workspace.
    expect(html).toContain("Live");
    // Still a link with its chevron — beta does not take a row's controls away.
    expect(html).toContain('href="/clients/c1/agents/a1"');
    expect(html).toContain("lucide-chevron-right");
  });

  it("paints nothing for up_and_running, which the status word already says", () => {
    const html = row({ band: "up_and_running" });
    expect(html).toContain("Live");
    // No second badge: "Up and running" beside "Live" is the same sentence twice.
    expect(html).not.toMatch(/[Uu]p and running/);
  });

  it("paints nothing for an agent nobody banded", () => {
    expect(row({ band: null })).toContain("Live");
  });

  it("renders coming_soon through the word rather than beside it", () => {
    // `rosterStatus` has already spent the band on the status word by the time
    // the row sees it, so the row must not add a badge saying the same thing.
    //
    // Counted against the PAUSED row rather than against 1: the row paints its
    // badge block twice, once in each breakpoint slot (`@4xl:hidden` under the
    // name, `hidden @4xl:flex` in the column), so the honest question is whether
    // the band added an occurrence — not how many there are.
    const banded = row({
      status: rosterStatus({ launchState: "live", band: "coming_soon" }),
      band: "coming_soon",
    });
    const paused = row({ status: rosterStatus({ launchState: null, enabled: false }) });
    expect(banded.match(/Coming Soon/g)?.length).toBe(paused.match(/Coming Soon/g)?.length);
    expect(banded).not.toContain("Live");
    // Non-interactive, exactly as a paused agent's row is: no link, no chevron.
    expect(banded).not.toContain('href="/clients/c1/agents/a1"');
    expect(banded).toContain('aria-disabled="true"');
  });

  it("uses the neutral tone, never the accent", () => {
    // Tones are the judgment scale only (success / warning / info / neutral),
    // and orange never signals status — the rule the green `tone="neon"` Beta
    // badge on the old Reporting bubble broke.
    //
    // Sliced from the badge's OWN opening tag: a fixed-width window before the
    // word reaches back into the status badge beside it, whose `bg-success` and
    // `animate-pulse-neon` are correct there and would fail this check.
    const html = row({ band: "beta" });
    const at = html.indexOf(">Beta<");
    expect(at, "no Beta badge rendered").toBeGreaterThan(-1);
    const badge = html.slice(html.lastIndexOf("<span", at), at);
    expect(badge).toContain("text-muted");
    expect(badge).not.toContain("neon");
    expect(badge).not.toContain("bg-success");
  });

  it("sits beside the staff Not granted badge rather than replacing it", () => {
    const html = row({ band: "beta", notGranted: true });
    expect(html).toContain("Beta");
    expect(html).toContain("Not granted");
  });
});
