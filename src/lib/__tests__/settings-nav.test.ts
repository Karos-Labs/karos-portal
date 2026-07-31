import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Navigation guards for the settings surfaces. All three of these were live
 * defects on 30 Jul and all three are invisible to a type check, so they are
 * pinned from the sources themselves — the same source-assertion style
 * agent-identity-surfaces.test.ts uses for wiring that no unit can observe.
 *
 *  1. A client on a phone could not sign out at all: the only LogoutButton they
 *     could reach hung off the desktop rail, which is display:none below md.
 *  2. "Account settings" sat beside the settings row as a header link instead
 *     of in it.
 *  3. `?tab=` was read by the page and written by the tab strip, but no link in
 *     the app ever set it, so "Credits" and "Manage channels" both landed on
 *     whichever tab survived role filtering first.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const RAIL = "src/components/client-rail.tsx";
const TABS = "src/components/settings-tabs.tsx";
const SETTINGS_PAGE = "src/app/(app)/clients/[id]/settings/page.tsx";

/** The subtree that renders below `md`, where the desktop rail is hidden. */
function mobileSheetOf(rel: string): string {
  const src = source(rel);
  const open = src.indexOf("<MobileCompanySheet");
  const close = src.indexOf("</MobileCompanySheet>");
  expect(open, `${rel} has no MobileCompanySheet`).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return src.slice(open, close);
}

describe("a client can sign out at phone width", () => {
  it("mounts a sign-out control inside the client rail's mobile sheet", () => {
    expect(source(RAIL)).toContain('import { LogoutButton } from "@/components/logout-button"');
    expect(mobileSheetOf(RAIL)).toContain("<LogoutButton compact />");
  });

  it("does not rely on the account menu, which the sheet does not mount", () => {
    // AccountMenu — the only other LogoutButton mount a client can reach — is
    // in the `md:block` aside. If it ever moves into the sheet this assertion
    // should be revisited, not deleted: the sheet still needs its own control.
    expect(mobileSheetOf(RAIL)).not.toContain("<AccountMenu");
    expect(source(RAIL)).toContain("md:block");
  });

  it("mirrors the staff shell, which already carries sign-out in its sheet", () => {
    expect(mobileSheetOf("src/components/sidebar.tsx")).toContain("<LogoutButton compact />");
  });
});

describe("account settings is the last entry of the settings row", () => {
  const page = source(SETTINGS_PAGE);

  it("appends it after the role-filtered sections", () => {
    const row = page.slice(page.indexOf("const tabs: SettingsTab[] = ["));
    const entry = row.slice(0, row.indexOf("];"));
    expect(entry).toContain("...sections,");
    expect(entry).toContain('label: "Account settings"');
    expect(entry).toContain('href: "/settings"');
    // Last, not first: the spread has to precede the entry.
    expect(entry.indexOf("...sections,")).toBeLessThan(entry.indexOf('label: "Account settings"'));
  });

  it("no longer strands it beside the row as a header action", () => {
    const header = page.slice(page.indexOf("<PageHeader"), page.indexOf("<SettingsTabs"));
    expect(header).not.toContain("Account settings");
    expect(header).not.toContain("action=");
  });

  it("renders a row entry with an href as a link, never as a tab", () => {
    const tabs = source(TABS);
    expect(tabs).toContain("href?: string");
    // An anchor that leaves the page must not claim a tab's semantics, and a
    // tablist's owned children must all be tabs — so the link renders OUTSIDE
    // the role="tablist" element. Asserted on the rendered structure rather
    // than on one spelling of the branch, so a refactor of the JSX that keeps
    // both guarantees does not fail here.
    const tablist = tabs.slice(tabs.indexOf('role="tablist"'), tabs.indexOf("</div>", tabs.indexOf('role="tablist"')));
    expect(tablist).not.toContain("<Link");
    expect(tablist).toContain('role="tab"');

    const linkEntry = tabs.slice(tabs.indexOf("<Link"), tabs.indexOf("</Link>"));
    expect(linkEntry).toContain("href={tab.href");
    expect(linkEntry).not.toContain('role="tab"');
    expect(linkEntry).not.toContain("aria-selected");
  });

  it("keeps selection, the default tab and ?tab= over panels only", () => {
    const tabs = source(TABS);
    expect(tabs).toContain("const panels = tabs.filter((t) => !t.href)");
    expect(tabs).toContain("const fallback = panels[0]?.id ?? \"\"");
    expect(tabs).toContain("const current = panels.find((t) => t.id === active) ?? panels[0]");
  });
});

describe("deep links name their tab", () => {
  // The tab strip leaves the FIRST tab out of the URL, and the first tab after
  // role filtering differs by role — so every one of these has to name its tab
  // explicitly rather than trusting an index.
  const CHANNELS: Array<[string, string]> = [
    ["src/components/ai-insights.tsx", "Connect a channel"],
    ["src/components/client-analytics.tsx", "Manage"],
    ["src/app/(app)/clients/[id]/agents/[agentId]/page.tsx", "Manage connections"],
    ["src/app/(app)/clients/[id]/agents/page.tsx", "Manage integrations"],
  ];

  it.each(CHANNELS)("%s links to the channels tab (%s)", (rel) => {
    expect(source(rel)).toContain("/settings?tab=channels");
  });

  it("client-analytics sets it on both the Manage link and the reconnect badge", () => {
    const src = source("src/components/client-analytics.tsx");
    // Every settings href in the file, not just the two that were fixed — a
    // third one added later without a tab should fail here.
    const hrefs = src.match(/\/settings[a-z?=]*/g) ?? [];
    expect(hrefs).toHaveLength(2);
    expect(hrefs.every((h) => h === "/settings?tab=channels")).toBe(true);
  });

  it("both credits pills in the client rail open the Credits tab", () => {
    const rail = source(RAIL);
    expect(rail.match(/\?tab=credits/g)).toHaveLength(2);
    // The plain Settings row in the sheet stays plain — it is the whole page.
    expect(rail).toContain("href={settingsItem.href}");
  });

  it("the admin low-credits list opens the Credits tab", () => {
    expect(source("src/app/(app)/admin/analytics/page.tsx")).toContain("/settings?tab=credits");
  });

  it("the tab ids used by those links are real tabs on the settings page", () => {
    const page = source(SETTINGS_PAGE);
    expect(page).toContain('{ id: "credits", label: "Credits"');
    expect(page).toContain('{ id: "channels", label: "Channels"');
  });
});

describe("the lab repo slug link points at a field that exists", () => {
  it("does not send staff to settings, which has no such field", () => {
    const agents = source("src/app/(app)/clients/[id]/agents/page.tsx");
    expect(agents).not.toContain("Set the lab-repo slug");
    expect(agents).not.toContain("lab-repo slug in Settings");
    // It lives in the Clients page's Edit dialog, and the copy says so.
    expect(agents).toContain("Edit dialog on the Clients page");
    expect(source("src/components/clients-grid.tsx")).toContain("Lab repo slug");
  });

  it("has no such field on the settings page, which is why the link was false", () => {
    expect(source(SETTINGS_PAGE)).not.toContain("Lab repo slug");
  });
});
