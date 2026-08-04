import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  BRANDING_TOOL_REFUSAL,
  brandingToolRefusal,
  CLIENT_SAFE_COPILOT_TOOLS,
  COPILOT_TOOL_REFUSAL,
  copilotToolRefusal,
  copilotToolsFor,
  GMAIL_UNAVAILABLE_MESSAGE,
  integrationBelongsToCaller,
  isStaffCopilotActor,
} from "@/lib/copilot-tool-access";
import { clientSafeRunError, CLIENT_SAVE_REFUSAL_MESSAGE } from "@/lib/custom-agent-launch";
import type { AppUser } from "@/lib/types";

/**
 * `update_branding_guidelines` rewrites the client's `branding-guidelines`
 * context doc, which lives at the INTERNAL tier — the analyst-grade copy
 * types.ts restricts to admin/employee and every agent prompt reads as ground
 * truth. It was registered on the copilot chat route with no role check
 * anywhere, and the route is reached by BOTH docks: the client shell mounts
 * CopilotDock for a CLIENT_USER, the staff shell mounts StaffCopilotDock.
 *
 * So a client session could write internal-tier content by asking the chatbot.
 * These tests pin the two fences that now stop it.
 */

const src = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
const route = src("app/api/clients/[id]/chat/route.ts");
const access = src("lib/copilot-tool-access.ts");
/** The Gmail tool's own body, so a fence elsewhere in the route can't pass for one here. */
const gmailTool =
  /const fetchGmailContextTool = tool\(\{[\s\S]*?\n  \}\);/.exec(route)?.[0] ?? "";

const actor = (role: AppUser["role"], impersonatedBy?: string) =>
  ({ role, ...(impersonatedBy ? { impersonatedBy } : {}) }) as AppUser;

/** The registry the route hands to streamText, in the same shape. */
const ALL_TOOLS = {
  update_branding_guidelines: "branding",
  send_support_email: "support",
  fetch_gmail_context: "gmail",
  create_tasks: "tasks",
};

describe("copilot tool registry — staff-only writes", () => {
  it("withholds the branding tool from a real client session", () => {
    const tools = copilotToolsFor(actor("CLIENT_USER"), ALL_TOOLS);
    expect(tools).not.toHaveProperty("update_branding_guidelines");
  });

  it("withholds it from an admin impersonating a client", () => {
    // "View as Client" arrives as a CLIENT_USER carrying impersonatedBy
    // (auth.ts). Impersonation shows what the client sees; it is not a staff
    // capability escalator. Note this is the OPPOSITE answer to
    // isBillableClientActor, which excludes impersonated sessions so an admin's
    // preview spends no real credits — different question, opposite line, both
    // correct. (An earlier comment here claimed they matched.)
    const tools = copilotToolsFor(actor("CLIENT_USER", "admin-uid"), ALL_TOOLS);
    expect(tools).not.toHaveProperty("update_branding_guidelines");
    expect(isStaffCopilotActor(actor("CLIENT_USER", "admin-uid"))).toBe(false);
  });

  it("denies a staff role that arrives inside an impersonated session", () => {
    // Belt on the rung above: whatever role the session claims, an
    // impersonation marker means the surface being driven is the client's.
    expect(isStaffCopilotActor(actor("KAROS_ADMIN", "admin-uid"))).toBe(false);
    expect(
      copilotToolsFor(actor("KAROS_ADMIN", "admin-uid"), ALL_TOOLS),
    ).not.toHaveProperty("update_branding_guidelines");
  });

  it("is an ALLOWLIST — a newly registered tool is withheld until it is named", () => {
    // The failure mode of the denylist this replaced: register a write tool on
    // the route, forget this file, and a client session can call it. With the
    // list inverted, forgetting is the SAFE direction.
    const withNewTool = { ...ALL_TOOLS, wipe_client_data: "danger" };
    const tools = copilotToolsFor(actor("CLIENT_USER"), withNewTool);
    expect(tools).not.toHaveProperty("wipe_client_data");
    expect(copilotToolsFor(actor("KAROS_ADMIN"), withNewTool)).toHaveProperty(
      "wipe_client_data",
    );
  });

  it("keeps it for staff sessions", () => {
    for (const role of ["KAROS_ADMIN", "KAROS_EMPLOYEE"] as const) {
      expect(copilotToolsFor(actor(role), ALL_TOOLS)).toHaveProperty(
        "update_branding_guidelines",
      );
    }
  });

  it("leaves every client-safe tool in place", () => {
    const tools = copilotToolsFor(actor("CLIENT_USER"), ALL_TOOLS);
    expect(Object.keys(tools).sort()).toEqual([
      "create_tasks",
      "fetch_gmail_context",
      "send_support_email",
    ]);
  });

  it("does not mutate the registry it was handed", () => {
    const all = { ...ALL_TOOLS };
    copilotToolsFor(actor("CLIENT_USER"), all);
    expect(all).toHaveProperty("update_branding_guidelines");
  });
});

describe("copilot branding tool — execute-level refusal", () => {
  it("refuses a client actor and names the surface they can use", () => {
    expect(brandingToolRefusal(actor("CLIENT_USER"))).toBe(BRANDING_TOOL_REFUSAL);
    expect(brandingToolRefusal(actor("CLIENT_USER", "admin-uid"))).toBe(
      BRANDING_TOOL_REFUSAL,
    );
    // Actionable, not a dead end: the client's own brand panel still works.
    expect(BRANDING_TOOL_REFUSAL).toMatch(/brand panel/i);
  });

  it("lets staff through", () => {
    expect(brandingToolRefusal(actor("KAROS_ADMIN"))).toBeNull();
    expect(brandingToolRefusal(actor("KAROS_EMPLOYEE"))).toBeNull();
  });

  it("derives from the same allowlist, so a new tool is refused too", () => {
    expect(copilotToolRefusal(actor("CLIENT_USER"), "wipe_client_data")).toBe(
      COPILOT_TOOL_REFUSAL,
    );
    for (const name of CLIENT_SAFE_COPILOT_TOOLS) {
      expect(copilotToolRefusal(actor("CLIENT_USER"), name)).toBeNull();
    }
    expect(copilotToolRefusal(actor("KAROS_ADMIN"), "wipe_client_data")).toBeNull();
  });
});

/**
 * Source-text assertions, same reason as shell-chrome.test.ts: the route is a
 * server module whose import graph reaches the Admin SDK, so it cannot be
 * imported into a node test run. What they pin is that the route actually
 * WIRES the fences above — the unit tests alone would still pass if someone
 * handed streamText the raw record.
 */
describe("chat route wiring", () => {
  it("passes its tool registry through the role filter", () => {
    expect(route).toMatch(/tools:\s*copilotToolsFor\(user,\s*\{/);
  });

  it("guards the branding tool's execute before it writes", () => {
    const execute = /const updateBrandingTool = tool\(\{[\s\S]*?\n  \}\);/.exec(route)?.[0] ?? "";
    expect(execute).not.toBe("");
    const refusalAt = execute.indexOf("brandingToolRefusal");
    const writeAt = execute.indexOf("updateClient(");
    expect(refusalAt).toBeGreaterThan(-1);
    // The refusal has to come first — a guard after the write is not a guard.
    expect(refusalAt).toBeLessThan(writeAt);
  });

  it("stops swallowing the context-doc sync failure", () => {
    // `catch {}` let the copilot report a clean success while the copy the
    // agents read stayed a version behind.
    expect(route).not.toMatch(/\}\s*catch\s*\{\s*\n\s*\/\/ Non-fatal\s*\n\s*\}/);
    expect(route).toMatch(/Branding context doc sync failed/);
  });

  it("tells a client session's prompt it has no branding tool", () => {
    // Asked as "derived from the staff predicate", not as one spelling of it. The
    // route now binds that predicate once (`const viewerIsClient =
    // !isStaffCopilotActor(user)`) and passes the negation, which is the same
    // answer written once instead of twice — so pinning the old literal
    // `isStaffCopilotActor(user)` at this argument would forbid the consolidation
    // rather than the defect.
    //
    // What must stay forbidden is a CONSTANT here: `canUpdateBranding: true`
    // describes the staff tool to a client session and teaches the model to
    // promise it.
    expect(route).toMatch(/canUpdateBranding:\s*(?:!viewerIsClient|isStaffCopilotActor\(user\))/);
    expect(route).not.toMatch(/canUpdateBranding:\s*(?:true|false)\b/);
    // And the flag it is derived from is bound from the shared predicate exactly
    // once, so vocabulary and capability cannot drift to two answers.
    expect(route.match(/const viewerIsClient = !isStaffCopilotActor\(user\)/g) ?? []).toHaveLength(1);
  });

  it("hands the prompt builder the viewer, so the system string is client copy too", () => {
    // The system prompt is payload: the model paraphrases it back into the dock,
    // so `client.status` / `job.status` / `asset.type` interpolated there reach a
    // client as prose. The route has to say WHO is reading.
    expect(route).toMatch(/viewerIsClient\s*\}?\s*,?\s*\n?\s*\);/);
    expect(route).toMatch(/canUpdateBranding:[^,]+,\s*viewerIsClient/);
  });

  it("registers every allowlisted tool it claims to offer a client", () => {
    // The allowlist is only a fence if its names match the registry's keys — a
    // typo here silently withholds a tool clients are supposed to have.
    for (const name of CLIENT_SAFE_COPILOT_TOOLS) {
      expect(route).toMatch(new RegExp(`\\b${name}:\\s*\\w+Tool\\b`));
    }
  });
});

/**
 * `fetch_gmail_context` reads a real human's unread primary inbox through a token
 * stored ONE PER WORKSPACE (`${clientId}_google`) from one individual's personal
 * OAuth grant. The tool resolved it by platform alone, so in a multi-seat
 * workspace — the designed norm — user B asking the copilot to scan "their" inbox
 * was handed user A's private email, and staff opening that client's copilot got
 * it too. The grantor's verified address was already recorded in `accountName`
 * (task-actions.ts) and simply never consulted. These tests pin the gate that
 * consults it.
 */
describe("gmail grantor gate", () => {
  const granted = (accountName?: string) => ({ accountName });

  it("resolves for the person who granted the token", () => {
    expect(integrationBelongsToCaller(granted("owner@acme.com"), "owner@acme.com")).toBe(true);
  });

  it("ignores case and surrounding whitespace on both sides", () => {
    // An address is the same address either way, and a gate that leaks on a
    // stray trailing space is not a gate.
    expect(integrationBelongsToCaller(granted("Owner@Acme.com"), "owner@acme.com")).toBe(true);
    expect(integrationBelongsToCaller(granted("owner@acme.com"), "OWNER@ACME.COM")).toBe(true);
    expect(integrationBelongsToCaller(granted("  owner@acme.com  "), "owner@acme.com")).toBe(true);
    expect(integrationBelongsToCaller(granted("owner@acme.com"), " Owner@Acme.com\t")).toBe(true);
  });

  it("does not resolve for anybody else in the same workspace", () => {
    // The defect, in one line: a second seat in the same client workspace.
    expect(integrationBelongsToCaller(granted("owner@acme.com"), "colleague@acme.com")).toBe(false);
    // Nor for staff, who share no address with the grantor. Closed by default.
    expect(integrationBelongsToCaller(granted("owner@acme.com"), "staff@karoslabs.com")).toBe(false);
    // Not a prefix/substring match either.
    expect(integrationBelongsToCaller(granted("owner@acme.com"), "owner@acme.com.evil.tld")).toBe(false);
    expect(integrationBelongsToCaller(granted("owner@acme.com"), "owner@acme.co")).toBe(false);
  });

  it("FAILS CLOSED when the grant cannot be attributed to a person", () => {
    // A grant we cannot attribute is not one we may read on anyone's behalf —
    // and a blank/blank comparison must never come out equal.
    expect(integrationBelongsToCaller(granted(undefined), "owner@acme.com")).toBe(false);
    expect(integrationBelongsToCaller(granted(""), "owner@acme.com")).toBe(false);
    expect(integrationBelongsToCaller(granted("   "), "owner@acme.com")).toBe(false);
    expect(integrationBelongsToCaller(granted(undefined), undefined)).toBe(false);
    expect(integrationBelongsToCaller(granted(""), "")).toBe(false);
    expect(integrationBelongsToCaller(granted("   "), "  ")).toBe(false);
    // A caller with no address of their own resolves nothing either.
    expect(integrationBelongsToCaller(granted("owner@acme.com"), null)).toBe(false);
    expect(integrationBelongsToCaller(granted("owner@acme.com"), "")).toBe(false);
  });

  it("says nothing about roles — the gate is identity, not tier", () => {
    // Same call, same answer, whoever is asking: there is no staff parameter to
    // widen by accident. Widening is a product decision, taken on purpose.
    expect(integrationBelongsToCaller.length).toBe(2);
  });
});

describe("gmail refusal is indistinguishable from no connection", () => {
  it("is one shared string, not two that can drift apart", () => {
    // Both reasons — no grant here, and a grant that is somebody else's — return
    // this exact constant. Two copies of the same prose would be an invitation to
    // "improve" one of them into a disclosure.
    const branch = /if \(!googleIntegration\) \{[\s\S]*?\n      \}/.exec(gmailTool)?.[0] ?? "";
    expect(branch).not.toBe("");
    expect(branch).toMatch(/return GMAIL_UNAVAILABLE_MESSAGE;/);
    // Exactly one producer of the message inside the tool.
    expect(gmailTool.match(/GMAIL_UNAVAILABLE_MESSAGE/g)).toHaveLength(1);
  });

  it("has no second spelling anywhere in src, so the two reasons cannot drift", () => {
    // WHAT THIS REPLACED, and why. This assertion used to hold a full second copy
    // of the prose and demand byte-equality, "so a future edit cannot make one of
    // them leak". It bought nothing the two tests either side of it do not
    // already give — one constant, one producer, and no leak wording — and it
    // cost the thing this campaign keeps paying for: a canary pinning a SPELLING
    // blocks its own improvement. It did, immediately. The spaced hyphen ledger
    // F71 bans in client copy was inside the pinned literal, so the sweep that
    // found the hyphen could not fix it without reding a test whose subject is
    // disclosure, not punctuation.
    //
    // The property the pin was really buying is that there is only ONE spelling
    // to drift from. That is asked here as a closed question, and DERIVED from
    // the constant rather than restated: whatever the message says, no other file
    // may say it too. Improving the copy moves what is swept for.
    const opener = GMAIL_UNAVAILABLE_MESSAGE.slice(0, 60);
    expect(opener.length).toBe(60);
    // Adjacent literals joined before searching, because the message is written
    // as a `+` chain and no 60 contiguous characters of it exist in any source
    // file. Asking the raw text found NOTHING — including the constant's own
    // home — and an offender list that cannot even see the home file would have
    // read as a passing sweep. The expectation names the home for that reason.
    const joinedLiterals = (s: string) => s.replace(/"\s*\+\s*"/g, "");
    const root = path.resolve(__dirname, "../..");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        const f = path.join(dir, e);
        if (statSync(f).isDirectory()) walk(f, out);
        else if (/\.tsx?$/.test(f)) out.push(f);
      }
      return out;
    };
    const offenders = walk(root)
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => joinedLiterals(readFileSync(f, "utf8")).includes(opener))
      .map((f) => f.slice(root.length + 1).split(path.sep).join("/"));
    expect(offenders, "import GMAIL_UNAVAILABLE_MESSAGE instead of retyping it").toEqual([
      "lib/copilot-tool-access.ts",
    ]);
  });

  it("never names the grantor or hints that a token exists", () => {
    // A different message IS the disclosure — it tells user B that user A
    // connected their mail. So: no grantor, no "someone else", no "already
    // connected", no email address of any kind.
    for (const leak of [
      /connected by/i,
      /another (user|account|person)/i,
      /someone else/i,
      /a colleague/i,
      /belongs to/i,
      /not your/i,
      /different account/i,
      /already connected/i,
      /@[\w.-]+\.\w+/,
      /accountName/,
    ]) {
      expect(GMAIL_UNAVAILABLE_MESSAGE).not.toMatch(leak);
    }
  });
});

describe("chat route wires the grantor gate", () => {
  it("found the tool body it is asserting about", () => {
    // Without this the negative assertions below would pass vacuously on "" if
    // the tool were ever renamed.
    expect(gmailTool).not.toBe("");
    expect(gmailTool).toMatch(/fetchGmailMessages\(accessToken/);
  });

  it("gates the shared lookup, not just the tool body", () => {
    // Gating at the lookup is what keeps the degraded path indistinguishable:
    // `hasGmailIntegration` goes false too, so the prompt withholds Scenario D
    // and applies its silence rule. A gate inside `execute` would leave the
    // system prompt telling a non-grantor that Gmail is connected.
    const lookup =
      /const googleIntegration = integrations\.find\([\s\S]*?\);/.exec(route)?.[0] ?? "";
    expect(lookup).not.toBe("");
    expect(lookup).toMatch(/integrationBelongsToCaller\(i, user\.email\)/);
    expect(route).toMatch(/hasGmailIntegration: !!googleIntegration/);
  });

  it("has no staff bypass on the way to the mailbox", () => {
    // A token that reads one human's private mail is usable only by that human.
    // Staff access is a product call for Daniel to make deliberately, not a
    // default that survives because nobody looked.
    expect(gmailTool).not.toMatch(/isStaffCopilotActor/);
    const lookup =
      /const googleIntegration = integrations\.find\([\s\S]*?\);/.exec(route)?.[0] ?? "";
    expect(lookup).not.toMatch(/isStaffCopilotActor|role/);
  });

  it("reads the token only after the gate has resolved an integration", () => {
    const gateAt = gmailTool.indexOf("if (!googleIntegration)");
    const tokenAt = gmailTool.indexOf("googleIntegration.credentials.access_token");
    expect(gateAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(tokenAt);
  });

  it("keeps the tool on the client allowlist — the premise is fixed, not the capability", () => {
    // The wrong fix would be deleting the entry. Clients keep their own inbox
    // scan; what changed is that "their own" is now enforced.
    expect(CLIENT_SAFE_COPILOT_TOOLS).toContain("fetch_gmail_context");
    expect(copilotToolsFor(actor("CLIENT_USER"), ALL_TOOLS)).toHaveProperty(
      "fetch_gmail_context",
    );
    expect(copilotToolRefusal(actor("CLIENT_USER"), "fetch_gmail_context")).toBeNull();
  });

  it("no longer justifies the entry with the claim that was false", () => {
    // "reads the thread the client is already party to" was true only in a
    // single-seat workspace. The list's next reader must not be misled the way
    // this entry misled everyone.
    expect(access).not.toMatch(/reads the thread the client is already\s*\n?\s*\*?\s*party to/);
    expect(access).not.toMatch(/thread the client is already party to/);
    // Replaced by what is actually true after the fix.
    expect(access).toMatch(/integrationBelongsToCaller/);
    expect(access).toMatch(/caller's OWN mailbox/);
  });
});

/**
 * WHAT A CLIENT'S MODEL IS TOLD WHEN A WRITE TOOL FAILS.
 *
 * Same doctrine as #121, in the channel #121 never looked at. A tool's return
 * string is PAYLOAD: the model reads it and paraphrases it back into the dock, so
 * an interpolated exception is client-facing text no render gate can catch.
 *
 * Executed with `updateAssetAction` throwing, `edit_output` returned:
 *   "Couldn't save that: Firebase Admin is not configured. Provide
 *    FIREBASE_SERVICE_ACCOUNT_KEY, the discrete FIREBASE_* vars, or Application
 *    Default Credentials with FIREBASE_PROJECT_ID set.."
 * — env var names and credential mechanisms, to a paying client. The action also
 * throws bare "Unauthorized" / "Forbidden" / "Asset not found" on its own.
 *
 * SCOPE: the tool bodies are closures inside the route handler and are not
 * exported, so the wiring is asserted against the route's SOURCE, per-tool-body so
 * a sanitizer in one tool cannot pass for one in another. That the helpers return
 * safe words is pinned behaviourally below and in agent-launch-ui.test.ts.
 */
describe("the copilot's write tools, when the write fails", () => {
  const body = (name: string) =>
    new RegExp(`const ${name} = tool\\(\\{[\\s\\S]*?\\n  \\}\\);`).exec(route)?.[0] ?? "";
  /**
   * Comments stripped, because the ORDER assertions below are about which branch
   * runs first and a comment quoting the leaked string would satisfy them. The
   * first version of this test passed on its own docstring.
   */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const editOutput = strip(body("editOutputTool"));
  const runAgentNow = strip(body("runAgentNowTool"));
  const reschedule = strip(body("rescheduleOutputTool"));

  it("found the three tool bodies it is asserting about", () => {
    // Otherwise every negative below passes vacuously on "" — and each must still
    // contain its own failure path after comments are gone.
    expect(editOutput).toContain("catch (e)");
    expect(runAgentNow).toContain("if (result.error)");
    expect(reschedule).toContain("catch (e)");
  });

  it("hands a client no raw exception from edit_output", () => {
    // THE loosening: `return \`Couldn't save that: ${e.message}\`` with no viewer
    // branch, which is exactly what shipped. Absent from the payload beats
    // unrendered.
    expect(editOutput).toContain("CLIENT_SAVE_REFUSAL_MESSAGE");
    // The raw message may still be composed, but only on the staff side of a viewer
    // branch — so the interpolation must be preceded by the guard.
    const guardAt = editOutput.indexOf("if (viewerIsClient)");
    const rawAt = editOutput.indexOf("Couldn't save that:");
    expect(guardAt).toBeGreaterThan(-1);
    expect(rawAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(rawAt);
  });

  it("still logs the real cause, so sanitizing does not erase it", () => {
    // A silent generic sentence would trade a leak for an invisible failure.
    // Staff fix these; something has to keep the exception.
    expect(editOutput).toMatch(/console\.error\(`\[copilot\] edit_output failed/);
  });

  it("reuses the existing run-error sanitizer rather than answering a fourth time", () => {
    // `runCustomAgentAction` sanitizes internally, but behind
    // `isBillableClientActor` — which EXCLUDES an impersonating admin, so "View as
    // Client" was shown the raw config error. The boundary asks the predicate that
    // governs vocabulary instead.
    expect(runAgentNow).toContain("clientSafeRunError(result.error)");
    expect(runAgentNow).toContain("viewerIsClient");
  });

  it("leaves the staff-only reschedule branch its exception", () => {
    // Not every raw error is a leak. This one is inside
    // `if (isStaffCopilotActor(user))`, so only a real staff account reaches it, and
    // staff are owed the exception. Pinned so a later sweep cannot "fix" it and
    // blind the people who repair these.
    const staffGuardAt = reschedule.indexOf("if (isStaffCopilotActor(user))");
    const rawAt = reschedule.indexOf("Couldn't reschedule:");
    expect(staffGuardAt).toBeGreaterThan(-1);
    expect(rawAt).toBeGreaterThan(-1);
    expect(staffGuardAt).toBeLessThan(rawAt);
    // …and the CLIENT half of the same tool goes through the scoped action, whose
    // refusals are composed as client copy rather than sanitized after the fact.
    expect(reschedule).toContain("clientRescheduleAssetAction(assetId, parsed)");
  });

  it("says nothing internal in either client sentence, and does not overpromise", () => {
    // Behavioural non-vacuity for the source guards above: the words a client
    // actually gets. The real leaked string is the input, so this fails if the
    // helper ever starts passing it through.
    const leak =
      "Firebase Admin is not configured. Provide FIREBASE_SERVICE_ACCOUNT_KEY, the discrete " +
      "FIREBASE_* vars, or Application Default Credentials with FIREBASE_PROJECT_ID set.";
    for (const sentence of [CLIENT_SAVE_REFUSAL_MESSAGE, clientSafeRunError(leak)]) {
      expect(sentence).not.toContain("FIREBASE");
      expect(sentence).not.toContain("Firebase");
      expect(sentence).not.toMatch(/Unauthorized|Forbidden|Credentials|env|_KEY/);
      // Client copy rules: sentence case, em dash never " - ".
      expect(sentence).not.toContain(" - ");
      // No promise the code does not keep — nothing on these paths notifies anyone.
      expect(sentence).not.toMatch(/has been notified|we've been notified/i);
      // …and it still tells the client what they can do.
      expect(sentence).toMatch(/Karos team/);
    }
    // The two are DIFFERENT sentences, because a failed save is not a failed run —
    // reusing one would have described an event that did not happen.
    expect(CLIENT_SAVE_REFUSAL_MESSAGE).not.toBe(clientSafeRunError(leak));
    expect(CLIENT_SAVE_REFUSAL_MESSAGE).toMatch(/saved/);
    expect(clientSafeRunError(leak)).toMatch(/run/);
  });
});
