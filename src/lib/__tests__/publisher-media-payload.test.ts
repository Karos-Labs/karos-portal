/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { publishAssetToPlatform } from "@/lib/integrations/publishers";
import { matchingParen, isStringDelimiter, matchingBrace, skipStringLiteral } from "./source-scan";

/**
 * #48 — NO BULK-UPLOADED CLIP COULD EVER PUBLISH.
 *
 * `publishToTikTok` took its media URL from `asset.imageUrl`, with a comment
 * asserting "the media URL rides on asset.imageUrl". The bulk-upload route — the
 * only writer of `asset.videoUrl`, and the path that channels its clips to TikTok —
 * sets `videoUrl` and never `imageUrl`. So every scheduled clip failed with "TikTok
 * posts require a video file (e.g. video/mp4)", the exact shape TikTok exists for,
 * and (before the publish-error sanitizer at the asset-visibility boundary landed)
 * that sentence was quoted on the client's home page as the reason their post did
 * not go out.
 *
 * Then the same question of every other publisher, because "was that the only
 * instance" is the rule that doubles the count: each one had its own private idea
 * of where an asset's media lives, and three of the five would post SOMETHING
 * other than the deliverable rather than refuse.
 */

const CREDENTIALS = { accessToken: "tok", pageId: "page-1" };
const integration = { platform: "x", credentials: CREDENTIALS } as any;

/** The asset the bulk-upload dropzone actually writes (api/assets/bulk-upload). */
function bulkClip(overrides: Record<string, any> = {}) {
  return {
    id: "a1",
    clientId: "c1",
    type: "social_post",
    title: "Founder clip 3",
    content: "",
    meta: { bulkUpload: true, gcsPath: "clients/c1/podcast-clips/clip-3.mp4" },
    videoUrl: "https://storage.googleapis.com/bucket/clip-3.mp4?X-Goog-Signature=abc",
    mimeType: "video/mp4",
    channels: ["tiktok"],
    status: "draft",
    ...overrides,
  } as any;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  };
}

let calls: Array<{ url: string; body: any }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      let body: any = init?.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          /* keep the raw string */
        }
      } else if (body instanceof URLSearchParams) {
        body = Object.fromEntries(body.entries());
      }
      calls.push({ url, body });
      if (url.includes("tiktokapis")) return jsonResponse({ data: { publish_id: "pub-1" } });
      if (url.includes("media_publish")) return jsonResponse({ id: "ig-post-1" });
      if (url.includes("/media")) return jsonResponse({ id: "container-1" });
      if (url.includes("/feed")) return jsonResponse({ id: "fb-post-1" });
      if (url.includes("ugcPosts")) return jsonResponse({ id: "li-post-1" });
      if (url.includes("api.twitter.com")) return jsonResponse({ data: { id: "tw-1" } });
      return jsonResponse({});
    }),
  );
});

describe("#48 — TikTok publishes the clip the asset actually carries", () => {
  it("pulls the video URL off a bulk-uploaded clip", async () => {
    const result = await publishAssetToPlatform("tiktok", integration, bulkClip());

    expect(result.postId).toBe("pub-1");
    expect(calls[0]!.body.source_info).toEqual({
      source: "PULL_FROM_URL",
      video_url: "https://storage.googleapis.com/bucket/clip-3.mp4?X-Goog-Signature=abc",
    });
  });

  it("finds a clip that arrived through the webhook's artifact list", async () => {
    // A run's video deliverable has no `videoUrl` — it is a re-hosted artifact.
    // assetVideos knows that shape; the old bare `asset.imageUrl` read did not.
    const asset = bulkClip({
      videoUrl: null,
      mimeType: null,
      meta: {
        artifacts: [
          { name: "brief.md", url: "https://cdn.test/brief.md", contentType: "text/markdown" },
          { name: "cut-1.mp4", url: "https://cdn.test/cut-1.mp4", contentType: "video/mp4" },
        ],
      },
      content: "Caption",
    });

    await publishAssetToPlatform("tiktok", integration, asset);

    expect(calls[0]!.body.source_info.video_url).toBe("https://cdn.test/cut-1.mp4");
  });

  it("still accepts a legacy payload whose clip rides on imageUrl", async () => {
    // The fallback is kept deliberately: deleting it would have taken this remedy
    // away with the fix.
    const asset = bulkClip({
      videoUrl: null,
      imageUrl: "https://cdn.test/legacy.mp4",
      content: "Caption",
    });

    await publishAssetToPlatform("tiktok", integration, asset);

    expect(calls[0]!.body.source_info.video_url).toBe("https://cdn.test/legacy.mp4");
  });

  it("refuses a photo post rather than posting it as a video", async () => {
    const asset = bulkClip({ videoUrl: null, mimeType: null, imageUrl: "https://cdn.test/photo.jpg" });
    await expect(publishAssetToPlatform("tiktok", integration, asset)).rejects.toThrow(
      /require a video file/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("#48 — the text-first publishers refuse what they cannot carry", () => {
  for (const platform of ["twitter", "linkedin", "facebook"] as const) {
    it(`${platform} refuses a clip instead of posting a caption without it`, async () => {
      // The auto-publish cron infers a platform from PUBLISHABLE_PLATFORMS when the
      // asset has no scheduledPlatform, and social_post lists twitter FIRST — so
      // this exact asset used to reach X, which posted its empty content.
      await expect(
        publishAssetToPlatform(platform, integration, bulkClip({ content: "Watch this" })),
      ).rejects.toThrow(/video would be dropped/);
      expect(calls, `${platform} sent something anyway`).toHaveLength(0);
    });

    it(`${platform} refuses a post with nothing to say`, async () => {
      const textless = bulkClip({ videoUrl: null, mimeType: null, content: "   " });
      await expect(publishAssetToPlatform(platform, integration, textless)).rejects.toThrow(
        /no text to publish/,
      );
      expect(calls).toHaveLength(0);
    });
  }

  it("still posts an ordinary text post", async () => {
    // The counterweight: preconditions that refused everything would pass the two
    // assertions above and break every real publish.
    const post = bulkClip({ videoUrl: null, mimeType: null, content: "A real post." });
    await expect(publishAssetToPlatform("twitter", integration, post)).resolves.toEqual({
      postId: "tw-1",
    });
    expect(calls[0]!.body.text).toBe("A real post.");
  });

  it("still posts a written post that merely CARRIES an attached clip", async () => {
    // The narrowing this rule needed. A LinkedIn batch's media files can include an
    // mp4 the per-draft reader offers a human (assetLiMedia accepts video), and the
    // deliverable there is the text — so refusing over the attachment would have
    // broken a live path to fix a different one. The attachment is still dropped,
    // which isClipDeliverable's docstring states rather than fixes.
    const written = bulkClip({
      videoUrl: null,
      mimeType: null,
      content: "A written post.",
      meta: {
        artifacts: [{ name: "brief.mp4", url: "https://cdn.test/brief.mp4", contentType: "video/mp4" }],
      },
    });

    // organizationId so the publisher posts as the page and skips profile lookup —
    // the subject here is the precondition, not LinkedIn's author resolution.
    const asPage = { platform: "linkedin", credentials: { ...CREDENTIALS, organizationId: "12345" } } as any;
    await expect(publishAssetToPlatform("linkedin", asPage, written)).resolves.toBeTruthy();
    expect(calls[0]!.url).toContain("ugcPosts");
  });

  it("lets Facebook post a photo with no caption, and attaches a photo from meta.files", async () => {
    // Facebook is the one text-first publisher that CAN carry a photo, so it says
    // so through the shared precondition instead of having its own rule.
    const photoPost = bulkClip({
      videoUrl: null,
      mimeType: null,
      content: "",
      meta: { files: [{ name: "hero.png", url: "https://cdn.test/hero.png" }] },
    });

    await publishAssetToPlatform("facebook", integration, photoPost);

    expect(calls[0]!.body.url).toBe("https://cdn.test/hero.png");
  });
});

describe("#48 — Instagram sees the photos the rest of the product sees", () => {
  it("posts a photo that only exists in meta.artifacts", async () => {
    // Every webhook carousel and every lab import lands its photos there; the bare
    // `asset.imageUrl` read called those posts image-less.
    const carousel = bulkClip({
      type: "instagram_post",
      videoUrl: null,
      mimeType: null,
      content: "Caption",
      meta: {
        artifacts: [
          { name: "slide-1.png", url: "https://cdn.test/slide-1.png", contentType: "image/png" },
          { name: "slide-2.png", url: "https://cdn.test/slide-2.png", contentType: "image/png" },
        ],
      },
    });

    const result = await publishAssetToPlatform("instagram", integration, carousel);

    expect(result.postId).toBe("ig-post-1");
    expect(calls[0]!.body.image_url).toBe("https://cdn.test/slide-1.png");
  });

  it("names the real reason for a clip-only asset instead of 'requires an image'", async () => {
    await expect(publishAssetToPlatform("instagram", integration, bulkClip())).rejects.toThrow(
      /Reels\) publishing is not automated yet/,
    );
    expect(calls).toHaveLength(0);
  });

  it("never hands Instagram an .mp4 as its image_url", async () => {
    // assetImages returns `asset.imageUrl` unfiltered as its last resort, and a
    // legacy payload can hold a video there — which Meta would reject with its own
    // error instead of the reason.
    const asset = bulkClip({
      type: "instagram_post",
      videoUrl: null,
      mimeType: null,
      imageUrl: "https://cdn.test/legacy.mp4",
      content: "Caption",
    });
    await expect(publishAssetToPlatform("instagram", integration, asset)).rejects.toThrow(
      /Reels\) publishing is not automated yet/,
    );
  });
});

/**
 * THE TRIPWIRE for the shape rather than for the one symptom: a publisher may not
 * reach for a media field itself. Both accessors live in one place, know every
 * field a payload can use, and are the only functions allowed to name those
 * fields.
 *
 * WHO IS ASKED, AND WHY NOT-FINDING-ONE IS ITSELF A FAILURE. The question goes to
 * every function the dispatcher's `switch` calls, plus every function whose name
 * begins with `publish` — keyed to the argument (who publishes) and not to a line
 * range, so reordering this file cannot loosen it. A scan can only ask a function
 * it has a body for, so the subject list is cross-checked against the switch: a
 * name the dispatcher routes to and this scan cannot see turns the test RED
 * instead of dropping quietly out of the list.
 *
 * That cross-check and the arrow shape below are what this replaces. The scan read
 * `function name(…)` only, and its non-vacuity floor ("at least six declarations")
 * was already satisfied by the six that existed — so an arrow-const
 * `const publishToThreads = async (credentials, asset) => …` reading a media field
 * was never in the map, was never asked, and nothing could notice that it had not
 * been. Verified by putting exactly that publisher above the dispatcher: all 18
 * tests stayed green. The floor is gone with it; a count that a new omission
 * cannot move is not a non-vacuity check.
 *
 * STATED RESIDUALS, because a text scan is not a parser and this is about what the
 * question COVERS rather than the scan's ability to ask it:
 *  • The pattern names the two URL fields. A publisher reaching for media by
 *    another spelling — a destructure (`const { videoUrl } = asset`), a computed
 *    key, a field added later — is not matched.
 *  • A function neither dispatched by the switch nor named `publish…` is not in
 *    the subject list.
 *  • `DECL_SHAPES` names the declaration forms this scan reads; anything else is
 *    only caught when the switch dispatches to it.
 */
describe("#48 — no publisher reads a media field for itself", () => {
  const SOURCE = readFileSync(
    resolve(__dirname, "../integrations/publishers.ts"),
    "utf8",
  );

  const DISPATCHER = "publishAssetToPlatform";

  type Decl = { name: string; at: number; after: number; arrow: boolean };

  /**
   * The declaration shapes a publisher can be written in. All four are here
   * because the next one added will be written in whichever the author reaches
   * for, and the one that was missing is the one the omission arrived in.
   *
   * Each pattern ends on a lookahead, so `after` is the first character of the
   * parameter list (or of the `=>` for a bare single parameter) and the body walk
   * below starts from a known place.
   */
  const DECL_SHAPES: Array<{ re: RegExp; arrow: boolean }> = [
    // function name(…) · async function name(…) · export … function name(…)
    { re: /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?=\()/g, arrow: false },
    // const name = function (…) · const name = async function inner (…)
    {
      re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*(?:async\s+)?function\b[^(]*(?=\()/g,
      arrow: false,
    },
    // const name = (…) => … · const name = async (…) => …
    {
      re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*(?:async\s+)?(?=\()/g,
      arrow: true,
    },
    // const name = asset => … · const name = async asset => …
    {
      re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*(?==>)/g,
      arrow: true,
    },
  ];

  /** The `;` that ends the statement starting at `from` — a concise arrow body. */
  function endOfStatement(src: string, from: number): number {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      const ch = src[i]!;
      if (isStringDelimiter(ch)) {
        i = skipStringLiteral(src, i);
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === ";" && depth === 0) return i;
    }
    return src.length;
  }

  /**
   * The `=>` of the arrow starting at `from`, or -1 if the statement ends first —
   * which is how a parenthesised expression (`const x = (await res.json()) as T;`)
   * is told apart from an arrow with the same opening.
   *
   * It has to be searched for rather than expected right after the parameters,
   * because a RETURN TYPE sits between them: the mutation this scan was rebuilt
   * for is `const publishToThreads = async (…): Promise<PublishResult> => {`, and
   * a version of this walk that demanded `=>` immediately after the `)` still
   * reported that publisher green. The `;` bound is what keeps the search from
   * wandering into the next arrow further down the file.
   */
  function arrowAt(src: string, from: number): number {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      const ch = src[i]!;
      if (isStringDelimiter(ch)) {
        i = skipStringLiteral(src, i);
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (depth === 0 && ch === "=" && src[i + 1] === ">") return i;
      else if (depth === 0 && ch === ";") return -1;
    }
    return -1;
  }

  /**
   * The text of one declaration's body, or null when the match was not a function
   * after all (`const published = (await res.json()) as {…}` matches the arrow
   * shape until the `=>` turns out not to be there).
   *
   * The parameter list is skipped by PAREN-MATCHING rather than by taking the
   * first `{`, which is a second instance of the same blindness: this file's
   * `assertTextPostDeliverable(platform, asset, opts: { attachesPhoto: boolean })`
   * declares an inline object type in its parameters, so "the first `{` after the
   * declaration" read that type as the whole body. Harmless there only because
   * the name does not begin with `publish`; a publisher taking an options object
   * would have been scanned with a body of `{ attachesPhoto: boolean }` and
   * answered the question green while blind.
   *
   * Adjacent brace groups are taken together so a `: { ok: boolean }` return type
   * cannot stand in for the body either. STATED HOLE: a return type whose object
   * hides inside a generic (`Promise<{ ok: boolean }>`) is not adjacent to the
   * body and would be taken for it, leaving the real body unread — the one
   * mis-parse here that fails OPEN. No such signature exists in this file, and
   * the switch cross-check does not catch it, because the function IS found; only
   * its extent is wrong.
   */
  function bodyOf(src: string, d: Decl, limit: number): string | null {
    let i = d.after;
    if (src[i] === "(") {
      const close = matchingParen(src, i);
      if (close === -1) return null;
      i = close + 1;
    }
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (d.arrow) {
      const arrow = arrowAt(src, i);
      if (arrow === -1) return null;
      i = arrow + 2;
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] !== "{") return src.slice(i, endOfStatement(src, i));
    }
    const start = src.indexOf("{", i);
    if (start === -1 || start >= limit) return null;
    let close = -1;
    for (let group = start; ; ) {
      const end = matchingBrace(src, group);
      if (end === -1) break;
      close = end;
      let next = end + 1;
      while (next < limit && /\s/.test(src[next]!)) next++;
      if (next < limit && src[next] === "{") {
        group = next;
        continue;
      }
      break;
    }
    return close === -1 ? null : src.slice(start, close + 1);
  }

  /**
   * `{ name: body }` for every function this file declares, in any shape above.
   * Bodies are delimited by the shared brace walk (source-scan.ts) so a brace
   * inside a string literal cannot run one body into the next, and a body
   * includes anything nested inside it — a media read inside a callback in a
   * publisher is still that publisher's read.
   */
  function functionBodies(src: string): Record<string, string> {
    const decls: Decl[] = [];
    for (const { re, arrow } of DECL_SHAPES) {
      for (const m of src.matchAll(re)) {
        decls.push({ name: m[1]!, at: m.index!, after: m.index! + m[0].length, arrow });
      }
    }
    decls.sort((a, b) => a.at - b.at);
    const bodies: Record<string, string> = {};
    decls.forEach((d, i) => {
      const body = bodyOf(src, d, decls[i + 1]?.at ?? src.length);
      if (body) bodies[d.name] = body;
    });
    return bodies;
  }

  /**
   * The two shapes an arm of this switch is allowed to take: hand the asset to a
   * publisher, or refuse the platform. Read as PATTERNS over the arm's text so
   * that an arm doing anything else — `{ const r = await publishToX(…); return r; }`,
   * `return this.publishers[platform](…)` — matches neither and is reported, rather
   * than passing as an arm with no publisher in it.
   */
  const ARM_RETURNS_CALL = /return\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  const ARM_REFUSES = /\bthrow\b/;

  /**
   * Every `case "…":` arm of the dispatcher, paired with the publisher it returns
   * — read out of the dispatcher's own body text, so it is the switch that names
   * the publishers rather than this file guessing at them. `default:` bounds an
   * arm without being one.
   *
   * Deliberately not "every identifier in call position": the YouTube arm's own
   * comment contains the words "Video upload (resumable…", and a scan loose enough
   * to read that as a dispatch reports a publisher called `upload` that nobody
   * wrote. The narrower pattern is why `dispatches` is checked separately — an arm
   * whose call this cannot see must fail, not vanish.
   */
  function dispatchArms(
    dispatcher: string,
  ): Array<{ platform: string; callees: string[]; dispatches: boolean }> {
    const marks = [...dispatcher.matchAll(/case\s+(?:"([^"]*)"|'([^']*)')\s*:|default\s*:/g)];
    const arms: Array<{ platform: string; callees: string[]; dispatches: boolean }> = [];
    marks.forEach((m, i) => {
      const platform = m[1] ?? m[2];
      if (platform === undefined) return;
      const from = m.index! + m[0].length;
      const to = i + 1 < marks.length ? marks[i + 1]!.index! : dispatcher.length;
      const arm = dispatcher.slice(from, to);
      const callees = [...arm.matchAll(ARM_RETURNS_CALL)].map((c) => c[1]!);
      arms.push({ platform, callees, dispatches: callees.length > 0 || ARM_REFUSES.test(arm) });
    });
    return arms;
  }

  /**
   * Asked of the functions the switch dispatches to, plus every function whose
   * name begins with `publish` — rather than of everything-except-an-allowlist.
   * An allowlist would have to grow each time a shared media helper is added, and
   * a guard that grows to accommodate new code is a guard that eventually exempts
   * the thing it was watching.
   *
   * The switch half is what stops this being keyed to a naming convention: a
   * publisher called `sendToThreads` is still dispatched, so it is still asked.
   * The name half catches one written before it is wired up.
   */
  const isPublisher = (name: string) => /^publish/.test(name);

  function subjectNames(bodies: Record<string, string>): string[] {
    const dispatched = dispatchArms(bodies[DISPATCHER] ?? "").flatMap((a) => a.callees);
    return [...new Set([...dispatched, ...Object.keys(bodies).filter(isPublisher)])].sort();
  }

  it("found the publishers to ask about", () => {
    const bodies = functionBodies(SOURCE);
    for (const name of [
      "publishToInstagram",
      "publishToFacebook",
      "publishToLinkedIn",
      "publishToTwitter",
      "publishToTikTok",
      DISPATCHER,
      "clipUrl",
      "photoUrl",
    ]) {
      expect(Object.keys(bodies), `${name} not found — the scan broke`).toContain(name);
    }
  });

  it("leaves asset.imageUrl and asset.videoUrl to the shared accessors", () => {
    const bodies = functionBodies(SOURCE);
    for (const arm of dispatchArms(bodies[DISPATCHER] ?? "")) {
      expect(
        arm.dispatches,
        `the "${arm.platform}" arm of ${DISPATCHER} neither returns a publisher call ` +
          `nor throws, so this scan cannot tell which function handles it and the ` +
          `media-field question cannot reach it. Return the call directly.`,
      ).toBe(true);
    }
    for (const name of subjectNames(bodies)) {
      const body = bodies[name];
      expect(
        body,
        `${DISPATCHER} dispatches to ${name}, and this scan has no body for it — ` +
          `so the media-field question below was never asked of it. Declare it in ` +
          `this module in one of the DECL_SHAPES forms, or add the form to them.`,
      ).toBeDefined();
      expect(
        /asset\.(imageUrl|videoUrl)/.test(body ?? ""),
        `${name} reads a media field directly. Ask clipUrl()/photoUrl() instead — ` +
          `they know all four places a payload can live, which is finding #48.`,
      ).toBe(false);
    }
  });

  /**
   * NON-VACUITY for both checks above, and the reason neither is keyed to a count:
   * everything they know about who publishes comes out of the switch's `case`
   * labels, so anything that stops those labels being readable empties the subject
   * list while the dispatcher goes on publishing. Two mutations that do exactly
   * that, and both were green until this test existed: moving the routing into a
   * lookup map (`PUBLISHERS[platform]?.(…)`), and a case label written as a
   * constant (`case THREADS_ID:`) instead of a literal.
   *
   * So the scan's labels are checked BOTH WAYS against what the dispatcher really
   * answers, over a probe set taken from the product's own publish-target map
   * rather than a list kept here: found ⇒ the platform is not refused as
   * unimplemented, and not-found ⇒ it is. A platform added to
   * PUBLISHABLE_PLATFORMS is probed from then on without anyone editing this file.
   */
  const PROBE_IDS = [
    ...new Set(Object.values(PUBLISHABLE_PLATFORMS).flat()),
    // The switch answers youtube (with a refusal) though no asset type lists it,
    // and two ids nothing dispatches, so both directions have something to prove.
    "youtube",
    "threads",
    "bluesky",
  ];

  it("reads the same switch the dispatcher runs on", async () => {
    const labels = dispatchArms(functionBodies(SOURCE)[DISPATCHER] ?? "").map((a) => a.platform);
    expect(
      labels.length,
      `no case labels found in ${DISPATCHER} — it is no longer a switch this scan ` +
        `can read, and the subject list above just went vacuous`,
    ).toBeGreaterThan(0);

    const refusalFor = async (platform: string) => {
      try {
        await publishAssetToPlatform(platform, integration, bulkClip());
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };

    for (const platform of labels) {
      expect(await refusalFor(platform), `scanned a case for ${platform} that is not dispatched`)
        .not.toMatch(/not implemented for platform/);
    }
    for (const platform of PROBE_IDS) {
      if (labels.includes(platform)) continue;
      expect(
        await refusalFor(platform),
        `${platform} is dispatched, but the scan found no case label for it — the ` +
          `subject list above is missing whatever publishes it`,
      ).toMatch(/not implemented for platform/);
    }
  });
});
