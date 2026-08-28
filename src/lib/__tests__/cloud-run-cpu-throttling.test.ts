import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SCRUM-265 item 2 — "cpu=1 against concurrency=80."
 *
 * docs/qa-sweep-2026-07/TOMER-HANDOVER.md §3.1 ("Cloud Run: after() background
 * work needs CPU") and rescopes.md both name the same finding: the promote
 * deploy's `cloud-run-deploy` step carries `--cpu=1` / `--concurrency=80` with
 * no CPU-allocation flag, so under Cloud Run's default request-based billing
 * the CPU is throttled to ~0 the instant the HTTP response is sent — which
 * kills every `after()` background job (chain reflow, usage logging, the
 * webhook's Phase-3 side effects) silently and unpredictably, since it "works"
 * whenever the container happens to stay warm servicing another concurrent
 * request and does nothing when it doesn't.
 *
 * The documented fix is `--no-cpu-throttling` (instance-based billing) in the
 * SAME deploy args list — not a bare grep for the string anywhere in the file,
 * which would also pass for a flag mentioned only in a comment.
 */
function cloudRunDeployArgs(file: string): string[] {
  const text = readFileSync(resolve(process.cwd(), file), "utf8");
  // Both cloudbuild.promote.yaml (a real `args:` YAML list) and cloudbuild.yaml
  // (a bash heredoc `gcloud run deploy ... \` block) express the deploy args
  // differently, so pull every line between the `cloud-run-deploy` step id and
  // the next top-level step (a line starting "  - id:" at the same indent) or
  // EOF, then keep only lines that look like a flag.
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === "- id: cloud-run-deploy");
  if (startIdx === -1) throw new Error(`no cloud-run-deploy step found in ${file}`);
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^ {2}- id:/.test(l));
  const block = endIdx === -1 ? rest : rest.slice(0, endIdx);
  return block
    .map((l) => l.trim())
    .filter((l) => l.startsWith("--") || l.startsWith("- --"))
    .map((l) => l.replace(/^- /, ""));
}

describe("Cloud Run deploy CPU allocation vs. concurrency", () => {
  it("cloudbuild.promote.yaml's deploy step disables CPU throttling", () => {
    const args = cloudRunDeployArgs("cloudbuild.promote.yaml");
    expect(args, "cloud-run-deploy step must carry --cpu=1").toContain("--cpu=1");
    expect(args, "cloud-run-deploy step must carry --concurrency=80").toContain("--concurrency=80");
    expect(
      args,
      "cpu=1 against concurrency=80 with no CPU-allocation flag throttles after() background " +
        "work to near-zero CPU once the response is sent (request-based billing). Add " +
        "--no-cpu-throttling to the SAME deploy args list (see TOMER-HANDOVER.md §3.1).",
    ).toContain("--no-cpu-throttling");
  });
});
