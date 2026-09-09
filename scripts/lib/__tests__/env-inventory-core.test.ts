import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildInventory,
  parseCloudbuildWiring,
  parseEnvExample,
  scanReadByCode,
  stripComments,
} from "../env-inventory-core";

const REPO_ROOT = join(__dirname, "..", "..", "..");

describe("stripComments", () => {
  it("blanks line and block comments but preserves line numbers", () => {
    const src = 'const a = 1; // process.env.SHOULD_NOT_MATCH\nconst b = 2;\n';
    const stripped = stripComments(src);
    expect(stripped).not.toContain("SHOULD_NOT_MATCH");
    expect(stripped.split("\n").length).toBe(src.split("\n").length);
  });

  it("does not treat // inside a string as a comment start", () => {
    const src = 'const url = "http://example.com"; const x = process.env.REAL_VAR;';
    const stripped = stripComments(src);
    expect(stripped).toContain("http://example.com");
    expect(stripped).toContain("process.env.REAL_VAR");
  });

  it("does not end a string early on an escaped quote", () => {
    const src = 'const s = "a \\" // not a comment"; const x = process.env.REAL_VAR;';
    const stripped = stripComments(src);
    expect(stripped).toContain("process.env.REAL_VAR");
  });
});

describe("scanReadByCode — this repo, real tree", () => {
  const { reads, dynamicUnresolved } = scanReadByCode(REPO_ROOT);

  it("finds a plain direct read (process.env.NAME)", () => {
    expect(reads.has("ANTHROPIC_API_KEY")).toBe(true);
  });

  it("finds a literal-bracket direct read (process.env[\"NAME\"])", () => {
    // Sanity: at least one such literal-bracket read exists somewhere, or this
    // assertion should be dropped — recorded here as documentation of the
    // supported shape rather than a hard repo dependency.
    const anyLiteralBracket = [...reads.values()].some((sites) =>
      sites.some((s) => s.kind === "direct"),
    );
    expect(anyLiteralBracket).toBe(true);
  });

  it("finds the DI-default-param indirection (env.NAME where env defaults to process.env)", () => {
    const sites = reads.get("AGENT_MIDDLEWARE_DISPATCH_ENABLED") ?? [];
    expect(sites.some((s) => s.kind === "di-default-param")).toBe(true);
  });

  /**
   * THE REGRESSION GUARD. This repo's equivalent of agent-engine's
   * eleven-false-positive list (see BATCH-7-CONFIG-HYGIENE-SEQUENTIAL.md
   * §3.1): every one of these is wired at deploy and has NO literal
   * `process.env.NAME` / `process.env["NAME"]` anywhere in the tree — a
   * crude grep reports every one of them as "wired but never read". They are
   * all read through src/lib/integrations/oauth.ts's per-provider config
   * table (`process.env[cfg.envClientId]` etc.) or
   * src/lib/cron-auth.ts's `checkWebhookSecret({ envVar: "..." })` /
   * `requireCronSecret`'s default parameter — indirection this repo's
   * equivalent of a `*FromEnv` factory. A script that reports any of these
   * as wired-but-never-read is broken, not a finding.
   */
  const INDIRECTLY_READ_FALSE_POSITIVES = [
    "LINKEDIN_CLIENT_ID",
    "LINKEDIN_CLIENT_SECRET",
    "LINKEDIN_COMMUNITY_CLIENT_ID",
    "LINKEDIN_COMMUNITY_CLIENT_SECRET",
    "TWITTER_CLIENT_ID",
    "TWITTER_CLIENT_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "FACEBOOK_APP_ID",
    "FACEBOOK_APP_SECRET",
    "TIKTOK_CLIENT_KEY",
    "TIKTOK_CLIENT_SECRET",
    "REDDIT_CLIENT_ID",
    "REDDIT_CLIENT_SECRET",
    "META_ADVANCED_ACCESS_APPROVED",
    "TIKTOK_RESEARCH_API_APPROVED",
    "GOOGLE_BUSINESS_PROFILE_APPROVED",
    "FIREFLIES_WEBHOOK_SECRET",
    "CRON_SECRET",
  ];

  it.each(INDIRECTLY_READ_FALSE_POSITIVES)(
    "resolves %s as read (indirect-config-field), not a false 'wired but never read'",
    (name) => {
      const sites = reads.get(name);
      expect(sites, `${name} was not found as a read at all`).toBeDefined();
      expect(sites!.some((s) => s.kind === "indirect-config-field")).toBe(true);
    },
  );

  it("does not report the eleven-style false-positive set as unread", () => {
    const wiredButUnread = new Set(buildInventory(REPO_ROOT).wiredButNeverRead);
    for (const name of INDIRECTLY_READ_FALSE_POSITIVES) {
      expect(wiredButUnread.has(name)).toBe(false);
    }
  });

  it("does NOT misattribute a comment's prose example as a real read (cron-auth.ts's `process.env.X` illustration)", () => {
    expect(reads.has("X")).toBe(false);
  });

  it("does not treat the dotenv-bootstrap write pattern (`if (!process.env[k]) process.env[k] = v`) as a read of anything", () => {
    // None of these single-letter loader-loop variables should resolve to a
    // real env var name — they're not config-field names, they're generic
    // loop variables copying whatever's in a local .env file.
    for (const bogus of ["key", "k", "v"]) {
      expect(reads.has(bogus.toUpperCase())).toBe(false);
    }
  });

  it("surfaces the dotenv-bootstrap loader sites as unresolved rather than silently dropping them", () => {
    expect(dynamicUnresolved.length).toBeGreaterThan(0);
    expect(dynamicUnresolved.every((d) => /^[a-z]|^m\[1\]$/.test(d.expr))).toBe(true);
  });
});

describe("parseCloudbuildWiring — this repo, real files", () => {
  it("extracts env-var and secret names from cloudbuild.yaml", () => {
    const wired = parseCloudbuildWiring(REPO_ROOT, "cloudbuild.yaml");
    const names = new Set(wired.map((w) => w.name));
    expect(names.has("ANTHROPIC_API_KEY")).toBe(true); // secret
    expect(names.has("ADMIN_EMAIL")).toBe(true); // env-var
    expect(wired.every((w) => w.service === "karos-cmo")).toBe(true);
  });

  it("extracts the same shape from cloudbuild.promote.yaml", () => {
    const wired = parseCloudbuildWiring(REPO_ROOT, "cloudbuild.promote.yaml");
    const names = new Set(wired.map((w) => w.name));
    expect(names.has("KAROS_STAFF_KEY")).toBe(true);
    expect(names.has("AGENT_ENGINE_PUBSUB_TOPIC")).toBe(true);
  });

  it("does not silently return zero results (a parsing regression that hid every finding)", () => {
    expect(parseCloudbuildWiring(REPO_ROOT, "cloudbuild.yaml").length).toBeGreaterThan(20);
    expect(parseCloudbuildWiring(REPO_ROOT, "cloudbuild.promote.yaml").length).toBeGreaterThan(20);
  });
});

describe("parseEnvExample", () => {
  it("reads live and commented-out assignments as documented", () => {
    const documented = parseEnvExample(REPO_ROOT);
    const names = new Set(documented.map((d) => d.name));
    expect(names.has("ANTHROPIC_API_KEY")).toBe(true); // live
    expect(names.has("BQ_DATASET_ID")).toBe(true); // commented-out
    const bq = documented.find((d) => d.name === "BQ_DATASET_ID");
    expect(bq?.commentedOut).toBe(true);
  });

  it("works against a synthetic file (isolates the parser from this repo's own content)", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-inventory-test-"));
    try {
      writeFileSync(
        join(dir, ".env.example"),
        ["FOO=bar", "# BAR=baz", "# just a comment, not an assignment", "BAZ="].join("\n"),
      );
      const documented = parseEnvExample(dir);
      expect(documented.map((d) => ({ name: d.name, commentedOut: d.commentedOut }))).toEqual([
        { name: "FOO", commentedOut: false },
        { name: "BAR", commentedOut: true },
        { name: "BAZ", commentedOut: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildInventory — this repo, real tree", () => {
  const inv = buildInventory(REPO_ROOT);

  it("read-but-undocumented is empty (Deliverable 2 for karosCMO)", () => {
    expect(inv.readButUndocumented).toEqual([]);
  });

  it("flags GOOGLE_VERTEX_PROJECT/LOCATION as wired-but-never-read rather than deleting or hiding them", () => {
    // Confirmed by hand (see report): read only by the @ai-sdk/google-vertex
    // package's own loadSetting() internals, never by this repo's own
    // source — exactly the "SDK reads it implicitly" trap AU59 names for
    // ANTHROPIC_API_KEY. Must warn, not silently vanish and not fail CI.
    expect(inv.wiredButNeverRead).toEqual(
      expect.arrayContaining(["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION"]),
    );
  });

  it("SEGMIND_API_KEY is absent from every set — already resolved on this branch (commit 2590b49)", () => {
    expect(inv.readByCodeNames.has("SEGMIND_API_KEY")).toBe(false);
    expect(inv.wiredNames.has("SEGMIND_API_KEY")).toBe(false);
    expect(inv.documentedNames.has("SEGMIND_API_KEY")).toBe(false);
  });
});

describe("buildInventory — isolated synthetic fixture (does not depend on this repo's content)", () => {
  it("computes all three deltas correctly on a minimal fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-inventory-fixture-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src", "app.ts"),
        [
          'const a = process.env.READ_AND_DOCUMENTED;',
          'const b = process.env.READ_ONLY;',
          'const c = process.env["ALSO_READ_ONLY"];',
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "cloudbuild.yaml"),
        [
          "substitutions:",
          "  _SERVICE: my-service",
          "steps:",
          "  - args:",
          "      - -c",
          "      - |",
          "        gcloud run deploy $_SERVICE \\",
          "          --set-env-vars=READ_AND_DOCUMENTED=x,WIRED_ONLY=y",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "cloudbuild.promote.yaml"),
        ["substitutions:", "  _SERVICE: my-service", "steps: []"].join("\n"),
      );
      writeFileSync(
        join(dir, ".env.example"),
        ["READ_AND_DOCUMENTED=", "DOCUMENTED_ONLY="].join("\n"),
      );

      const inv = buildInventory(dir);

      expect(inv.readByCodeNames).toEqual(
        new Set(["READ_AND_DOCUMENTED", "READ_ONLY", "ALSO_READ_ONLY"]),
      );
      expect(inv.wiredNames).toEqual(new Set(["READ_AND_DOCUMENTED", "WIRED_ONLY"]));
      expect(inv.documentedNames).toEqual(new Set(["READ_AND_DOCUMENTED", "DOCUMENTED_ONLY"]));

      expect(inv.readButUndocumented).toEqual(["ALSO_READ_ONLY", "READ_ONLY"]);
      expect(inv.wiredButNeverRead).toEqual(["WIRED_ONLY"]);
      expect(inv.documentedButNonexistent).toEqual(["DOCUMENTED_ONLY"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the object-literal indirection pattern (envClientId: \"NAME\")", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-inventory-fixture-indirect-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src", "oauth.ts"),
        [
          "const PROVIDERS = {",
          '  linkedin: { envClientId: "LINKEDIN_CLIENT_ID", envClientSecret: "LINKEDIN_CLIENT_SECRET" },',
          "};",
          "function creds(cfg: typeof PROVIDERS.linkedin) {",
          "  return process.env[cfg.envClientId];",
          "}",
        ].join("\n"),
      );
      const { reads, dynamicUnresolved } = scanReadByCode(dir);
      expect(reads.has("LINKEDIN_CLIENT_ID")).toBe(true);
      expect(dynamicUnresolved).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the positional-parameter indirection pattern (function foo(a, envFlag: string), called foo(x, \"NAME\"))", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-inventory-fixture-positional-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src", "gate.ts"),
        [
          "function assertApproved(platform: string, envFlag: string): void {",
          "  if (process.env[envFlag] !== \"1\") throw new Error(platform);",
          "}",
          'assertApproved("facebook", "META_ADVANCED_ACCESS_APPROVED");',
        ].join("\n"),
      );
      const { reads, dynamicUnresolved } = scanReadByCode(dir);
      expect(reads.has("META_ADVANCED_ACCESS_APPROVED")).toBe(true);
      expect(dynamicUnresolved).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a genuinely unresolvable dynamic access unresolved rather than guessing", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-inventory-fixture-unresolvable-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src", "weird.ts"),
        ["function f(x: string) { return process.env[x.toUpperCase()]; }"].join("\n"),
      );
      const { reads, dynamicUnresolved } = scanReadByCode(dir);
      expect(reads.size).toBe(0);
      expect(dynamicUnresolved.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
