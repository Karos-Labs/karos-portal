/**
 * WHERE A VIEWER'S ACCOUNT SETTINGS LIVE (AF-2).
 *
 * They used to live behind a hop: the client settings page carried an "Account
 * settings" entry that navigated to /settings, a second page with a second tab
 * strip of its own. Two strips, two pages, one subject. "Profile information +
 * account security live as TABS inside the normal Settings page. No separate
 * account settings page behind a button hop. It's just supposed to be
 * seamless."
 *
 * So there is now ONE settings surface per viewer, and which one it is depends
 * on whether the viewer has a client:
 *
 *  · A CLIENT_USER has exactly one, and their settings page is
 *    /clients/<id>/settings — so the two account panels are tabs on it, beside
 *    Channels and Credits, and /settings redirects there carrying the tab.
 *  · Staff have no single client, so /settings IS their settings page and
 *    renders the same two panels through the same tab strip.
 *
 * Both surfaces read these ids, and the redirect maps between them, so they are
 * declared once here rather than spelled out at each end — a redirect whose
 * `?tab=` names a tab the destination does not have lands on the fallback tab
 * silently, which is the failure this module exists to make impossible.
 */

/** The two account panels, by `?tab=` id. */
export const ACCOUNT_TABS = {
  /**
   * Not "profile": the client settings page already has a Profile tab, and it
   * is the CLIENT's company profile (ClientEditor). That one is staff-only and
   * so never renders beside this one — but two tabs a role away from sharing an
   * id is not a distinction worth keeping in one's head.
   */
  profile: "account",
  security: "security",
} as const;

export type AccountTabId = (typeof ACCOUNT_TABS)[keyof typeof ACCOUNT_TABS];

/** Is this `?tab=` value one of the account panels? */
export function isAccountTab(tab: string | undefined): tab is AccountTabId {
  return tab === ACCOUNT_TABS.profile || tab === ACCOUNT_TABS.security;
}

/**
 * The settings URL that owns this viewer's account panels, or `null` when
 * /settings itself does — i.e. when there is no client to send them to.
 *
 * `tab` is carried through when it names an account panel, and dropped when it
 * does not: /settings has only these two, so a stale `?tab=channels` in
 * somebody's history is not an instruction this function should honour by
 * inventing a destination tab.
 */
export function accountSettingsHref(
  clientId: string | null | undefined,
  tab?: string,
): string | null {
  if (!clientId) return null;
  const base = `/clients/${encodeURIComponent(clientId)}/settings`;
  return isAccountTab(tab) ? `${base}?tab=${tab}` : `${base}?tab=${ACCOUNT_TABS.profile}`;
}
