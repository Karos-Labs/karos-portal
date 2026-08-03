import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { adminAuth } from "@/lib/firebase/admin";
import { getClient } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { SettingsTabs, type SettingsTab } from "@/components/settings-tabs";
import { AccountProfilePanel, AccountSecurityPanel } from "@/components/settings-form";
import { ACCOUNT_TABS, accountSettingsHref } from "@/lib/account-settings-tabs";

export const metadata = { title: "Settings · Karos CMO" };

/**
 * The account settings page — for a viewer who has no client (AF-2).
 *
 * It used to be everybody's, reached from an "Account settings" entry on the
 * client settings row, and it rendered a second tab strip of its own. For a
 * client that was a hop out of their settings page into another settings page.
 * Their two account panels are tabs on /clients/<id>/settings now, so this
 * route REDIRECTS them there rather than 404ing or rendering a duplicate — the
 * old link is in histories, bookmarks and at least one support thread, and it
 * still has to land somewhere right.
 *
 * What is left is the staff case, which is not a duplicate of anything: staff
 * have no single client, so there is no client settings page that could hold
 * their account. Same two panels, same tab strip, same `?tab=` ids as the
 * client surface — one settings surface per viewer, not one per app.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  const { tab: initialTab } = await searchParams;

  // A client whose client document resolves has their own settings page; carry
  // the tab so a deep link keeps naming the panel it named. A CLIENT_USER with
  // no clientId falls through to the staff shell and has no such page, so this
  // route stays theirs.
  if (user.role === "CLIENT_USER") {
    const href = accountSettingsHref(user.clientId, initialTab);
    if (href) redirect(href);
  }

  // Fetch the Firebase Auth record to discover which sign-in providers are linked.
  const firebaseUser = await adminAuth().getUser(user.uid);
  const providers = firebaseUser.providerData.map((p) => p.providerId);

  // Resolve the company name for CLIENT_USER accounts.
  let clientName: string | null = null;
  if (user.clientId) {
    const client = await getClient(user.clientId);
    clientName = client?.name ?? null;
  }

  const tabs: SettingsTab[] = [
    {
      id: ACCOUNT_TABS.profile,
      label: "Profile information",
      icon: "User",
      content: <AccountProfilePanel user={user} clientName={clientName} />,
    },
    {
      id: ACCOUNT_TABS.security,
      label: "Account security",
      icon: "Shield",
      content: <AccountSecurityPanel providers={providers} />,
    },
  ];

  return (
    <>
      <PageHeader title="Settings" description="Your profile and how you sign in." />
      <SettingsTabs tabs={tabs} initialTab={initialTab} />
    </>
  );
}
