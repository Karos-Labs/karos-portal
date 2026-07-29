import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Icon } from "@/components/icon";
import { LogoutButton } from "@/components/logout-button";
import { AutoRefresh } from "@/components/auto-refresh";

export default async function PendingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.disabled) redirect("/dashboard");

  const requested =
    user.requestedRole === "CLIENT_USER"
      ? `as a client${user.requestedClientName ? ` for ${user.requestedClientName}` : ""}`
      : user.requestedRole === "KAROS_EMPLOYEE"
        ? "as agency staff"
        : "";

  const supportEmail = process.env.ADMIN_EMAIL ?? "hello@karoslabs.com";

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      {/* The redirect above already fires the moment the account is enabled —
          polling is all that was missing, so approval lands the user in the
          workspace without a manual reload (QA F115). */}
      <AutoRefresh intervalMs={15000} />
      <div className="w-full max-w-md animate-fade-up text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-md bg-warning/10">
          <Icon name="Clock" className="h-6 w-6 text-warning" />
        </div>
        <h1 className="text-xl font-semibold">Awaiting approval</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          Your account <span className="text-foreground">{user.email}</span> is registered
          {requested && ` ${requested}`}. An agency admin needs to approve it and confirm your role
          before you can access the workspace.
        </p>
        <p className="mx-auto mt-3 max-w-sm text-xs text-muted">
          This usually happens within one business day. We&rsquo;ll email you the moment it does,
          and this page will let you in on its own — you can leave it open.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <a
            href={`mailto:${supportEmail}?subject=${encodeURIComponent("Access request pending")}`}
            className="rounded-md border border-border px-3 py-2 text-sm text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            Email your Karos team
          </a>
          <LogoutButton />
        </div>
      </div>
    </div>
  );
}
