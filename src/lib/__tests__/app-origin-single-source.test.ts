import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CALLBACK_ORIGIN_MISSING,
  appLinkBase,
  webhookCallbackOrigin,
} from "@/lib/app-origin";
import { stripComments } from "./source-scan";

/**
 * SCRUM-332 (AU49) follow-up: the two app origins have one reader each.
 *
 * WHAT AU49 FOUND AND PARKED. Its inventory reported `NEXT_PUBLIC_APP_URL` as
 * read by code and wired nowhere - not in cloudbuild.yaml, not in
 * cloudbuild.promote.yaml, not as a build arg - so `undefined` in every
 * deployed environment. That ticket wrote the finding into .env.example and
 * left it, calling the fix "a product/code call this config-inventory ticket
 * does not make".
 *
 * IT WAS NOT A DECISION. Nine call sites built an origin by hand, in two
 * families, and the same mistake appeared once in each:
 *
 *   callback origin (4):  AGENT_SERVICE_CALLBACK_URL ?? APP_URL              x3
 *                         AGENT_SERVICE_CALLBACK_URL ?? NEXT_PUBLIC_APP_URL  x1
 *   link base (5):        (APP_URL ?? localhost).replace(...)                x4
 *                         NEXT_PUBLIC_APP_URL ?? ""                          x1
 *
 * A variable with three correct witnesses in the same codebase - one of them
 * 700 lines up in the same file - is a typo, and .env.example's own note on
 * APP_URL explains why a NEXT_PUBLIC_ name cannot carry this value at all: a
 * NEXT_PUBLIC_ variable is inlined at `next build`, and production is promoted
 * from an already-built prep image.
 *
 * TWO LIVE SYMPTOMS, both silent:
 *   - every Jira issue filed from a meeting carried "/transcripts/<id>" with
 *     no origin, because `?? ""` renders an unset variable as empty rather
 *     than failing;
 *   - the dynamic-agent submit path had no fallback at all, and its own error
 *     message named the variable that could never be set.
 */

const SRC = path.resolve(__dirname, "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...walk(abs));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(abs);
    }
  }
  return out;
}

const FILES = walk(SRC);
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const body = (f: string) => stripComments(readFileSync(f, "utf8"));

/* ─────────────────── the name that is wired nowhere ─────────────────── */

describe("NEXT_PUBLIC_APP_URL", () => {
  it("swept a real tree", () => {
    expect(FILES.length).toBeGreaterThan(300);
  });

  it("is read by no source file", () => {
    // THE REGRESSION GUARD. This name is not merely unused - it CANNOT work,
    // for the reason .env.example gives on APP_URL. Comments may still discuss
    // it; `stripComments` is why this asks about code.
    const readers = FILES.filter((f) => body(f).includes("NEXT_PUBLIC_APP_URL")).map(rel);
    expect(readers).toEqual([]);
  });

  it("is not wired in either deploy config, which is why reading it never worked", () => {
    // Non-vacuity for the claim above: if a later change DID wire it, the
    // reasoning in this file stops applying and someone should revisit it.
    const repo = path.resolve(SRC, "..");
    for (const file of ["cloudbuild.yaml", "cloudbuild.promote.yaml"]) {
      const text = readFileSync(path.join(repo, file), "utf8");
      expect(text, `${file} now wires it`).not.toContain("NEXT_PUBLIC_APP_URL");
    }
  });
});

/* ────────────────────── one reader per origin ────────────────────── */

describe("one module owns each origin", () => {
  it("is the only place AGENT_SERVICE_CALLBACK_URL is read", () => {
    const readers = FILES.filter((f) => body(f).includes("AGENT_SERVICE_CALLBACK_URL")).map(rel);
    expect(readers).toEqual(["lib/app-origin.ts"]);
  });

  it("is the only place APP_URL is read", () => {
    const readers = FILES.filter((f) => /\benv\.APP_URL\b/.test(body(f))).map(rel);
    expect(readers).toEqual(["lib/app-origin.ts"]);
  });

  it("has all four callback sites delegating", () => {
    // A floor rather than a fixed list: more submit paths are expected. What
    // must not come back is a hand-written copy, which the two assertions
    // above already forbid.
    const callers = FILES.filter((f) => body(f).includes("webhookCallbackOrigin()")).map(rel);
    expect(callers.sort()).toEqual([
      "lib/agent-service/run-custom-agent.ts",
      "lib/jobs/submit-custom.ts",
      "lib/jobs/submit-managed.ts",
    ]);
    // submit-custom.ts holds two of the four sites.
    expect((body(path.join(SRC, "lib/jobs/submit-custom.ts")).match(/webhookCallbackOrigin\(\)/g) ?? []).length).toBe(2);
  });

  it("has all six link-base sites delegating", () => {
    // Six since SCRUM-513: the cron gate's OIDC audience is the app's origin.
    const callers = FILES.filter((f) => /\bappLinkBase\b/.test(body(f))).map(rel);
    expect(callers.sort()).toEqual([
      "app/api/daily-digest/route.ts",
      "lib/actions/user-actions.ts",
      "lib/app-origin.ts",
      "lib/cron-auth.ts",
      "lib/integrations/jira.ts",
      "lib/integrations/oauth.ts",
      "lib/job-alerts.ts",
    ]);
  });
});

/* ──────────────────────── the helpers, driven ──────────────────────── */

describe("webhookCallbackOrigin", () => {
  it("prefers the explicit callback URL", () => {
    const r = webhookCallbackOrigin({
      AGENT_SERVICE_CALLBACK_URL: "https://cb.example",
      APP_URL: "https://app.example",
    });
    expect(r).toEqual({ origin: "https://cb.example" });
  });

  it("treats an EMPTY callback URL as absent, which `??` did not", () => {
    // THE SECOND HALF OF THE BUG, and it hit all four sites including the
    // three that named the right variable. Prep's cloudbuild.yaml carries
    // `_AGENT_SERVICE_CALLBACK_URL: ""`, so the deploy sets the variable to
    // the empty string - not nullish, so `??` answered "" and APP_URL was
    // never reached.
    const r = webhookCallbackOrigin({
      AGENT_SERVICE_CALLBACK_URL: "",
      APP_URL: "https://app.example",
    });
    expect(r).toEqual({ origin: "https://app.example" });
  });

  it("errors, with a sentence naming a variable an operator can actually set", () => {
    expect(webhookCallbackOrigin({})).toEqual({ error: CALLBACK_ORIGIN_MISSING });
    expect(CALLBACK_ORIGIN_MISSING).toContain("APP_URL");
    expect(CALLBACK_ORIGIN_MISSING).not.toContain("NEXT_PUBLIC_APP_URL");
  });

  it("strips every trailing slash, not just one", () => {
    expect(webhookCallbackOrigin({ APP_URL: "https://app.example//" })).toEqual({
      origin: "https://app.example",
    });
  });

  it("refuses a value that is nothing but slashes", () => {
    // The first draft of this module stripped AFTER the emptiness check, so
    // APP_URL="/" passed as truthy and became "" - a callback posted to
    // "/api/agent-service/webhook" with no host, the same silent failure the
    // module exists to end. This test is why that lasted one minute.
    expect(webhookCallbackOrigin({ APP_URL: "/" })).toEqual({ error: CALLBACK_ORIGIN_MISSING });
    expect(webhookCallbackOrigin({ AGENT_SERVICE_CALLBACK_URL: "///" })).toEqual({
      error: CALLBACK_ORIGIN_MISSING,
    });
  });
});

describe("appLinkBase", () => {
  it("uses APP_URL when it is set", () => {
    expect(appLinkBase({ APP_URL: "https://app.example" })).toBe("https://app.example");
  });

  it("falls back to localhost, which is what all four copies did", () => {
    // A link base is not a credential: a developer running locally wants a
    // working link rather than a thrown error.
    expect(appLinkBase({})).toBe("http://localhost:3000");
    expect(appLinkBase({ APP_URL: "" })).toBe("http://localhost:3000");
  });

  it("strips every trailing slash, which oauth.ts's copy did not", () => {
    expect(appLinkBase({ APP_URL: "https://app.example//" })).toBe("https://app.example");
  });

  it("never returns an empty base, which is what the jira.ts bug produced", () => {
    for (const env of [{}, { APP_URL: "" }, { APP_URL: "/" }]) {
      expect(appLinkBase(env).length).toBeGreaterThan(0);
    }
  });
});
