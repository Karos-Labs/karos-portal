/**
 * QA gates — TypeScript port of the karos-labs engine `scripts/qa.py`,
 * text-only preflight (the media/ffprobe/PNG checks are dropped — the native
 * port has no render step; slides are images, not template PNGs).
 *
 * PRESERVED gates (per qa.py):
 *  - check_text on every piece of POSTED copy: banned em-dash (— / ---),
 *    exclamation, semicolon (if enabled), emoji, and banned phrases
 *    (word-boundary, case-insensitive).
 *  - hashtags: exact count + case.
 *  - slides: count bounds, slide-1 hook role, ≥1 payoff role, no banned roles,
 *    last-slide closer role.
 *  - required_disclaimer present VERBATIM in posted copy.
 *  - one_number_per_post: at most one distinct number, disclaimer numbers exempt.
 *
 * ADAPTATION: "posted copy" = caption + each slide's headline/body. The slide
 * `imageConcept` is art direction (analogous to qa.py's excluded sourcing keys),
 * so it is NOT voice-scanned. Collects ALL failures (qa.py fails on the first)
 * so the run can surface them and feed them into a single regeneration pass —
 * never silent-fail.
 */
import type { CarouselSlide, ContentEngineConfig, VoiceConfig } from "./types";

const EM_DASH = "—";
const EN_DASH_TRIPLE = "---";
// Mirrors qa.py `_EMOJI_RE`.
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]/u;

export interface QaResult {
  pass: boolean;
  failures: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * config voice.banned_words → word-boundary, case-insensitive regexes (qa.py
 * `_banned_patterns`). Python's `\b` is Unicode-aware for str patterns, but
 * JavaScript's `\b` is ASCII-only even under /u — so a banned phrase that begins
 * or ends with an accented letter (pt-BR: "última chance", "café") would never
 * match. Use Unicode word-boundary lookarounds instead to preserve fidelity.
 */
function bannedPatterns(voice: VoiceConfig): RegExp[] {
  return (voice.bannedWords ?? [])
    .map((w) => String(w).trim())
    .filter(Boolean)
    .map((w) => {
      const src =
        w.startsWith("\\b") || w.endsWith("\\b")
          ? w
          : `(?<![\\p{L}\\p{N}_])${escapeRegex(w)}(?![\\p{L}\\p{N}_])`;
      return new RegExp(src, "iu");
    });
}

/** qa.py `check_text` — run over one field of posted copy. */
function checkText(label: string, text: string, voice: VoiceConfig, out: string[]): void {
  const chars = voice.bannedChars ?? {};
  if ((chars.emDash ?? true) && (text.includes(EM_DASH) || text.includes(EN_DASH_TRIPLE)))
    out.push(`${label}: em-dash present (U+2014 or ---)`);
  if ((chars.exclamation ?? true) && text.includes("!")) out.push(`${label}: exclamation mark present`);
  if ((chars.semicolon ?? false) && text.includes(";")) out.push(`${label}: semicolon present`);
  if ((chars.emoji ?? true) && EMOJI_RE.test(text)) out.push(`${label}: emoji present`);
  for (const pat of bannedPatterns(voice)) {
    if (pat.test(text)) out.push(`${label}: banned phrase matches /${pat.source}/`);
  }
}

/** Posted-copy strings (caption + slide headline/body) — excludes art-direction imageConcept. */
function editorialStrings(slides: CarouselSlide[], caption: string): string[] {
  const out: string[] = [];
  if (caption) out.push(caption);
  for (const s of slides) {
    if (s.headline) out.push(s.headline);
    if (s.body) out.push(s.body);
  }
  return out;
}

/**
 * Run every text-only QA gate on a generated carousel. `caption` should already
 * include the appended required disclaimer (the run appends it before QA).
 */
export function runQa(args: {
  slides: CarouselSlide[];
  caption: string;
  hashtags: string[];
  config: ContentEngineConfig;
}): QaResult {
  const { slides, caption, hashtags, config } = args;
  const voice = config.voice;
  const failures: string[] = [];

  // qa.py scans caption.md, which carries the hashtags — so fold them into the
  // voice/one-number scan rather than treating them as out-of-band metadata.
  const hashtagText = hashtags.map((h) => `#${h.replace(/^#+/, "")}`).join(" ");

  // 1) voice scan over posted copy (caption + slide headline/body + hashtags)
  checkText("caption", caption, voice, failures);
  slides.forEach((s, i) => {
    checkText(`slide ${i + 1} headline`, s.headline ?? "", voice, failures);
    if (s.body) checkText(`slide ${i + 1} body`, s.body, voice, failures);
  });
  if (hashtagText) checkText("hashtags", hashtagText, voice, failures);

  // 2) hashtags — exact count + case (Unicode-aware, matching Python isupper/islower)
  const want = voice.hashtags?.count ?? 2;
  const caseRule = voice.hashtags?.case ?? "lowercase";
  if (hashtags.length !== want) {
    failures.push(`caption: expected ${want} hashtags, found ${hashtags.length}`);
  }
  for (const raw of hashtags) {
    const t = raw.replace(/^#/, "");
    if (caseRule === "lowercase" && t !== t.toLowerCase()) failures.push(`caption: hashtag #${t} contains capitals`);
    if (caseRule === "uppercase" && t !== t.toUpperCase()) failures.push(`caption: hashtag #${t} contains lowercase`);
  }

  // 3) slides — count + role rules
  const { countMin, countMax, hookTypes, payoffTypes, closerTypes, bannedTypes } = config.slides;
  if (slides.length < countMin || slides.length > countMax) {
    failures.push(`slide count ${slides.length} outside ${countMin}-${countMax}`);
  }
  if (slides.length) {
    if (hookTypes.length && !hookTypes.includes(slides[0].role)) {
      failures.push(`slide 1 must be one of ${JSON.stringify(hookTypes)}, got ${JSON.stringify(slides[0].role)}`);
    }
    if (payoffTypes.length && !slides.some((s) => payoffTypes.includes(s.role))) {
      failures.push(`no payoff slide (need one of ${JSON.stringify(payoffTypes)})`);
    }
    if (closerTypes.length && !closerTypes.includes(slides[slides.length - 1].role)) {
      failures.push(`last slide must close (one of ${JSON.stringify(closerTypes)}), got ${JSON.stringify(slides[slides.length - 1].role)}`);
    }
    for (const s of slides) {
      if (bannedTypes.includes(s.role)) failures.push(`slide role ${JSON.stringify(s.role)} is banned (${JSON.stringify(bannedTypes)})`);
    }
  }

  // 4) required disclaimer — verbatim in posted copy. With
  // requireDisclaimerOnNumber (XO: qa.require_disclaimer_on_number), number-free
  // posts are exempt; otherwise it's required on every post.
  const editorial = [...editorialStrings(slides, caption), hashtagText].filter(Boolean);
  const joined = editorial.join("\n");
  const disc = voice.requiredDisclaimer;
  if (disc) {
    const exemptNoNumber = voice.requireDisclaimerOnNumber && !/\d/.test(joined);
    if (!exemptNoNumber && !joined.includes(disc)) {
      failures.push("required_disclaimer missing or not verbatim (must match config exactly, incl. diacritics/punctuation)");
    }
  }

  // 5) one number per post — disclaimer numbers exempt
  if (voice.oneNumberPerPost) {
    const stripped = disc ? joined.split(disc).join(" ") : joined;
    const nums = new Set(stripped.match(/\d+/g) ?? []);
    if (nums.size > 1) {
      failures.push(`one_number_per_post: ${nums.size} distinct numbers in posted copy ${JSON.stringify([...nums].sort())} (allow 1; disclaimer numbers exempt)`);
    }
  }

  return { pass: failures.length === 0, failures };
}
