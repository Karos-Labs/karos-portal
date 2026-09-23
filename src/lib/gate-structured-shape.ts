/**
 * Which of four shapes a gate payload value has — the pure half of
 * `GateStructuredValue`, so the decision can be tested without rendering.
 *
 * The gate renderer is generic by design: a payload key nobody anticipated
 * still has to reach the reviewer's screen. What it may not do is put that key
 * on screen as `JSON.stringify(value, null, 2)` in an 11px block and call it
 * shown — which is what it did for every non-scalar value, to the person
 * deciding whether a client's post goes out.
 *
 * So this names the shapes that actually occur and lets everything else keep
 * the JSON block. The three were taken from the payloads in the repo's own
 * gate fixtures, not guessed:
 *
 *   `strings`  sources, hashtags, flags, reasons
 *   `records`  slides, recommendations, competitors
 *   `record`   scores, counts, a small object of scalars
 *
 * Anything mixed, anything deeper than the caller's cap, and anything this has
 * not met keeps `json`. Readable-for-most beats unreadable-for-all, and
 * inventing a render for a shape nobody has seen is how a reviewer gets a
 * confident screen that is subtly wrong.
 */

export type StructuredShape =
  | { kind: "scalar"; value: string | number | boolean }
  | { kind: "strings"; items: string[] }
  | { kind: "records"; items: Array<Record<string, unknown>> }
  | { kind: "record"; entries: Array<[string, unknown]> }
  | { kind: "json"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** `null` and `undefined` are dropped rather than printed — "null" tells a reviewer nothing. */
function meaningfulEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(record).filter(([, v]) => v !== null && v !== undefined);
}

export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A cycle, a BigInt, anything else JSON refuses. The reviewer still gets
    // something rather than a blank block.
    return String(value);
  }
}

export function structuredShape(value: unknown, depth: number, maxDepth: number): StructuredShape {
  if (isScalar(value)) return { kind: "scalar", value };
  if (value === null || value === undefined) return { kind: "json", text: jsonText(value) };

  // The cap is checked BEFORE the shape, so a deep value is never half-rendered
  // — a reviewer reading two levels of a four-level object would be reading a
  // truncation nothing told them about.
  if (depth >= maxDepth) return { kind: "json", text: jsonText(value) };

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "json", text: jsonText(value) };
    if (value.every(isScalar)) return { kind: "strings", items: value.map(String) };
    // Every element, not most: a list of five objects and one string is a shape
    // this has not met, and guessing which one the odd element is would be
    // exactly the confident-and-wrong screen.
    if (value.every(isRecord)) return { kind: "records", items: value };
    return { kind: "json", text: jsonText(value) };
  }

  if (isRecord(value)) {
    const entries = meaningfulEntries(value);
    if (entries.length === 0) return { kind: "json", text: jsonText(value) };
    return { kind: "record", entries };
  }

  return { kind: "json", text: jsonText(value) };
}

/** `slideTemplates` → `Slide templates`. The same transform the gate's fact rows use. */
export function labelForGateKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}
