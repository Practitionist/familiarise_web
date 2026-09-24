"use client";

/**
 * Staff dashboard chrome. Sits inside the server `layout.tsx`, which runs the
 * access guard and resolves the identity props server-side.
 *
 * Thin caller over the shared `BackofficeShell` (Batch C2) — the staff tree
 * is the `tree="staff"` parameterization. The nav is built for STAFF even
 * when an admin is viewing this tree: the reason to open it as an admin is
 * to see what a staff member sees. Settings lives in the bottom user chip
 * rather than the nav, matching the admin tree.
 */

import type { OperatorDashboardShellProps } from "@/components/dashboard/OperatorDashboardShell";
import { BackofficeShell } from "@/components/dashboard/BackofficeShell";

export function StaffShell({
  staffId,
  userName,
  userEmail,
  userImage,
  children,
}: { staffId: string } & Pick<
  OperatorDashboardShellProps,
  "userName" | "userEmail" | "userImage" | "children"
>) {
  return (
    <BackofficeShell
      tree="staff"
      basePath={`/dashboard/staff/${staffId}`}
      userName={userName}
      userEmail={userEmail}
      userImage={userImage}
    >
      {children}
    </BackofficeShell>
  );
}
