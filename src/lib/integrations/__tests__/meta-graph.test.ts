import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  META_GRAPH_VERSION,
  META_OAUTH_DIALOG_URL,
  META_OAUTH_TOKEN_URL,
  metaGraphUrl,
} from "../meta-graph";

/* __tests__ → integrations → lib → src */
const SRC_ROOT = path.resolve(__dirname, "../../..");
const MODULE_PATH = path.resolve(__dirname, "../meta-graph.ts");
const THIS_TEST = path.resolve(__filename);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every .ts/.tsx under src/ except the module that owns the version and this test. */
function sourcesToSweep(): string[] {
  return walk(SRC_ROOT).filter((f) => f !== MODULE_PATH && f !== THIS_TEST);
}

describe("META_GRAPH_VERSION — the one pin", () => {
  it("is a vMAJOR.MINOR Graph API version at or past v25 (v20.0 sunsets 2026-09-24)", () => {
    expect(META_GRAPH_VERSION).toMatch(/^v\d+\.\d+$/);
    const major = Number(META_GRAPH_VERSION.slice(1).split(".")[0]);
    expect(major).toBeGreaterThanOrEqual(25);
  });

  it("metaGraphUrl builds graph.facebook.com/<version>/<path> and tolerates a leading slash", () => {
    expect(metaGraphUrl("me/accounts?access_token=x")).toBe(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts?access_token=x`,
    );
    expect(metaGraphUrl("/123/insights")).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}/123/insights`);
  });

  it("the OAuth dialog and token URLs ride the same version", () => {
    expect(META_OAUTH_DIALOG_URL).toBe(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
    expect(META_OAUTH_TOKEN_URL).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);
  });
});

describe("no Meta Graph call bypasses the pin", () => {
  // Built by concatenation so this file's own text never matches the sweep.
  const OLD_PIN = "v20" + ".0";

  it(`no literal ${OLD_PIN} remains anywhere in src/`, () => {
    const offenders = sourcesToSweep().filter((f) => readFileSync(f, "utf8").includes(OLD_PIN));
    expect(offenders.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });

  it("no source outside meta-graph.ts hard-codes a versioned facebook.com URL", () => {
    // Matches `graph.facebook.com/v12.3/…` and `www.facebook.com/v12.3/…` literals alike.
    const versioned = /facebook\.com\/v\d+\.\d+/;
    const offenders = sourcesToSweep().filter((f) => versioned.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });

  it("no source outside meta-graph.ts builds an UNversioned graph.facebook.com URL either", () => {
    // An unversioned call silently falls to the app's oldest available version —
    // the callback route's profile lookup used to do exactly that.
    const unversioned = /graph\.facebook\.com\/(?!\$\{)/;
    const offenders = sourcesToSweep().filter((f) => unversioned.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });
});
