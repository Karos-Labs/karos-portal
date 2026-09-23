import { labelForGateKey, structuredShape } from "@/lib/gate-structured-shape";

/**
 * A gate payload's non-scalar values, rendered so a reviewer can read them.
 *
 * ## What this replaces, and what it must not undo
 *
 * The gate renderer is generic on purpose: eleven products open gates of six
 * `kind`s with six payload shapes, and a per-product lookup table would show
 * the twelfth nothing. That rule is right and stays — a payload key nobody
 * anticipated still reaches the screen.
 *
 * What was wrong is what happened once it got there. Every non-scalar value
 * became `JSON.stringify(value, null, 2)` inside an 11px `<pre>`, so the
 * reviewer deciding whether to publish a client's post was reading braces. The
 * same deliverable then renders completely differently in the asset modal,
 * which paints only mapped fields.
 *
 * So: the shapes that actually occur get a real render, and the fallback stays
 * for the shapes that do not. Nothing is dropped either way.
 *
 * ## The shapes that occur
 *
 * Measured against the payloads in the repo's own gate fixtures rather than
 * guessed: a list of strings (sources, hashtags, flags), a list of objects
 * (slides, recommendations, competitors), and a plain object of scalars
 * (scores, counts). Those three cover everything the products write today.
 * Anything deeper, anything mixed, and anything past `MAX_DEPTH` keeps the
 * JSON block — readable-for-most beats unreadable-for-all, and pretending to
 * render a shape this has never seen is how a reviewer gets a confident,
 * wrong-looking screen.
 */

/** How deep a structured value is rendered before the JSON fallback takes over. */
const MAX_DEPTH = 2;

function ScalarText({ value }: { value: string | number | boolean }) {
  return (
    <span dir="auto" className="whitespace-pre-wrap break-words">
      {String(value)}
    </span>
  );
}

export function GateStructuredValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const shape = structuredShape(value, depth, MAX_DEPTH);

  if (shape.kind === "scalar") return <ScalarText value={shape.value} />;

  if (shape.kind === "strings") {
    return (
      <ul className="m-0 list-disc space-y-1 ps-5 text-xs text-foreground">
        {shape.items.map((item, i) => (
          <li key={i}>
            <ScalarText value={item} />
          </li>
        ))}
      </ul>
    );
  }

  if (shape.kind === "records") {
    return (
      <ol className="m-0 space-y-2 text-xs text-foreground">
        {shape.items.map((item, i) => (
          <li key={i} className="rounded border border-border/50 bg-surface/50 p-2">
            <GateStructuredValue value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }

  if (shape.kind === "record") {
    return (
      <dl className="m-0 space-y-1.5 text-xs">
        {shape.entries.map(([key, entry]) => (
          <div key={key} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-muted">{labelForGateKey(key)}</dt>
            <dd className="m-0 text-foreground">
              <GateStructuredValue value={entry} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  // `json` — deeper than MAX_DEPTH, mixed, or a shape this has not met.
  return (
    <pre dir="auto" className="m-0 max-h-72 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted">
      {shape.text}
    </pre>
  );
}
