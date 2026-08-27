import { vi, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Must be hoisted before any import that transitively pulls in server-only.
vi.mock("server-only", () => ({}));

import { VENDOR_CAPABILITIES, missingCapabilities, vendorSupports } from "../capabilities";
import { AI_ROLES, AI_ROLE_NAMES, declaredSiteCount, roleSpec } from "../roles";
import {
  ProviderWiringError,
  aiFor,
  assertManifestWirable,
  assertVendorsBindable,
  defaultVendor,
  modelIdFor,
  vendorForRole,
} from "../provider";

/**
 * The assertion this file exists to prove can fail.
 *
 * A wiring guard nobody has watched fail is worth nothing — this repo has found
 * six checks that were structurally incapable of failing, so the first test
 * below configures the vendor that cannot serve the manifest and asserts the
 * refusal, by name and by site.
 */

describe("the vendor capability matrix matches the installed SDKs", () => {
  it("gives Vertex web_search but NOT web_fetch", () => {
    expect(vendorSupports("vertex", "web_search")).toBe(true);
    expect(vendorSupports("vertex", "web_fetch")).toBe(false);
  });

  it("gives first-party Anthropic both", () => {
    expect(VENDOR_CAPABILITIES.anthropic).toEqual(["web_search", "web_fetch"]);
  });

  it("agrees with @ai-sdk/google-vertex's own type declaration", () => {
    // The matrix is the thing most likely to rot. Rather than trusting the
    // comment that cites this file, read it: if a future SDK version adds web
    // fetch on Vertex, this test fails and the matrix gets updated — which is
    // the one-line change that unblocks nine call sites.
    const dts = path.join(
      process.cwd(),
      "node_modules/@ai-sdk/google-vertex/dist/anthropic/index.d.ts",
    );
    const src = fs.readFileSync(dts, "utf8");
    expect(src).toContain("webSearch_20250305");
    expect(src).not.toContain("webFetch");
  });
});

describe("assertManifestWirable refuses a vendor that cannot serve the manifest", () => {
  it("passes on anthropic — today's configuration", () => {
    expect(() => assertManifestWirable("anthropic")).not.toThrow();
  });

  it("THROWS on vertex, because nine roles depend on web_fetch", () => {
    expect(() => assertManifestWirable("vertex")).toThrow(ProviderWiringError);
  });

  it("names every failing role and its call sites, not just the first", () => {
    let message = "";
    try {
      assertManifestWirable("vertex");
    } catch (e) {
      message = (e as Error).message;
    }

    // Four roles, nine sites, all of them web_fetch-dependent.
    for (const role of [
      "intel.report.pass",
      "intel.research.agent",
      "seo.site_audit",
      "branding.fetch_site",
    ]) {
      expect(message).toContain(role);
    }
    expect(message).toContain("4 roles cannot be wired");
    // The sites are in the message so the reader does not have to go looking.
    // Taken from the manifest rather than hardcoded: line numbers move whenever
    // a file's imports change, and a test that pins them fails on the sweep
    // rather than on the thing it is meant to police.
    for (const site of roleSpec("seo.site_audit").sites) expect(message).toContain(site);
    for (const site of roleSpec("intel.research.agent").sites) expect(message).toContain(site);
  });

  it("does NOT fail the two web_search-only roles — they can route to Vertex", () => {
    let message = "";
    try {
      assertManifestWirable("vertex");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("x_agent.research");
    expect(message).not.toContain("branding.search_brand");
  });

  it("does NOT fail the measurement role — its pin holds against the default", () => {
    let message = "";
    try {
      assertManifestWirable("vertex");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("geo.capture.claude");
    expect(vendorForRole("geo.capture.claude", "vertex")).toBe("anthropic");
  });
});

describe("importing the module is itself the refusal", () => {
  /**
   * The assertion at the bottom of provider.ts is the one that actually protects
   * anything — the exported function is only reachable if someone chooses to call
   * it. Every test above runs with AI_VENDOR unset, so that import-time guard
   * never fires and would sit here looking correct forever.
   *
   * These two force it, in both directions.
   */
  it("throws on import when AI_VENDOR=vertex, before anything can serve a request", async () => {
    vi.resetModules();
    vi.stubEnv("AI_VENDOR", "vertex");
    await expect(import("../provider")).rejects.toThrow(/cannot be wired to vendor "vertex"/);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("imports cleanly when AI_VENDOR is unset", async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    await expect(import("../provider")).resolves.toBeDefined();
  });
});

describe("pins survive the default vendor", () => {
  it("keeps the GEO capture on anthropic and states why in the manifest", () => {
    const pin = AI_ROLES["geo.capture.claude"].pinnedTo;
    expect(pin?.vendor).toBe("anthropic");
    expect(pin?.because).toMatch(/measurement/i);
  });

  it("lets every unpinned role follow the default", () => {
    expect(vendorForRole("asset.title", "vertex")).toBe("vertex");
    expect(vendorForRole("asset.title", "anthropic")).toBe("anthropic");
  });
});

describe("defaultVendor", () => {
  it("is anthropic when AI_VENDOR is unset — exactly today's behaviour", () => {
    expect(defaultVendor({})).toBe("anthropic");
  });

  it("treats an empty string as unset", () => {
    expect(defaultVendor({ AI_VENDOR: "  " })).toBe("anthropic");
  });

  it("refuses an unknown vendor rather than silently defaulting", () => {
    expect(() => defaultVendor({ AI_VENDOR: "bedrock" })).toThrow(ProviderWiringError);
  });
});

describe("aiFor", () => {
  it("wires a plain role with no tools", () => {
    const resolved = aiFor("asset.title", { vendor: "anthropic" });
    expect(resolved.vendor).toBe("anthropic");
    expect(Object.keys(resolved.tools)).toEqual([]);
  });

  it("wires the declared tools for a coupled role", () => {
    const resolved = aiFor("intel.research.agent", {
      vendor: "anthropic",
      budgets: { web_search: { maxUses: 8 }, web_fetch: { maxUses: 6 } },
    });
    expect(Object.keys(resolved.tools).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("refuses to wire a web_fetch role to vertex, at wiring time", () => {
    expect(() => aiFor("seo.site_audit", { vendor: "vertex" })).toThrow(
      /requires "web_fetch", which vendor "vertex" cannot supply/,
    );
  });

  it("reports capability failure BEFORE bindability, so the durable finding is not masked", () => {
    // Both are true of seo.site_audit on vertex. The capability one is the
    // product constraint and must be the message the caller sees.
    expect(() => aiFor("seo.site_audit", { vendor: "vertex" })).toThrow(/cannot supply/);
    expect(() => aiFor("seo.site_audit", { vendor: "vertex" })).not.toThrow(/cannot be bound/);
  });

  it("refuses a capability-clean role on vertex for the DEPENDENCY reason, naming it", () => {
    // x_agent.research needs only web_search, which vertex has — so the only
    // thing stopping it is the SDK version, and the error must say so.
    expect(() => aiFor("x_agent.research", { vendor: "vertex" })).toThrow(
      /cannot be bound[\s\S]*provider@3/,
    );
  });

  it("refuses a budget for a capability the role never declared", () => {
    expect(() =>
      // asset.title declares nothing; passing a web_search budget means the call
      // site is about to use a tool the manifest cannot see.
      aiFor("asset.title", { vendor: "anthropic", budgets: { web_search: { maxUses: 3 } } }),
    ).toThrow(/does not declare it in roles.ts/);
  });

  it("requires a modelId for a caller-tier role", () => {
    expect(() => aiFor("chat.client", { vendor: "anthropic" })).toThrow(/needs an explicit modelId/);
    expect(() =>
      aiFor("chat.client", { vendor: "anthropic", modelId: "claude-sonnet-4-6" }),
    ).not.toThrow();
  });

  it("refuses a modelId on a tiered role, so the per-vendor id map cannot be bypassed", () => {
    expect(() =>
      aiFor("asset.title", { vendor: "anthropic", modelId: "claude-haiku-4-5-20251001" }),
    ).toThrow(/would bypass/);
  });
});

describe("per-vendor model ids", () => {
  it("uses Vertex's @-separated snapshot id, not the first-party one", () => {
    // The failure this prevents is a 404 at request time from reusing
    // MODELS.HAIKU verbatim on Vertex. Checked through modelIdFor because the
    // vertex model itself cannot be BOUND on this dependency set.
    expect(modelIdFor("asset.title", "anthropic")).toBe("claude-haiku-4-5-20251001");
    expect(modelIdFor("asset.title", "vertex")).toBe("claude-haiku-4-5@20251001");
    expect(modelIdFor("chat.client", "vertex")).toBeNull();
  });
});

describe("bindability is a separate check from capability", () => {
  it("passes for anthropic", () => {
    expect(() => assertVendorsBindable("anthropic")).not.toThrow();
  });

  it("refuses vertex and names the exact dependency conflict", () => {
    expect(() => assertVendorsBindable("vertex")).toThrow(ProviderWiringError);
    expect(() => assertVendorsBindable("vertex")).toThrow(/ai 6->7/);
  });

  it("still refuses vertex even though the pinned measurement role is fine", () => {
    // geo.capture.claude pins to anthropic, so a naive "are all vendors ok"
    // check that only looked at pins would pass. It must look at what roles
    // ACTUALLY resolve to.
    expect(() => assertVendorsBindable("vertex")).toThrow(/"vertex"/);
  });
});

describe("the manifest does not drift from the tree", () => {
  it("declares exactly 43 call sites", () => {
    expect(declaredSiteCount()).toBe(43);
  });

  it("names only files that exist", () => {
    for (const role of AI_ROLE_NAMES) {
      for (const site of roleSpec(role).sites) {
        const file = site.replace(/:\d+$/, "");
        expect(fs.existsSync(path.join(process.cwd(), file)), `${role} -> ${file}`).toBe(true);
      }
    }
  });

  it("covers every model call site in src/ — no site left undeclared", () => {
    // Counts both the pre-sweep form and the post-sweep form, so this assertion
    // keeps working through T-B2 instead of having to be rewritten by the change
    // it is supposed to be policing.
    const root = path.join(process.cwd(), "src");
    let found = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "ai") continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          found += (src.match(/(?<![\w.])anthropic\(/g) ?? []).length;
          found += (src.match(/(?<![\w.])aiFor\(/g) ?? []).length;
        }
      }
    };
    walk(root);
    expect(found).toBe(declaredSiteCount());
  });

  it("declares a capability for every coupled site and none for the plain ones", () => {
    const coupled = AI_ROLE_NAMES.filter((r) => (roleSpec(r).requires ?? []).length > 0);
    const sites = coupled.reduce((n, r) => n + roleSpec(r).sites.length, 0);
    expect(sites).toBe(12); // 1 measurement + 9 web_fetch + 2 web_search-only
    expect(declaredSiteCount() - sites).toBe(31);
  });

  it("has no role requiring a capability no vendor can supply", () => {
    for (const role of AI_ROLE_NAMES) {
      const requires = roleSpec(role).requires ?? [];
      const servable = (["anthropic", "vertex"] as const).some(
        (v) => missingCapabilities(v, requires).length === 0,
      );
      expect(servable, `${role} requires something no vendor has`).toBe(true);
    }
  });
});

describe("the invariant: nothing reaches a vendor except through the layer", () => {
  /**
   * The check that stops the 44th call site being written the old way.
   *
   * The allowed set is DERIVED from the manifest, not hardcoded here — a file
   * may import a vendor only because it owns a role that declares a capability,
   * and the reason for that lives in roles.ts next to the declaration. Adding a
   * file to the allowlist therefore means adding a declared, reasoned role,
   * which is the whole design.
   */
  const vendorImport = /(?:from\s+"@ai-sdk\/(?:anthropic|google-vertex)[^"]*"|await\s+import\("@ai-sdk\/[^"]+"\))/;

  /** Files that own at least one capability-declaring role. */
  const coupledFiles = new Set(
    AI_ROLE_NAMES.filter((r) => (roleSpec(r).requires ?? []).length > 0)
      .flatMap((r) => roleSpec(r).sites)
      .map((s) => s.replace(/:\d+$/, "")),
  );

  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "__tests__") continue;
          walk(full);
        } else if (/\.tsx?$/.test(e.name)) {
          out.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    return out;
  }

  it("keeps the coupled set at exactly the six files that declare a capability", () => {
    expect([...coupledFiles].sort()).toEqual([
      "src/lib/actions/x-agent-actions.ts",
      "src/lib/branding.ts",
      "src/lib/intel/pipeline.ts",
      "src/lib/intel/report.ts",
      "src/lib/intel/seo-geo-providers.ts",
      "src/lib/intel/seo-geo.ts",
    ]);
  });

  it("lets no other file in src/ import a model vendor directly", () => {
    const offenders = sourceFiles().filter(
      (f) =>
        !f.startsWith("src/lib/ai/") &&
        !coupledFiles.has(f) &&
        vendorImport.test(fs.readFileSync(path.join(process.cwd(), f), "utf8")),
    );
    // Message names the fix, because the person who trips this will be adding a
    // call site and needs to know the alternative, not just the rule.
    expect(
      offenders,
      `these import a model vendor directly instead of calling aiFor():\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("leaves no call site constructing a model outside the layer", () => {
    const offenders = sourceFiles().filter(
      (f) =>
        !f.startsWith("src/lib/ai/") &&
        !coupledFiles.has(f) &&
        /(?<![\w.])anthropic\(/.test(fs.readFileSync(path.join(process.cwd(), f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("has swept every plain site — no plain role still points at a raw vendor call", () => {
    for (const role of AI_ROLE_NAMES) {
      const spec = roleSpec(role);
      if ((spec.requires ?? []).length > 0) continue;
      for (const site of spec.sites) {
        const [file, line] = [site.replace(/:\d+$/, ""), Number(site.match(/:(\d+)$/)![1])];
        const text = fs
          .readFileSync(path.join(process.cwd(), file), "utf8")
          .split(/\r?\n/)[line - 1];
        expect(text, `${role} at ${site}`).toContain(`aiFor("${role}"`);
      }
    }
  });
});
