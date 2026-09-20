import { describe, expect, it } from "vitest";
import { readPastedSourceLink } from "../run-attachments";

/**
 * Pasting a link to the episode, instead of downloading two hours of video in
 * order to upload it again (agent-engine RFC-25 phase 4).
 *
 * The engine has taken this since 2026-09-20 — `01b-resolve-source` routes on
 * `isDirectMediaUri`, ingesting a `gs://` object or an `https://` URL that
 * ends in a media extension, and handing anything else to yt-dlp as a page to
 * resolve. Nothing in the portal could produce one: `source-video` mode was a
 * file picker and there was no field that made a `mediaAssets` entry holding a
 * watch-page URL. The engine support was unreachable.
 *
 * What this reader is NOT is a check that the link works. It cannot be: only
 * the resolve can tell a live episode page from a dead one, and the engine
 * already treats a link that does not resolve as a tier that did not serve
 * rather than as a failed run. A dialog-side check that tried to predict it
 * would reject working links.
 */
describe("readPastedSourceLink", () => {
  it("takes a watch page and keeps the URL exactly, label aside", () => {
    const parsed = readPastedSourceLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(parsed).toEqual({ uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", label: "www.youtube.com/watch?v=dQw4w9WgXcQ" });
  });

  it("trims what a paste brings with it", () => {
    // A copied link routinely arrives with a trailing newline or a space, and
    // "https://… " is not a URL.
    expect(readPastedSourceLink("  https://example.com/ep/212  \n")).toMatchObject({ uri: "https://example.com/ep/212" });
  });

  it("does not invent a scheme", () => {
    // `new URL("youtube.com/watch")` throws rather than assuming https, and
    // that is the behaviour worth keeping: silently prefixing a scheme means
    // a typo becomes a request to a host the person did not name.
    expect(readPastedSourceLink("youtube.com/watch?v=abc")).toMatchObject({ error: expect.stringContaining("https://") });
    expect(readPastedSourceLink("")).toMatchObject({ error: "Paste a link first." });
    expect(readPastedSourceLink("   ")).toMatchObject({ error: "Paste a link first." });
  });

  it("refuses a scheme nothing downstream can fetch, and says what to do instead", () => {
    // `gs://` is the shape the UPLOAD button produces. One typed by hand
    // points at a bucket object this client may not own, so it is refused
    // here rather than 403ing inside a run twenty minutes later.
    const gs = readPastedSourceLink("gs://karos-media-prep/someone-elses/clip.mp4");
    expect(gs).toMatchObject({ error: expect.stringContaining("Attach source video") });
    expect(readPastedSourceLink("file:///C:/videos/ep.mp4")).toMatchObject({ error: expect.stringContaining("cannot be fetched") });
    expect(readPastedSourceLink("javascript:alert(1)")).toMatchObject({ error: expect.stringContaining("cannot be fetched") });
  });

  it("accepts a direct media URL too — the engine routes on the URI, and that one is a file", () => {
    // `isDirectMediaUri` sends this down the plain-GET ingest path instead of
    // to yt-dlp. Both are valid attachments; the dialog does not need to know
    // which, and should not be the place that decides.
    expect(readPastedSourceLink("https://cdn.example.com/episodes/212.mp4")).toMatchObject({ uri: "https://cdn.example.com/episodes/212.mp4" });
  });

  it("accepts http:// rather than silently upgrading it", () => {
    // Rare and usually a mistake, but a podcast host still serving plain http
    // is a real thing, and rewriting somebody's URL is worse than fetching
    // the one they gave.
    expect(readPastedSourceLink("http://oldpodcast.example/ep/3")).toMatchObject({ uri: "http://oldpodcast.example/ep/3" });
  });

  it("labels the link by what distinguishes it, not by its scheme", () => {
    // Every row would start "https://", so the scheme costs the part that
    // says which link this is. The trailing slash goes for the same reason.
    expect(readPastedSourceLink("https://podcasts.example.com/shows/margins/212/")).toMatchObject({ label: "podcasts.example.com/shows/margins/212" });
  });
});
