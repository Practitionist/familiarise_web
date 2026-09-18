import { cn } from "@/utils/tailwind";

/**
 * Fills the personal-dashboard content column under the context bar (and above
 * the mobile tab bar). Same height contract as MessagesTab: the explicit
 * `.h-dashboard-fill` budget, not `min-h-full` + `flex-1` — flex-grow cannot constrain children
 * when the parent's height is indefinite, which is what left the slot calendar
 * capped at 500px with empty white space below.
 *
 * `overflow-hidden` keeps a single inner scrollport (the calendar grid). Do not
 * put `overflow-hidden` on `PersonalDashboardShell`'s right panel — that creates
 * a second scrollport and breaks `position: sticky` for editor chrome.
 */
export function DashboardViewportFill({
  children,
  className,
}: Readonly<{
  children: React.ReactNode;
  className?: string;
}>) {
  return (
    <div
      className={cn(
        "-m-4 flex h-dashboard-fill flex-col overflow-hidden p-4 sm:-m-6 sm:p-6 lg:-m-8 lg:p-8",
        className,
      )}
    >
      {children}
    </div>
  );
}
