import { describe, expect, it } from "vitest";

import { isLabProposalPath, labRefreshDir, normalizeLabSlug } from "@/lib/lab-outputs-shared";

/**
 * The path fence on lab-repo refresh proposals (admin Ops Import).
 *
 * The proposal reader takes a repo path that ROUND-TRIPS THE BROWSER: the scan
 * lists paths, the browser sends one back to be planned or applied. So the path
 * is untrusted input on the way in, and the convention has to be enforced
 * rather than assumed — otherwise an admin-shaped request could pull any file
 * in the private lab repo out through the portal's token.
 */

describe("isLabProposalPath", () => {
  it.each([
    ["traversal out of the refresh folder", "clients/geektime/refresh/../../../secrets.json"],
    ["traversal in the slug", "clients/../../etc/refresh/x.json"],
    ["a bare parent segment", "clients/../refresh/x.json"],
    ["another folder in the same repo", "clients/geektime/outputs/ig/run/client/caption.json"],
    ["the repo root", "package.json"],
    ["an absolute path", "/etc/passwd"],
    ["a leading slash on a valid-looking path", "/clients/geektime/refresh/a.json"],
    ["a non-json file", "clients/geektime/refresh/notes.md"],
    ["a dotfile", "clients/geektime/refresh/.env.json"],
    ["a nested path under refresh", "clients/geektime/refresh/sub/deep.json"],
    ["a missing filename", "clients/geektime/refresh/.json"],
    ["a different top folder", "internal/geektime/refresh/a.json"],
    ["an empty path", ""],
    ["a trailing newline smuggling a second line", "clients/geektime/refresh/a.json\nclients/x/y.json"],
  ])("refuses %s", (_label, path) => {
    expect(isLabProposalPath(path)).toBe(false);
  });

  it.each([
    ["the documented convention", "clients/geektime/refresh/geektime.proposal.json"],
    ["hyphens in the slug", "clients/pitch-by-deel/refresh/proposal.json"],
    ["a dated filename", "clients/sitti/refresh/2026-07-28.proposal.json"],
    ["underscores", "clients/xo_digital/refresh/xo_digital.json"],
  ])("accepts %s", (_label, path) => {
    expect(isLabProposalPath(path)).toBe(true);
  });

  // The lister builds paths from the same convention it filters on, so a slug
  // that normalizes cleanly always produces a path the reader will accept.
  it("agrees with the directory the lister walks", () => {
    const slug = normalizeLabSlug("https://github.com/karoslabs/karos-agents/tree/main/clients/geektime/outputs");
    expect(labRefreshDir(slug)).toBe("clients/geektime/refresh");
    expect(isLabProposalPath(`${labRefreshDir(slug)}/geektime.proposal.json`)).toBe(true);
  });
});
