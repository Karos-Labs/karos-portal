import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

/**
 * Same centered, rail-less shell as (onboarding)/layout.tsx, so the simulation
 * looks exactly like what a new client sees. Its own group because that
 * layout sends every staff account straight to /dashboard.
 */
export default async function OnboardingPreviewLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // The real admin only: a staff member "viewing as" a client is that client here.
  if (user.role !== "KAROS_ADMIN" || user.impersonatedBy) redirect("/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="@container w-full max-w-2xl">{children}</div>
    </div>
  );
}
