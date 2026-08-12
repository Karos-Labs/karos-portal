import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_MODEL_ALIASES } from "../../../src/task-types.js";
import { sdkEnv } from "../sdk-options.js";

/**
 * Topic guardrails — the verification pass (docs/dynamic-agent-guardrails.md).
 *
 * One extra model call, made by the ENGINE after the admin's pipeline has
 * produced a deliverable: it receives the finished text and the client's
 * forbidden topics, and names any topic the output actually engages with.
 *
 * // DECISION: this is the "hard step at the end" the feature asks for, and it
 * lives here rather than in `spec.steps` for the same reason the injection
 * does — a step in the spec is admin-deletable, and a check an admin can
 * remove with a bin icon is a convention rather than a guarantee. It is
 * appended by the runner, so no Studio edit reaches it.
 *
 * // DECISION: haiku. This is classification against a fixed list, which is
 * what the house model-routing rule puts on haiku, and it keeps the added cost
 * of having guardrails on at all close to zero.
 *
 * // DECISION: fail open, loudly. Any failure — the call throwing, the model
 * refusing, unparseable JSON — returns `status: "error"`, never
 * `status: "violation"`. A verifier that cannot do its job must not manufacture
 * findings against good output; the error is surfaced instead, so staff know
 * the check did not run rather than seeing a green tick it did not earn.
 */

export interface GuardrailVerification {
  status: "clean" | "violation" | "error";
  violatedTopics: string[];
  evidence?: string;
  model?: string;
  durationMs: number;
}

/** Bounded so a long deliverable cannot push the topic list out of the verifier's attention. */
const MAX_OUTPUT_CHARS = 24_000;
const MAX_EVIDENCE_CHARS = 300;

function buildPrompt(deliverable: string, forbiddenTopics: string[]): string {
  const list = forbiddenTopics.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `You are a compliance checker. Below is a list of topics a company does not engage with, and a draft produced for that company. Decide whether the draft actually engages with any listed topic.

Engaging means: writing about it, recommending it, speculating about it, or taking a position on it. A passing mention that explicitly declines to cover the topic is NOT engaging with it, and neither is a word that merely resembles a listed topic in a different sense.

TOPICS THIS COMPANY DOES NOT ENGAGE WITH:
${list}

DRAFT:
"""
${deliverable.slice(0, MAX_OUTPUT_CHARS)}
"""

Reply with ONLY a JSON object, no prose before or after, in exactly this shape:
{"violations": [{"topic": "<the listed topic, copied verbatim>", "evidence": "<a short quote from the draft>"}]}

Return {"violations": []} when the draft engages with none of them. Be strict about what counts as engaging, and do not invent a violation to seem thorough.`;
}

/**
 * Pulls the JSON object out of the model's reply.
 *
 * Tolerant of a fenced code block or a stray sentence around the object,
 * because "reply with only JSON" is a request rather than a guarantee — but
 * NOT tolerant of ambiguity: anything it cannot parse into the expected shape
 * returns null, and the caller reports that as `error` rather than guessing.
 */
export function parseVerificationJson(
  text: string,
): { violations: Array<{ topic: string; evidence?: string }> } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const violations = (parsed as { violations?: unknown }).violations;
  if (!Array.isArray(violations)) return null;

  const out: Array<{ topic: string; evidence?: string }> = [];
  for (const entry of violations) {
    if (typeof entry !== "object" || entry === null) continue;
    const topic = (entry as { topic?: unknown }).topic;
    if (typeof topic !== "string" || !topic.trim()) continue;
    const evidence = (entry as { evidence?: unknown }).evidence;
    out.push({
      topic: topic.trim(),
      ...(typeof evidence === "string" && evidence.trim()
        ? { evidence: evidence.trim().slice(0, MAX_EVIDENCE_CHARS) }
        : {}),
    });
  }
  return { violations: out };
}

/**
 * Keeps only violations naming a topic that was actually on the list.
 *
 * A model that invents a topic, or paraphrases one, would otherwise put a
 * finding in front of staff that they cannot trace back to a rule they wrote.
 * Matched case-insensitively and returned in the LIST's spelling, so the
 * report reads back exactly what was configured.
 */
export function reconcileTopics(
  claimed: Array<{ topic: string; evidence?: string }>,
  forbiddenTopics: string[],
): Array<{ topic: string; evidence?: string }> {
  const byLower = new Map(forbiddenTopics.map((t) => [t.toLowerCase(), t]));
  const seen = new Set<string>();
  const out: Array<{ topic: string; evidence?: string }> = [];
  for (const entry of claimed) {
    const canonical = byLower.get(entry.topic.toLowerCase());
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ topic: canonical, ...(entry.evidence ? { evidence: entry.evidence } : {}) });
  }
  return out;
}

export interface VerifyDeps {
  /** Injected so tests can drive the pass without the SDK. Defaults to the real single-turn query. */
  runVerification?: (prompt: string, model: string) => Promise<string>;
  onTranscriptMessage?: (message: unknown) => void;
  now?: () => number;
}

/** The real SDK call: same single-turn, no-tools, no-workspace shape a dynamic AI step uses. */
async function defaultRunVerification(
  prompt: string,
  model: string,
  onTranscriptMessage?: (message: unknown) => void,
): Promise<string> {
  let text = "";
  const q = query({
    prompt,
    options: {
      model,
      maxTurns: 1,
      permissionMode: "dontAsk",
      allowedTools: [],
      settingSources: [],
      env: sdkEnv(),
    },
  });
  for await (const message of q) {
    onTranscriptMessage?.(message);
    const typed = message as { type?: string; message?: { content?: Array<{ type: string; text?: string }> } };
    if (typed.type === "assistant" && typed.message?.content) {
      for (const block of typed.message.content) {
        if (block.type === "text" && typeof block.text === "string") text += block.text;
      }
    }
  }
  return text;
}

/**
 * Verifies a finished deliverable against the client's forbidden topics.
 *
 * Never throws: every failure path is folded into `status: "error"`, because
 * this runs after the run has already produced its deliverable and must not be
 * able to turn a successful run into a failed one.
 */
export async function verifyForbiddenTopics(
  deliverable: string,
  forbiddenTopics: string[],
  deps: VerifyDeps = {},
): Promise<GuardrailVerification> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const model = AGENT_MODEL_ALIASES.haiku;
  const finish = (v: Omit<GuardrailVerification, "durationMs" | "model">): GuardrailVerification => ({
    ...v,
    model,
    durationMs: now() - startedAt,
  });

  if (!deliverable.trim()) {
    // Nothing to check. Not "clean" — a clean verdict on an empty deliverable
    // would be a green tick the run never earned.
    return finish({ status: "error", violatedTopics: [] });
  }

  try {
    const run = deps.runVerification
      ? deps.runVerification
      : (p: string, m: string) => defaultRunVerification(p, m, deps.onTranscriptMessage);
    const reply = await run(buildPrompt(deliverable, forbiddenTopics), model);
    const parsed = parseVerificationJson(reply);
    if (!parsed) return finish({ status: "error", violatedTopics: [] });

    if (parsed.violations.length === 0) return finish({ status: "clean", violatedTopics: [] });

    const reconciled = reconcileTopics(parsed.violations, forbiddenTopics);
    if (reconciled.length === 0) {
      // The model claimed at least one violation, but none of them matched a
      // topic on the client's own list (a paraphrase, or a hallucinated
      // topic) — this is NOT the same as a genuinely clean draft. Reporting
      // "clean" here would silently ship a deliverable the model itself
      // flagged; "error" preserves the fail-open invariant above by telling
      // staff the check could not be trusted, rather than manufacturing a
      // green tick it did not earn.
      return finish({ status: "error", violatedTopics: [] });
    }

    const evidence = reconciled.find((r) => r.evidence)?.evidence;
    return finish({
      status: "violation",
      violatedTopics: reconciled.map((r) => r.topic),
      ...(evidence ? { evidence } : {}),
    });
  } catch {
    return finish({ status: "error", violatedTopics: [] });
  }
}
