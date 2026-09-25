/**
 * What a run was actually given, printed.
 *
 * The run page used to render `job.input` straight — a `Record<string,string>`
 * written at job creation — and said "No inputs." whenever that map was empty.
 * It was empty for every run dispatched through `dispatchAgentEngineRun`
 * without an `inputSummary`, which is three of its four callers: the control
 * plane's agent card, the research-agent regenerate modal and the
 * recommendation runner all put a real `input` on the wire and left the job
 * doc's own copy at `{}`. So the page reported "No inputs." about runs that
 * carried a direction someone had typed a second earlier. That is the worst
 * kind of wrong: it reads like a finding about the run rather than a gap in
 * the record, and it sent us looking for a dropped field that was never
 * dropped.
 *
 * Two rules follow, and they are the whole of this module:
 *
 * **1. Print the engine's own copy when there is one.** agent-engine persists
 * `input` on `agentEngineRuns/{runId}` (`RunRecordSchema.input`) because a run
 * that pauses at a gate has to resume against the same brief. That record is
 * what the agent actually received — not what we believe we sent — so it is
 * the honest answer to "what went in", and it is the only version that can
 * show a field being dropped in transit, by its absence.
 *
 * **2. Never hide a key.** The previous card filtered out `inputs` and any
 * falsy value, so a dynamic agent's entire payload rendered as nothing. An
 * unknown key here gets a humanised label and prints; that is deliberate, and
 * it is why this file has a fallback rather than a closed allow-list. A wire
 * field added in `product-mapping.ts` tomorrow shows up on this page without
 * anyone remembering to come back here — the failure mode of a list is
 * silence, and silence is exactly what we are fixing.
 */

export interface RunInputRow {
  /** The wire key, so the page can use it as a React key and staff can grep for it. */
  key: string;
  label: string;
  value: string;
}

/**
 * Labels only where the wire key would mislead a reader. Everything else is
 * humanised from the key itself, on purpose — see rule 2 above.
 *
 * `customPrompt` is the clearest case: the key says "prompt", the box in the
 * product says "Direction for this run", and a staff member comparing the two
 * screens should not have to know they are the same thing.
 */
const WIRE_KEY_LABELS: Record<string, string> = {
  customPrompt: "Direction for this run",
  requestedTopic: "Subject",
  requestedMode: "Kind of post",
  requestedFormat: "Format",
  pictureDensity: "Pictures",
  requestedSeries: "Post type",
  requestedLane: "Lane",
  requestedIdentityScope: "Post as",
  requestedExecutiveName: "Executive",
  requestedSubreddit: "Subreddit",
  mediaAssets: "Attachments",
  mediaSource: "Media for this run",
  mustInclude: "Must include",
  targetDate: "Target date",
  runScope: "Run scope",
  runMode: "Run mode",
  cta: "Call to action",
  standingFeedback: "Client's standing feedback",
};

/** `requestedTopic` -> "Requested topic". A last resort, not a style. */
export function humanizeWireKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function labelForWireKey(key: string): string {
  return WIRE_KEY_LABELS[key] ?? humanizeWireKey(key);
}

function isMediaAsset(value: unknown): value is { uri: string; role?: string } {
  return typeof value === "object" && value !== null && typeof (value as { uri?: unknown }).uri === "string";
}

/**
 * One value, as text. Arrays and objects are spelled out rather than shown as
 * `[object Object]` — an attachment list is the field most likely to be wrong
 * and the one a reader most needs to see in full.
 */
export function formatRunInputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => (isMediaAsset(item) ? `${item.role ?? "asset"}: ${item.uri}` : formatRunInputValue(item)))
      .filter((line) => line !== "")
      .join("\n");
  }
  if (isMediaAsset(value)) return `${value.role ?? "asset"}: ${value.uri}`;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * The order a person reads them in: the two fields they typed, then identity
 * and media, then everything else in the order the sender put it. Not
 * alphabetical — "Attachments" before "Direction for this run" would bury the
 * one line that explains the run.
 */
const ROW_ORDER = [
  "customPrompt",
  "requestedTopic",
  "requestedMode",
  "requestedFormat",
  "pictureDensity",
  "requestedSeries",
  "requestedLane",
  "requestedIdentityScope",
  "requestedExecutiveName",
  "requestedSubreddit",
  "mediaSource",
  "mediaAssets",
];

export function toRunInputRows(input: Record<string, unknown> | undefined | null): RunInputRow[] {
  if (!input) return [];
  const rows: RunInputRow[] = [];
  for (const [key, raw] of Object.entries(input)) {
    const value = formatRunInputValue(raw);
    // An empty string is not a value someone supplied: `toEngineRunInput`
    // omits a blank box rather than sending "", so anything empty here is an
    // artefact of a caller that built the object differently.
    if (value.trim() === "") continue;
    rows.push({ key, label: labelForWireKey(key), value });
  }
  return rows.sort((a, b) => {
    const ia = ROW_ORDER.indexOf(a.key);
    const ib = ROW_ORDER.indexOf(b.key);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/**
 * The job doc's own `input`, which is a `Record<string, string>` and carries
 * one value that is really a nested object: the Dynamic Agent Studio path
 * JSON-stringifies its whole brief under `inputs` (`submit-custom.ts`). The
 * old card filtered that key out, so a dynamic agent's run page showed the
 * agent's name and nothing else. Parsed and merged here instead.
 */
export function expandJobInput(input: Record<string, string> | undefined | null): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== "inputs") {
      out[key] = value;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Not JSON after all: show the raw string rather than dropping it.
      out[key] = value;
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(out, parsed as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The job doc's display copy of what went on the wire, for the window before
 * the engine has written its own record — a queued run has no
 * `agentEngineRuns/{runId}` yet, and that window is exactly when someone
 * clicks through to check their direction landed.
 *
 * Values are flattened to strings because `Job.input` is
 * `Record<string, string>`; the engine's own record keeps the real shapes.
 */
export function toJobInputSummary(input: Record<string, unknown> | undefined): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const row of toRunInputRows(input)) summary[row.key] = row.value;
  return summary;
}
