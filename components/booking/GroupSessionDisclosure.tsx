import { cn } from "@/utils/tailwind";

/** #1852 decision 4 — the wording the owner locked; no consent record rides on it. */
export const GROUP_SESSION_DISCLOSURE =
  "This is a group session; other participants may attend from other organisations or independently.";

/**
 * Shown wherever someone books or registers for a webinar or class. One
 * session can seat B2C attendees and members of several organisations, and
 * the person should know that before they join.
 */
export function GroupSessionDisclosure({
  className,
}: Readonly<{ className?: string }>) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {GROUP_SESSION_DISCLOSURE}
    </p>
  );
}
