import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TABS,
  accountSettingsHref,
  isAccountTab,
} from "@/lib/account-settings-tabs";

/**
 * The redirect that keeps AF-2's old route working.
 *
 * /settings stopped being a client's account page and became a redirect to the
 * tabs that replaced it. Everything that can go wrong with that is a silent
 * landing rather than an error — a dropped tab, an invented one, or a client id
 * pasted into a path unescaped — so each is asked for by name below.
 */

describe("which tab a redirect carries", () => {
  it("carries an account tab through", () => {
    expect(accountSettingsHref("c1", ACCOUNT_TABS.security)).toBe(
      "/clients/c1/settings?tab=security",
    );
    expect(accountSettingsHref("c1", ACCOUNT_TABS.profile)).toBe(
      "/clients/c1/settings?tab=account",
    );
  });

  it("defaults to the profile panel when no tab was named", () => {
    // Not "no ?tab=": the destination page's first tab is Channels or Credits
    // depending on role, so a bare redirect would land a client somewhere that
    // has nothing to do with the account page they asked for.
    expect(accountSettingsHref("c1")).toBe("/clients/c1/settings?tab=account");
    expect(accountSettingsHref("c1", undefined)).toBe("/clients/c1/settings?tab=account");
  });

  it("does not honour a tab that is not an account panel", () => {
    // A stale `?tab=channels` on /settings names a tab /settings never had.
    // Forwarding it would turn a bookmark for "my password" into the channels
    // page; the profile panel is the honest answer to "your account".
    expect(accountSettingsHref("c1", "channels")).toBe("/clients/c1/settings?tab=account");
    expect(accountSettingsHref("c1", "credits")).toBe("/clients/c1/settings?tab=account");
    expect(accountSettingsHref("c1", "")).toBe("/clients/c1/settings?tab=account");
  });

  it("recognises exactly the two panels and nothing else", () => {
    expect(isAccountTab(ACCOUNT_TABS.profile)).toBe(true);
    expect(isAccountTab(ACCOUNT_TABS.security)).toBe(true);
    expect(isAccountTab("profile")).toBe(false); // the CLIENT's company profile tab
    expect(isAccountTab(undefined)).toBe(false);
  });
});

describe("when there is no client settings page to redirect to", () => {
  it("returns null rather than a path with a hole in it", () => {
    // Staff, and the CLIENT_USER whose client document did not resolve. Both
    // keep /settings; a `/clients//settings` would 404 either of them.
    expect(accountSettingsHref(null)).toBeNull();
    expect(accountSettingsHref(undefined)).toBeNull();
    expect(accountSettingsHref("")).toBeNull();
  });
});

describe("the client id reaches the path as a path segment", () => {
  it("escapes it", () => {
    // Firestore ids are URL-safe in practice, so this is defence rather than a
    // live defect — but the value is interpolated into a path, and an id
    // carrying a slash would otherwise redirect somewhere else entirely.
    expect(accountSettingsHref("a/b")).toBe("/clients/a%2Fb/settings?tab=account");
    expect(accountSettingsHref("a?b")).toBe("/clients/a%3Fb/settings?tab=account");
  });
});

describe("the two ids are distinct and stable", () => {
  it("does not collide with the client's own Profile tab", () => {
    // /clients/<id>/settings already has `profile` — the ClientEditor, i.e. the
    // COMPANY's profile. Staff-only, so the two never render together, but the
    // ids must differ anyway: `?tab=profile` has to keep meaning one thing.
    expect(ACCOUNT_TABS.profile).not.toBe("profile");
    expect(ACCOUNT_TABS.profile).not.toBe(ACCOUNT_TABS.security);
  });
});
