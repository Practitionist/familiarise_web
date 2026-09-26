"use client";

/**
 * Admin dashboard chrome. Sits inside the server `layout.tsx`, which runs the
 * requireUserRole("ADMIN") guard and resolves the identity props server-side.
 *
 * Thin caller over the shared `BackofficeShell` (Batch C2) — the admin tree
 * is the `tree="admin"` parameterization, so it cannot drift from the staff
 * tree. Settings lives in the bottom user chip rather than the nav: it's the
 * operator's own profile page, not a platform surface.
 */

import type { OperatorDashboardShellProps } from "@/components/dashboard/OperatorDashboardShell";
import { BackofficeShell } from "@/components/dashboard/BackofficeShell";

export function AdminShell({
  userName,
  userEmail,
  userImage,
  children,
  // #863 — the TDS surface is flag-gated (ENABLE_TDS_ADMIN_VIEW). The server
  // layout reads the flag and passes it, so the nav item only appears when the
  // page would actually resolve (no link that 404s).
  showTds = false,
}: Pick<
  OperatorDashboardShellProps,
  "userName" | "userEmail" | "userImage" | "children"
> & { showTds?: boolean }) {
  return (
    <BackofficeShell
      tree="admin"
      basePath="/dashboard/admin"
      userName={userName}
      userEmail={userEmail}
      userImage={userImage}
      showTds={showTds}
    >
      {children}
    </BackofficeShell>
  );
}
