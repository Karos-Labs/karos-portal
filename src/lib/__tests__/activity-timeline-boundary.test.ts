import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What a client's Workspace timeline is ALLOWED to receive.
 *
 * The timeline narrates two streams — activity logs and agent runs — and both
 * cross into a `"use client"` component. The jobs half was projected field by
 * field long ago (TimelineJob), because a whole Job carries the operator's
 * prompt, the internal execution trace and the lab repo's git SHA. The logs
 * half was still handed over whole: an ActivityLog carries `clientId`, a
 * free-form `metadata` bag, and the actor name exactly as its writer stored it
 * — and the automated writers store internal service names. Staff MANUAL_NOTE
 * rows travelled with it, filtered out in the browser after the payload had
 * already been downloaded.
 *
 * Both halves are now decided in tasks-body.tsx. These tests read the source,
 * because the projection is a server component that a unit test cannot render.
 */
const SERVER = "src/app/(app)/tasks/tasks-body.tsx";
const UI = "src/components/activity-timeline.tsx";

const server = readFileSync(join(process.cwd(), SERVER), "utf8");
const ui = readFileSync(join(process.cwd(), UI), "utf8");

/**
 * Source with comments removed. The negative assertions below say "this name
 * does not appear in the CODE"; run against the raw file they also fire on the
 * docstrings that explain why it must not, which would make the honest way to
 * keep them green deleting the explanation.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The projection block, so a match cannot come from somewhere else in the file. */
function projection(): string {
  const src = code(server);
  const start = src.indexOf("const timelineActivity");
  expect(start, `${SERVER} has no timelineActivity projection`).toBeGreaterThan(-1);
  const end = src.indexOf("const agentLabelByAssetId", start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("the activity timeline's RSC boundary", () => {
  it("drops staff notes on the server, not in the browser", () => {
    // MANUAL_NOTE rows come from the timeline's own staff-only composer ("Add
    // an internal note…"). They used to cross in full — title, body and the
    // staff author's name — and were filtered at render, which is redaction
    // that has already lost.
    expect(projection()).toMatch(/!isClientViewer \|\| log\.type !== "MANUAL_NOTE"/);
    // And the browser no longer re-decides it: a second answer to "may this
    // viewer read this row" is how the two come to disagree, and the one that
    // runs after the payload shipped is the one that does not count.
    expect(code(ui)).not.toContain('!== "MANUAL_NOTE"');
  });

  it("projects by construction, so a new ActivityLog field is excluded by default", () => {
    // Built field by field like the jobs list beside it — never `{ ...log }`,
    // which is what put `metadata` and `clientId` in the payload and would put
    // the next field added to the type there too.
    const block = projection();
    expect(block).not.toMatch(/\.\.\.log\b/);
    for (const field of ["id:", "timestamp:", "type:", "title:", "description"]) {
      expect(block, `the projection drops ${field}`).toContain(field);
    }
    // The two fields that must never cross as stored.
    expect(block).not.toContain("clientId");
    expect(block).not.toContain("metadata");
  });

  it("gives the component a type that cannot hold the raw row", () => {
    // The pin that keeps the projection honest: if the prop went back to
    // ActivityLog[], every assertion above could pass while the whole document
    // crossed anyway.
    expect(ui).toContain("export interface TimelineActivity");
    expect(code(ui)).toContain("activityLogs: TimelineActivity[]");
    // Not merely un-annotated: the raw type is not even imported, so it cannot
    // come back without the import coming back with it.
    expect(code(ui)).not.toContain("ActivityLog");
    const progress = readFileSync(join(process.cwd(), "src/components/progress-view.tsx"), "utf8");
    expect(code(progress)).toContain("activityLogs: TimelineActivity[]");
    expect(code(progress)).not.toContain("ActivityLog");
  });

  it("leaves the staff timeline whole", () => {
    // Every redaction above is conditioned on the viewer, so staff still get
    // their notes, the real actor names and the runs they need to debug. A
    // projection that quietly hid rows from staff would be a different bug.
    const block = projection();
    expect(block).toContain("isClientViewer");
    expect(block).toContain("clientSafeActor(log.actor, log.actorRole, isClientViewer)");
    // clientSafeActor is a no-op for non-client viewers by contract
    // (runway.test.ts drives it); nothing here may filter unconditionally.
    expect(block).not.toMatch(/\.filter\(\(log\) => log\.type !== "MANUAL_NOTE"\)/);
  });
});
