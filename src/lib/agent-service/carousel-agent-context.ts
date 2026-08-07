import "server-only";

/**
 * Carousel v2 run-time context: the client's stored intake and the standing
 * files setup writes, serialized to storage and attached to the run as
 * `context_files`.
 *
 * Same ephemeral-workspace problem as the five families before it: the runner
 * clones the lab repo fresh and the container is destroyed, so anything written
 * under `clients/<slug>/skills/carousel-agent-v2/` is discarded.
 *
 * WHAT IS AT STAKE HERE IS THE TOPIC CATALOGUE. The manifest says a run "flips
 * one topic-catalog.yaml row unused -> used". Lose it and the next press picks a
 * topic already posted — on a channel where a repeat is visible to everyone who
 * follows the client, unlike a repeated newsletter subject a reader may not
 * notice.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * THE TEMPLATES DIRECTORY. Setup writes `templates/`, a folder of slide layouts,
 * and one state row holds one file. It is not injected, so a run re-reads the
 * baked repo's templates rather than a client's customised set — which is
 * correct today, because nothing customises them per client yet. It stops being
 * correct the moment the manager starts APPLYING style changes rather than
 * proposing them, and that is the trigger to build a per-file capture.
 *
 * THE BRAND FILE and CONTENT-FOUNDATION. This product does not write marketing
 * prose; it writes slide copy against `brand-tokens.json` and a style config,
 * both of which are its own. Pulling in the editorial brain would hand a slide
 * designer a keyword-target list.
 */

import { randomUUID } from "crypto";
import { getAgentIntake, listCarouselAgentState } from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { AgentIntake, CarouselAgentState } from "@/lib/types";
import {
  CAROUSEL_MANAGER_KEY,
  CAROUSEL_RUNNER_KEY,
  CAROUSEL_SETUP_KEY,
} from "@/lib/custom-agent-launch";

/**
 * Every carousel v2 skill. The runner is the agent; setup and manager are its
 * steps and are hidden from rosters by `parentKey`.
 *
 * All three are fed the same context, and setup is the reason it is worth
 * saying: setup CREATES these files, so on a re-run it needs to see what already
 * exists rather than re-seeding a catalogue whose rows record what has shipped.
 */
export function isCarouselAgent(agentKey: string): boolean {
  return (
    agentKey === CAROUSEL_RUNNER_KEY ||
    agentKey === CAROUSEL_SETUP_KEY ||
    agentKey === CAROUSEL_MANAGER_KEY
  );
}

/** The SETUP skill specifically — the only one that runs before state exists. */
export function isCarouselSetupV2(agentKey: string): boolean {
  return agentKey === CAROUSEL_SETUP_KEY;
}

/**
 * Whether the client's carousel intake is saved.
 *
 * Gated on the company row exactly like the other five families, and for the
 * same deliberate portal policy: saving the form with empty answers satisfies
 * it, because the run dialog renders the form inline and pressing Run the first
 * time IS the form. A carousel is posted from the company account, so
 * `seatId: null` is the only shape.
 */
export function hasCarouselAgentIntake(clientId: string): Promise<boolean> {
  return getAgentIntake(clientId, "carousel", null).then((row) => row !== null);
}

/**
 * Whether this client has been through setup, i.e. whether a run has anything to
 * build from.
 *
 * ASKED OF THE STYLE CONFIG, and the choice matters. Of the files setup writes,
 * this is the one every slide obeys: without it the renderer has no visual
 * system and would produce slides on no brand at all. The topic catalogue is a
 * close second, but a set-up client whose catalogue is momentarily exhausted is
 * a HELD run with a clear message, not an unconfigured one — two different
 * states that deserve two different answers.
 */
export async function hasCarouselV2Setup(clientId: string): Promise<boolean> {
  const state = await listCarouselAgentState(clientId);
  return state.some((row) => row.kind === "style-config" && row.content.trim().length > 0);
}

/* ─────────────────── how each state file is re-attached ─────────────────── */

const STATE_FILES: Record<
  CarouselAgentState["kind"],
  { name: string; contentType: string; description: string }
> = {
  "style-config": {
    name: "02-style-config.json",
    contentType: "application/json",
    description:
      "THE VISUAL SYSTEM every slide obeys, settled at setup and the portal's copy is the live one. Layout, type scale, spacing, how a slide is composed. Do not improvise around it: a carousel whose slides do not match each other is worse than one that is plain. The manager PROPOSES changes to this file and never applies one, so if it disagrees with a proposal, this file wins.",
  },
  "brand-tokens": {
    name: "brand-tokens.json",
    contentType: "application/json",
    description:
      "The client's colours and type, as the templates read them. Every colour on a slide comes from here; never hardcode one. A value missing from this file is a reason to stop and say so, not a reason to pick something close.",
  },
  "topic-catalog": {
    name: "topic-catalog.yaml",
    contentType: "text/yaml",
    description:
      "THE CONTINUITY FILE, and the portal's copy is the live one. Every topic with its status. Take the next UNUSED row, and flip it to used before you finish. An exhausted catalogue is a HELD run with that reason named, never an invented topic: a row carries provenance and a guess does not. Deliver the whole updated file back — losing it means posting a topic this client has already posted, in public.",
  },
  "catalog-state": {
    name: "03-catalog-state.yaml",
    contentType: "text/yaml",
    description:
      "The previous run's own view of the catalogue, kept for continuity checks. Read topic-catalog.yaml for what is actually unused; this is a snapshot beside it, not the authority.",
  },
};

/* ────────────────────────── the client's own answers ────────────────────── */

function intakeMd(intake: AgentIntake | null): string {
  const lines: string[] = [
    "# Carousel agent - the portal's live client data",
    "",
    "SOURCE OF TRUTH for what the CLIENT told us. It overrides any older copy in",
    "the baked repo on any disagreement.",
    "",
    "The visual style, the brand tokens, the slide templates and the topic",
    "catalogue are all BUILT by setup from the client's own brand material. They",
    "are never collected from the client and must never be asked of them. What is",
    "here is only what setup could not derive.",
    "",
  ];
  if (!intake) {
    lines.push("## No intake stored yet", "- The client has not filled the carousel form.");
    return lines.join("\n");
  }

  lines.push("## The account these are for");
  lines.push(
    intake.carouselHandle?.trim()
      ? `- ${intake.carouselHandle.trim()}\n\n  For labelling and for how a caption signs off. NOT a connection: nothing in\n  this run reads that account, and there is no credential for it.`
      : "- Not stated. Do not guess a handle into a caption.",
  );

  lines.push("", "## How long a post should run");
  // A number the client CAN set but usually should not. Absent is the better
  // answer and the run should be told so, rather than reading silence as zero.
  lines.push(
    typeof intake.slideCountPreference === "number"
      ? `- The client asked for ${intake.slideCountPreference} slides.\n\n  Honour it unless the topic genuinely cannot carry that many, and say so in\n  about.txt if you depart from it.`
      : "- NOT SET, which is the default and the better one: pick the number the topic\n  needs. Absent is not zero.",
  );

  lines.push("", "## Never build a carousel about");
  const banned = (intake.bannedTopics ?? []).map((t) => t.trim()).filter(Boolean);
  lines.push(
    banned.length > 0
      ? `${banned.map((t) => `  - ${t}`).join("\n")}\n\n  Applies to a catalogue row as much as to a request. A topic already in the\n  catalogue that matches one of these is skipped, and you say so.`
      : "- No client-specific banned subjects on file. The house rules still apply in full.",
  );

  lines.push(
    "",
    "## Publishing",
    "- WE RENDER, A PERSON POSTS. This run holds no Instagram credential and has no",
    "  posting path. Slides land as PNGs for a human to upload; if the portal ever",
    "  auto-publishes one it does so from an APPROVED asset on its own side, which",
    "  is nothing this run can reach or should describe.",
  );
  return lines.join("\n");
}

async function upload(
  clientId: string,
  runKey: string,
  name: string,
  body: string,
  contentType: string,
) {
  const { url } = await uploadBytes({
    bytes: Buffer.from(body, "utf8"),
    path: `clients/${clientId}/carousel-agent/portal-context/${runKey}/${name}`,
    contentType,
  });
  return url;
}

/**
 * Build the carousel agent's portal-data context files for one run. Returns []
 * when there is nothing at all to say, so callers can append unconditionally.
 *
 * SETUP GETS THE STATE TOO, which is not an oversight. Setup is re-runnable, and
 * a re-run must VERIFY rather than re-seed — above all it must not re-seed a
 * topic catalogue whose rows record what has already been posted.
 */
export async function buildCarouselAgentContextFiles(
  clientId: string,
  agentName?: string,
): Promise<AgentServiceContextFile[]> {
  const [intake, state] = await Promise.all([
    getAgentIntake(clientId, "carousel", null),
    listCarouselAgentState(clientId),
  ]);
  if (!intake && state.length === 0) return [];

  const files: AgentServiceContextFile[] = [];
  const runKey = randomUUID();

  files.push({
    name: "carousel-portal-intake.md",
    url: await upload(
      clientId,
      runKey,
      "carousel-portal-intake.md",
      intakeMd(intake),
      "text/markdown",
    ),
    content_type: "text/markdown",
    description:
      "The portal's live carousel intake: the account the slides are for, how long the client wants a post to run, and the subjects never to build one about. Overrides older copies in the repo.",
  });

  for (const row of state) {
    const spec = STATE_FILES[row.kind];
    if (!spec || !row.content.trim()) continue;
    files.push({
      name: spec.name,
      url: await upload(clientId, runKey, spec.name, row.content, spec.contentType),
      content_type: spec.contentType,
      description: `${spec.description} (Portal copy, captured ${row.contentDate} from run ${row.capturedFromJobId}, version ${row.version}.)`,
    });
  }

  // Named so the run cannot mistake absence for emptiness. An absent STYLE
  // CONFIG means setup has not run; an absent CATALOGUE on a styled client means
  // setup ran but seeded nothing, which is a different failure and needs a
  // different sentence.
  if (agentName && !state.some((r) => r.kind === "style-config")) {
    files.push({
      name: "carousel-state-absent.md",
      url: await upload(
        clientId,
        runKey,
        "carousel-state-absent.md",
        [
          "# No carousel state has been captured for this client yet",
          "",
          "There is no style config, so SETUP HAS NOT RUN (or its output was never",
          "captured). There is no visual system to build against.",
          "",
          "Do not improvise a look from the brand material directly. Slides built",
          "on a guessed style do not match the ones built after setup, and the",
          "mismatch is permanent on a public grid. Report blocked_intake naming",
          "the missing setup.",
        ].join("\n"),
        "text/markdown",
      ),
      content_type: "text/markdown",
      description:
        "Marks that no style config exists yet - setup has not run. Do not improvise a visual system; slides built on a guess will not match the ones built after setup.",
    });
  } else if (agentName && !state.some((r) => r.kind === "topic-catalog")) {
    files.push({
      name: "carousel-catalog-absent.md",
      url: await upload(
        clientId,
        runKey,
        "carousel-catalog-absent.md",
        [
          "# No topic catalogue",
          "",
          "This client has a style config, so setup ran, but no topic catalogue was",
          "captured. That is NOT the same as an exhausted catalogue.",
          "",
          "Do not invent a topic. If the client named one in this run's brief, build",
          "that and start a catalogue from it. Otherwise HALT saying the catalogue",
          "is missing and setup should be re-run to seed it.",
        ].join("\n"),
        "text/markdown",
      ),
      content_type: "text/markdown",
      description:
        "Marks a styled client with NO topic catalogue - different from an exhausted one. Do not invent a topic; use the brief's if there is one, else HALT.",
    });
  }

  return files;
}
