import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import { ContactUsButton } from "@/components/contact-us-modal";
import type { ActionItemNotification, AgentReviewNotification } from "@/lib/types";

interface Props {
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
}

export function AppHeader({ actionItems, reviewJobs }: Props) {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-end gap-1 border-b border-border bg-surface/80 px-4 py-2 backdrop-blur-sm md:px-8">
      <ContactUsButton />
      <ThemeToggle />
      <NotificationBell actionItems={actionItems} reviewJobs={reviewJobs} />
    </header>
  );
}
