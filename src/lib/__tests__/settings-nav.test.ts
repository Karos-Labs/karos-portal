import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./source-scan";

/**
 * Navigation guards for the settings surfaces. All three of these were live
 * defects on 30 Jul and all three are invisible to a type check, so they are
 * pinned from the sources themselves — the same source-assertion style
 * agent-identity-surfaces.test.ts uses for wiring that no unit can observe.
 *
 *  1. A client on a phone could not sign out at all: the only LogoutButton they
 *     could reach hung off the desktop rail, which is display:none below md.
 *  2. "Account settings" sat beside the settings row as a header link instead
 *     of in it. It then became an entry ON the row that still navigated to a
 *     second settings page — and the product owner ruled that hop out
 *     altogether (AF-2), so the panels are tabs now and /settings redirects.
 *  3. `?tab=` was read by the page and written by the tab strip, but no link in
 *     the app ever set it, so "Credits" and "Manage channels" both landed on
 *     whichever tab survived role filtering first.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const RAIL = "src/components/client-rail.tsx";
const TABS = "src/components/settings-tabs.tsx";
const SETTINGS_PAGE = "src/app/(app)/clients/[id]/settings/page.tsx";
const ACCOUNT_PAGE = "src/app/(app)/settings/page.tsx";
/** Whitespace-normalised — JSX and long conditions reflow under prettier. */
const flat = (s: string) => s.replace(/\s+/g, " ");
/**
 * Source with the prose taken out, for the assertions that say a thing is GONE.
 * These files explain at length what they used to do and why they stopped, so
 * every removed name is still written down somewhere in them — asked of the
 * raw text, "no href on the tab strip" is a rule its own changelog fails.
 */
const code = (rel: string) => stripComments(source(rel));

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

/* ── AF-2: one settings surface per viewer ───────────────────────────────── */

describe("account settings are TABS, not a page behind a button hop", () => {
  const page = source(SETTINGS_PAGE);
  const account = source(ACCOUNT_PAGE);
  const tabs = source(TABS);

  it("mounts both account panels on the client's own settings page", () => {
    // The two panels the product owner named, on the page the rail's Settings
    // link opens — not on a second page reached from it.
    expect(page).toContain("AccountProfilePanel");
    expect(page).toContain("AccountSecurityPanel");
    expect(page).toContain('label: "Profile information"');
    expect(page).toContain('label: "Account security"');
  });

  it("offers no entry that navigates off the row", () => {
    // The hop, in every form it had: the header action it started as, and the
    // link entry it became.
    const header = page.slice(page.indexOf("<PageHeader"), page.indexOf("<SettingsTabs"));
    expect(header).not.toContain("Account settings");
    expect(header).not.toContain("action=");
    const pageCode = code(SETTINGS_PAGE);
    expect(pageCode).not.toContain('href: "/settings"');
    expect(pageCode).not.toContain('label: "Account settings"');
  });

  it("builds them for the client whose page it is, and for nobody else", () => {
    // Staff are looking at somebody else's company here; their own account is
    // /settings. A password form on a client's page would be the hop again.
    expect(flat(page)).toContain('user.role === "CLIENT_USER"');
    expect(flat(page)).toContain("const accountTabs: SettingsTab[] | null =");
  });

  it("leaves the tab strip with tabs only", () => {
    // No `href` entry means no ARIA carve-out: the tablist owns every child
    // again, and nothing on the row leaves the page.
    const tabsCode = code(TABS);
    expect(tabsCode).not.toContain("href");
    expect(tabsCode).not.toContain("<Link");
    expect(tabsCode).not.toContain("next/link");
    const tablist = tabsCode.slice(tabsCode.indexOf('role="tablist"'));
    expect(tablist).toContain('role="tab"');
  });

  it("keeps selection, the default tab and ?tab= over one list", () => {
    expect(tabs).toContain('const fallback = tabs[0]?.id ?? ""');
    expect(tabs).toContain("const current = tabs.find((t) => t.id === active) ?? tabs[0]");
  });

  it("redirects a client off the old route, carrying the tab", () => {
    // Deep links to /settings are in histories and bookmarks; they still have
    // to land on the panel they named.
    expect(account).toContain("accountSettingsHref(user.clientId, initialTab)");
    expect(flat(account)).toContain("if (href) redirect(href)");
  });

  it("keeps /settings for the viewer who has no client settings page", () => {
    // Staff, and the CLIENT_USER whose client document did not resolve — for
    // them this route is not a duplicate, it is the only one.
    expect(account).toContain("AccountProfilePanel");
    expect(account).toContain("AccountSecurityPanel");
    expect(account).toContain("<SettingsTabs");
  });

  it("names the same two tab ids at both ends of the redirect", () => {
    // The failure this guards is silent: a `?tab=` naming a tab the
    // destination does not have lands on the fallback with no error at all.
    // Both pages read the ids from the same module, so they cannot drift.
    for (const src of [page, account]) {
      expect(src).toContain('from "@/lib/account-settings-tabs"');
      expect(src).toContain("ACCOUNT_TABS.profile");
      expect(src).toContain("ACCOUNT_TABS.security");
    }
  });

  it("leaves no second tab strip behind on the panels themselves", () => {
    // The account page used to own a switcher of its own — two strips in a
    // product with one settings page.
    const form = code("src/components/settings-form.tsx");
    expect(form).not.toContain("SettingsForm");
    expect(form).not.toContain("useState<Tab>");
    expect(form).not.toContain('"Profile Information"');
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

/* ── A-5: the client "about" wall of text ────────────────────────────────── */

describe("a long client description cannot break the no-scroll rail", () => {
  /** Whitespace-normalised so a prettier rewrap cannot fail these. */
  const flat = (t: string) => t.replace(/\s+/g, " ");
  const panel = source("src/components/client-profile-panel.tsx");
  const railSrc = source(RAIL);
  const sidebarSrc = source("src/components/sidebar.tsx");

  it("clamps the description when the mount is height-constrained", () => {
    // `compact` existed and was documented, but was never passed — so every
    // surface rendered unbounded free text and the CD-E3 no-scroll contract
    // was decorative. Two lines keeps the information and the fixed height.
    expect(flat(panel)).toContain('compact && "line-clamp-2"');
  });

  it("passes compact at the no-scroll mount and not at the scrolling ones", () => {
    const mounts = [...railSrc.matchAll(/<ClientProfilePanel[^/]*\/>/g)].map((m) => m[0]);
    expect(mounts).toHaveLength(2);
    // The desktop aside is height-constrained; the mobile Company sheet scrolls.
    expect(mounts.filter((m) => m.includes("compact"))).toHaveLength(1);
    // Staff's client-context mount is ALSO a mobile Company sheet — the same
    // scrolling frame as the client's own — so it shows the same full text.
    // Clamping only there was a one-word AF-3 parity break (audit, 6547959).
    expect(sidebarSrc).toContain("<ClientProfilePanel client={clientCtx.client} />");
    expect(sidebarSrc).not.toContain("<ClientProfilePanel client={clientCtx.client} compact />");
  });

  it("still renders the description — clamped, not removed", () => {
    // An earlier comment claimed compact dropped it entirely. Hiding a client's
    // own profile text is not a fix for it being long.
    expect(flat(panel)).toContain("{client.description || client.brief}");
    expect(flat(panel)).not.toContain("!compact && (client.description");
  });
});
