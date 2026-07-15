import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import { ContactUsButton } from "@/components/contact-us-modal";
import type { ActionItemNotification, AgentReviewNotification, ClientTask } from "@/lib/types";

interface Props {
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
  taskAlerts: ClientTask[];
  userName: string;
  userEmail: string;
}

export function AppHeader({ actionItems, reviewJobs, taskAlerts, userName, userEmail }: Props) {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-end gap-1 border-b border-border bg-background/80 px-4 py-2 backdrop-blur-sm md:px-8">
      <ContactUsButton userName={userName} userEmail={userEmail} />
      <ThemeToggle />
      <NotificationBell actionItems={actionItems} reviewJobs={reviewJobs} taskAlerts={taskAlerts} />
    </header>
  );
}
