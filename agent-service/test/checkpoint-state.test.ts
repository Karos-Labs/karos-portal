import { describe, expect, it } from "vitest";
import { appendCheckpointFile } from "../src/state/checkpoint.js";

describe("appendCheckpointFile", () => {
  it("starts a fresh checkpoint when none exists", () => {
    const result = appendCheckpointFile(undefined, 1, { path: "a.md", url: "https://x/a", bytes: 10 });
    expect(result).toEqual({ attempt: 1, files: [{ path: "a.md", url: "https://x/a", bytes: 10 }], bytes: 10 });
  });

  it("appends within the same attempt", () => {
    const first = appendCheckpointFile(undefined, 1, { path: "a.md", url: "https://x/a", bytes: 10 });
    const second = appendCheckpointFile(first, 1, { path: "b.md", url: "https://x/b", bytes: 20 });
    expect(second).toEqual({
      attempt: 1,
      files: [
        { path: "a.md", url: "https://x/a", bytes: 10 },
        { path: "b.md", url: "https://x/b", bytes: 20 },
      ],
      bytes: 30,
    });
  });

  it("replaces a stale (earlier-attempt) checkpoint wholesale instead of merging", () => {
    const attempt1 = appendCheckpointFile(undefined, 1, { path: "old.md", url: "https://x/old", bytes: 5 });
    const attempt2 = appendCheckpointFile(attempt1, 2, { path: "new.md", url: "https://x/new", bytes: 7 });
    expect(attempt2).toEqual({
      attempt: 2,
      files: [{ path: "new.md", url: "https://x/new", bytes: 7 }],
      bytes: 7,
    });
  });
});
