import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { needsOnboarding } from "@/lib/onboarding";

/** Distraction-free, centered shell for the onboarding wizard — no sidebar/rail. */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.disabled) redirect("/pending");
  // Staff impersonating a client never run that client's onboarding themselves.
  if (user.impersonatedBy) redirect("/dashboard");
  if (!needsOnboarding(user)) redirect("/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      {/* @container: the wizard embeds IntegrationsTab, whose card grid measures
          its own column rather than the window (QA F5). */}
      <div className="@container w-full max-w-2xl">{children}</div>
    </div>
  );
}
