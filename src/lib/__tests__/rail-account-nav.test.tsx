import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Account Center group folds off its own route (Albert, 2026-09-11: "this
 * should be collapsable"). Five section rows on every page made the rail read
 * as eight peers; now the parent row is the group everywhere, and its sections
 * show only while the reader is in Account Center. Rendered, not scanned: the
 * fold is a condition on the pathname.
 */

let pathname = "/clients/c1";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { ACCOUNT_CENTER_SECTIONS, ClientRailAccountNav } from "@/components/client-rail-account-nav";

function rail(at: string): string {
  pathname = at;
  return renderToStaticMarkup(<ClientRailAccountNav home="/clients/c1" />);
}

describe("the Account Center group in the rail", () => {
  it("folds its sections away off its route", () => {
    const html = rail("/clients/c1");
    expect(html).toContain("Account Center");
    expect(html).not.toContain("?tab=");
    expect(html).not.toContain('aria-current="page"');
  });

  it("opens on its route, with every section and the parent marked current", () => {
    const html = rail("/clients/c1/settings");
    for (const section of ACCOUNT_CENTER_SECTIONS) {
      expect(html).toContain(`href="/clients/c1/settings?tab=${section.id}"`);
    }
    expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
  });

  it("is one control: the row navigates and carries no toggle", () => {
    const html = rail("/clients/c1");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain('href="/clients/c1/settings"');
  });
});
