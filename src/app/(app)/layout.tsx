import { requireUser } from "@/lib/auth";
import { listUsers } from "@/lib/data";
import { Sidebar } from "@/components/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Surface a count of pending registrations to admins in the sidebar.
  let pendingCount = 0;
  if (user.role === "admin") {
    const users = await listUsers();
    pendingCount = users.filter((u) => u.disabled && !u.approvedAt).length;
  }
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar user={user} pendingCount={pendingCount} />
      <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto w-full max-w-6xl animate-fade-up">{children}</div>
      </main>
    </div>
  );
}
