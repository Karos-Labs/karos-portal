import { requireUser } from "@/lib/auth";
import { adminAuth } from "@/lib/firebase/admin";
import { getClient } from "@/lib/data";
import { SettingsForm } from "@/components/settings-form";

export const metadata = { title: "Settings · Karos CMO" };

export default async function SettingsPage() {
  const user = await requireUser();

  // Fetch the Firebase Auth record to discover which sign-in providers are linked.
  const firebaseUser = await adminAuth().getUser(user.uid);
  const providers = firebaseUser.providerData.map((p) => p.providerId);

  // Resolve the company name for CLIENT_USER accounts.
  let clientName: string | null = null;
  if (user.clientId) {
    const client = await getClient(user.clientId);
    clientName = client?.name ?? null;
  }

  return (
    <SettingsForm user={user} providers={providers} clientName={clientName} />
  );
}
