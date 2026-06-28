import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Icon } from "@/components/icon";
import { LogoutButton } from "@/components/logout-button";

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

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md animate-fade-up text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-warning/10">
          <Icon name="Clock" className="h-6 w-6 text-warning" />
        </div>
        <h1 className="text-xl font-semibold">Awaiting approval</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          Your account <span className="text-foreground">{user.email}</span> is registered
          {requested && ` ${requested}`}. An agency admin needs to approve it and confirm your role
          before you can access the workspace.
        </p>
        <div className="mt-6">
          <LogoutButton />
        </div>
      </div>
    </div>
  );
}
