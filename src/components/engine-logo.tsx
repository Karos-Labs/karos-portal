import type { EngineId } from "@/lib/seo-geo";

/**
 * Monochrome marks for the AI engines we measure (portal feedback round 4,
 * 2026-09).
 *
 * WHY THEY EXIST. The visibility report used to name its engines in a row of
 * text chips carrying a status badge each. The product owner's note was about
 * credibility: a reader recognises "we asked ChatGPT, Gemini and Claude" from
 * the marks faster than they read three words, and the marks are what make the
 * claim look measured rather than asserted.
 *
 * WHAT THEY ARE, PRECISELY. Simplified silhouettes drawn by hand here, in
 * `currentColor`, at a single 24-unit viewBox — the same rule the platform
 * glyphs in `icon.tsx` follow (lucide dropped brand icons, so brand marks are
 * hand-rolled SVG in this codebase). Not the vendors' own artwork: no external
 * image, no colour, nothing fetched at runtime, and nothing that would pass for
 * an official lockup at any size. They are read at 12–14px beside the engine's
 * own name, which carries the identification; the mark carries the recognition.
 *
 * Anything not in the map renders a neutral dot rather than a wrong logo, so a
 * sixth engine added to `EngineId` degrades instead of mislabelling.
 */
export function EngineLogo({ engine, className }: { engine: EngineId; className?: string }) {
  const common = {
    viewBox: "0 0 24 24",
    className,
    "aria-hidden": true as const,
    focusable: "false" as const,
  };
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (engine) {
    // The interlocking hexagonal knot, reduced to its outline plus the two
    // internal chords that make it read as a knot rather than a hexagon.
    case "chatgpt":
      return (
        <svg {...common} {...stroke}>
          <path d="M12 2.6 20.1 7.3v9.4L12 21.4 3.9 16.7V7.3z" />
          <path d="M12 2.6v9.4l8.1 4.7" />
          <path d="M12 12 3.9 16.7" />
        </svg>
      );
    // The four-pointed spark, concave sides.
    case "gemini":
      return (
        <svg {...common} fill="currentColor">
          <path d="M12 2c.5 4.9 5.1 9.5 10 10-4.9.5-9.5 5.1-10 10-.5-4.9-5.1-9.5-10-10 4.9-.5 9.5-5.1 10-10z" />
        </svg>
      );
    // The radiating burst: six tapered strokes around a common centre.
    case "claude":
      return (
        <svg {...common} {...stroke}>
          <path d="M12 3.2v17.6" />
          <path d="M4.4 7.6l15.2 8.8" />
          <path d="M4.4 16.4l15.2-8.8" />
        </svg>
      );
    // The rotated square glyph with its centre bar and stem.
    case "perplexity":
      return (
        <svg {...common} {...stroke}>
          <path d="M4.4 8.2h15.2v7.6H4.4z" />
          <path d="M12 4.6v14.8" />
          <path d="M12 8.2 6.6 4.6M12 8.2l5.4-3.6" />
        </svg>
      );
    // The twisted ribbon loop, as two mirrored arcs meeting at the centre.
    case "copilot":
      return (
        <svg {...common} {...stroke}>
          <path d="M4 15.4c0-4.2 2.2-7.4 5-7.4 2.4 0 3.2 2.2 4 5.4" />
          <path d="M20 8.6c0 4.2-2.2 7.4-5 7.4-2.4 0-3.2-2.2-4-5.4" />
          <path d="M9 8h6M9 16h6" />
        </svg>
      );
    default:
      return (
        <svg {...common} fill="currentColor">
          <circle cx="12" cy="12" r="4" />
        </svg>
      );
  }
}
