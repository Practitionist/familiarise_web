import { SupportInboxShell } from "@/components/dashboard/backoffice/support/SupportInboxShell";

/**
 * #1527 — the Support inbox frame: the list persists across case navigations
 * (a layout does not remount), and each case is its own route below it. The
 * pages gate access; a layout does not re-run on client navigation.
 */
export default function SupportInboxLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <SupportInboxShell>{children}</SupportInboxShell>;
}
