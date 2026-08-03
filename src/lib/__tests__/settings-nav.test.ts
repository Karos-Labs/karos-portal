import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./source-scan";
import {
  CLIENT_CATEGORY_MAX_LENGTH,
  clampClientCategoryValue,
  clientCategoryLabel,
} from "@/lib/utils";

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
const SIDEBAR = "src/components/sidebar.tsx";
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
  const PANEL = "src/components/client-profile-panel.tsx";
  const panel = source(PANEL);
  const railSrc = source(RAIL);
  const sidebarSrc = source(SIDEBAR);

  it("clamps the description when the mount is height-constrained", () => {
    // `compact` existed and was documented, but was never passed — so every
    // surface rendered unbounded free text and the CD-E3 no-scroll contract
    // was decorative. Two lines keeps the information and the fixed height.
    expect(flat(panel)).toContain('compact && "line-clamp-2"');
  });

  it("passes compact at the no-scroll mounts and not at the scrolling ones", () => {
    // FOUR mounts now, two per shell. Until V3 the staff shell had only the
    // one — its desktop rail carried a company chip instead of this panel — so
    // "which mounts clamp?" had a single answer to give and the rule read as a
    // property of the client's rail rather than of height-constrained mounts.
    // Both desktop rails are the no-scroll layout the clamp was written for
    // (CD-E3); both Company sheets scroll and keep the full text.
    for (const [rel, src] of [
      [RAIL, railSrc],
      [SIDEBAR, sidebarSrc],
    ] as const) {
      const mounts = [...src.matchAll(/<ClientProfilePanel[\s\S]*?\/>/g)].map((m) => flat(m[0]));
      expect(mounts, `${rel} mounts the panel on its rail and in its sheet`).toHaveLength(2);
      expect(
        mounts.filter((m) => /\bcompact\b/.test(m)),
        `${rel} clamps the height-constrained mount and only that one`,
      ).toHaveLength(1);
    }
    // Staff's client-context sheet is the SAME scrolling frame as the client's
    // own, so it shows the same full text. Clamping only there was a one-word
    // AF-3 parity break (audit, 6547959).
    expect(sidebarSrc).toContain("<ClientProfilePanel client={clientCtx.client} />");
    expect(sidebarSrc).not.toContain("<ClientProfilePanel client={clientCtx.client} compact />");
  });

  it("keeps the clamp on the text, not on the chips beside it", () => {
    // The row that carries team size, category and the social handles is the
    // other content-dependent block in this panel, and it used to answer the
    // no-scroll contract by refusing to wrap — which cost it more height than
    // wrapping ever did, because nothing shortened the category.
    expect(flat(panel)).toContain("flex flex-wrap items-center gap-1");
    expect(flat(panel)).not.toContain("flex-nowrap overflow-hidden");
    expect(flat(panel)).toContain("title={client.category}");
  });

  it("caps the category at the FIELD, so no mount cuts it mid-word", () => {
    // CD-L P3. The chip used to carry its own ceiling, and a different one per
    // mount, so the same category was cut at two different words in the two
    // views and cut mid-word in both ("Global Startup Pit…" on a client's own
    // profile). A chip that shortens what it is showing is the wrong end of the
    // problem: the value is capped where it is TYPED instead, at a length
    // measured to fit one line at the narrower mount, and the chip prints it
    // whole. Asked of the code, not the prose — this file explains at length
    // what it stopped doing.
    const panelCode = flat(code(PANEL));
    expect(panelCode).not.toContain("max-w-[9rem]");
    expect(panelCode).not.toContain("max-w-[14rem]");
    // One ceiling, shared by the input, the save action and the render — asked
    // by NAME, so the three cannot drift to different numbers.
    expect(panelCode).toContain("maxLength={CLIENT_CATEGORY_MAX_LENGTH}");
    expect(panelCode).toContain("clientCategoryLabel(client.category)");
    expect(flat(code("src/lib/actions/client-actions.ts"))).toContain(
      "patch.category = clampClientCategoryValue(input.category)",
    );
    // And the person typing is told why the input stops, rather than finding out.
    expect(panelCode).toContain("Keeps it short enough to fit your sidebar");
  });

  it("picks a cap that provably fits one line at the narrower mount", () => {
    // THE ARITHMETIC BEHIND THE NUMBER, so it can be re-derived rather than
    // trusted. The narrower of the two mounts is the staff sidebar: `w-64`
    // (256px) minus its 1px border, minus the body's `px-4`, minus the panel's
    // own `px-1`, leaves 215px for a chip on its own line. The chip spends 38px
    // of that on its 2px border, `px-2`, 14px mark and `gap-1.5`.
    //
    // The remaining 177px was measured in a browser at the app's own font
    // (Hanken Grotesk, `text-xs` = 12px): the widest title-case category of 28
    // characters renders at 176.7px and fits; at 29 it renders at 183.7px and
    // does not. So 28 is the largest cap that holds, and the client rail's
    // `w-72` has 32px more than the mount the number was measured at.
    expect(sidebarSrc).toContain("hidden w-64 shrink-0");
    expect(railSrc).toContain("hidden w-72 shrink-0");
    expect(flat(code(PANEL))).toContain(
      'const CHIP = "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-muted"',
    );
    expect(CLIENT_CATEGORY_MAX_LENGTH).toBe(28);
  });

  it("stores a hard ceiling and prints an ellipsis only for what predates it", () => {
    // Storage keeps characters, not typography: the save path truncates and
    // does NOT write an ellipsis into the client's own data.
    const long = "Global Startup Pitch Competition"; // 32 chars, the real one
    expect(clampClientCategoryValue(long)).toBe("Global Startup Pitch Competi");
    expect(clampClientCategoryValue(long)).not.toContain("…");
    expect(clampClientCategoryValue(long).length).toBeLessThanOrEqual(
      CLIENT_CATEGORY_MAX_LENGTH,
    );
    // Anything within the cap is stored and printed WHOLE — that is the ruling.
    for (const ok of ["Fintech", "Global Startup Competition", ""]) {
      expect(clampClientCategoryValue(ok)).toBe(ok);
      expect(clientCategoryLabel(ok)).toBe(ok);
      expect(clientCategoryLabel(ok)).not.toContain("…");
    }
    // A value already in Firestore predates the cap, so the chip shortens it
    // rather than wrapping. The ONLY case that shows an ellipsis mid-chip.
    expect(clientCategoryLabel(long)).toBe("Global Startup Pitch Compet…");
    expect(clientCategoryLabel(long).length).toBe(CLIENT_CATEGORY_MAX_LENGTH);
    // And the whole of it stays reachable, which is what `title` is for.
    expect(flat(code(PANEL))).toContain("title={client.category}");
  });

  it("draws every chip in the row at one size", () => {
    // The tag glyph was h-4 with no shrink-0 in a nowrap row, so it collapsed
    // to a few pixels beside a three-line label while the platform marks next
    // to it stayed 14px. One geometry, one icon size, applied by name.
    const chips = [...panel.matchAll(/className=\{?cn\(\s*CHIP/g)];
    expect(chips.length).toBeGreaterThanOrEqual(3);
    expect(flat(panel)).toContain(
      'const CHIP_ICON = "h-3.5 w-3.5 shrink-0 text-muted-2"',
    );
    // No chip may re-declare its own padding or icon box.
    const row = panel.slice(panel.indexOf("{hasMeta ?"), panel.indexOf("{/* Free text"));
    expect(row).not.toContain("px-2.5 py-1");
    expect(row).not.toContain("h-4 w-4");
  });

  it("still renders the description — clamped, not removed", () => {
    // An earlier comment claimed compact dropped it entirely. Hiding a client's
    // own profile text is not a fix for it being long.
    expect(flat(panel)).toContain("{client.description || client.brief}");
    expect(flat(panel)).not.toContain("!compact && (client.description");
  });
});

/* ── CD-L P1/P2: what the Brand Profile sheet is for ─────────────────────── */

describe("the Brand Profile sheet asks for three things", () => {
  const flat = (t: string) => t.replace(/\s+/g, " ");
  const PANEL = "src/components/client-profile-panel.tsx";
  const ACTIONS = "src/lib/actions/client-actions.ts";
  const GRID = "src/components/clients-grid.tsx";
  /** Just the modal, so a field the PANEL still edits cannot answer for it. */
  const modal = (() => {
    const src = code(PANEL);
    const from = src.indexOf("function BrandProfileModal");
    expect(from, "BrandProfileModal is gone").toBeGreaterThan(-1);
    return flat(src.slice(from, src.indexOf("export function ClientProfilePanel", from)));
  })();

  it("offers Contact Email, Website and About, and nothing else", () => {
    for (const label of ["Contact Email", "Website", "About"]) {
      expect(modal, `the sheet no longer asks for ${label}`).toContain(`>${label}<`);
    }
    // The three that left, each for its own reason (see the component's note).
    for (const gone of ["Brand Voice", "Industry", "Meeting Domain"]) {
      expect(modal, `${gone} is still in the sheet`).not.toContain(`>${gone}<`);
    }
    // Exactly three inputs, so a fourth cannot be added without answering here.
    expect((modal.match(/<label className=\{labelCls\}>/g) ?? [])).toHaveLength(3);
  });

  it("writes only those three, so the fields it dropped keep their stored values", () => {
    // The form object IS the action payload (`updateClientProfileAction(client.id,
    // form)`), so the state shape is the write contract. Brand Voice is a
    // DOCUMENT and the sheet must not keep a second copy of it.
    expect(modal).toContain(
      "useState({ contactEmail: client.contactEmail ?? \"\", website: client.website ?? \"\", description: client.description ?? \"\", })",
    );
    for (const gone of ["brandVoice", "industry", "domainsCsv"]) {
      expect(modal, `the sheet still writes ${gone}`).not.toContain(gone);
    }
  });

  it("stops the ACTION accepting them too, not just the form", () => {
    // A field a client-reachable action still takes is a field a crafted
    // request still writes, whatever the form on screen offers — and
    // `domainsCsv` decided which Fireflies transcripts auto-assign to a client,
    // which is a routing control with somebody else's meetings behind it.
    const actions = flat(code(ACTIONS));
    const fn = actions.slice(
      actions.indexOf("export async function updateClientProfileAction"),
      actions.indexOf("export async function updateClientAction"),
    );
    expect(fn.length, "updateClientProfileAction is gone").toBeGreaterThan(100);
    for (const gone of ["brandVoice", "industry", "domainsCsv"]) {
      expect(fn, `updateClientProfileAction still accepts ${gone}`).not.toContain(gone);
    }
    // The three it does keep, plus the two the panel's own form sends.
    for (const kept of ["contactEmail", "website", "description", "category", "socialLinks"]) {
      expect(fn).toContain(kept);
    }
  });

  it("moves the meeting domain to the staff dialog, with a line saying what it does", () => {
    // It was already offered to staff there; what it lacked was the sentence
    // that says why an ops person would touch it.
    const grid = flat(code(GRID));
    expect(grid).toContain("Meeting domains");
    expect(grid).toContain("Meetings from this email domain auto-assign to this client");
    // And it still writes through the staff-gated action.
    expect(grid).toContain("domainsCsv: form.domains");
  });

  it("defaults an unset contact email to the account owner, resolved on the server", () => {
    // The join is users→clientId, and this panel is a "use client" module — so
    // the answer is fetched, not shipped: nothing about the user collection may
    // cross into the RSC payload just to prefill an input.
    const data = flat(code("src/lib/data.ts"));
    expect(data).toContain("export async function getClientOwnerEmail(clientId: string)");
    expect(data).toContain('.where("clientId", "==", clientId)');
    expect(data).toContain('.where("role", "==", "CLIENT_USER")');
    const actions = flat(code(ACTIONS));
    expect(actions).toContain("export async function clientOwnerEmailAction(clientId: string)");
    // Same fence as the write path: staff, or this client's own user.
    expect(actions).toContain(
      'if (!isStaff && !(user.role === "CLIENT_USER" && user.clientId === clientId)) { return { email: "" }; }',
    );
    // Asked only when the field is empty, and it PREFILLS rather than saves.
    expect(modal).toContain("if (client.contactEmail) return;");
    expect(modal).toContain("void clientOwnerEmailAction(client.id)");
  });

  it("leaves ONE editor for the category, and it is the one the chip renders", () => {
    // CD-L P2. The chip prints `client.category`; the pencil's inline form
    // writes it. The sheet's "Industry" box read as a second editor for the same
    // fact and is gone, so there is no longer a form in this panel that can
    // change what the tag says without being the tag's own field.
    const panelCode = flat(code(PANEL));
    const inputs = [...panelCode.matchAll(/value=\{category\}/g)];
    expect(inputs, "more than one category editor in the panel").toHaveLength(1);
    expect(panelCode).toContain("setCategory(e.target.value)");
    expect(panelCode).toContain("{clientCategoryLabel(client.category)}");
    // `industry` is a staff/ops field now: the copilot and the intel pipeline
    // still read it, and the Clients page Edit dialog still sets it.
    expect(panelCode).not.toContain("industry");
    expect(flat(code(GRID))).toContain(">Industry<");
  });
});
